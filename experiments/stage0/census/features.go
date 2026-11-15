package main

import (
	"fmt"
	"go/token"
	"go/types"
	"sort"
	"strings"

	"golang.org/x/tools/go/ssa"
)

// Census accumulates feature counts over the static set (every reachable
// function, every instruction) and the dynamic set (executed blocks only).
type Census struct {
	fset    *token.FileSet
	fileKey map[string]string
	Static  *Tally
	Dynamic *Tally
	// StaticFilter selects the functions of the static set (VTA-reachable).
	StaticFilter func(*Fn) bool
}

// Tally is one set's counts.
type Tally struct {
	// feature -> instruction count
	Features map[string]int `json:"features"`
	// feature -> functions using it
	FeatureFns map[string]int `json:"featureFns"`
	// feature -> "fn (file:line)" sites, for rare features
	Sites map[string][]string `json:"sites"`
	// callee package -> calls (static callees, any caller)
	CallsByPkg map[string]int `json:"callsByPkg"`
	// std/third-party function called directly from tsgo code -> calls
	Boundary map[string]int `json:"boundary"`
	// boundary callee -> tsgo callers (deduplicated, package initializers omitted)
	BoundaryCallers map[string][]string `json:"boundaryCallers"`
	// reflect function -> caller packages
	Reflect map[string]map[string]int `json:"reflect"`
	// package -> float instructions
	FloatByPkg map[string]int `json:"floatByPkg"`
	// map type -> instructions (make, lookup, update, range)
	MapTypes map[string]int `json:"mapTypes"`
	// integer binop "op/width" -> count
	IntOps map[string]int `json:"intOps"`
	// interface method invoked (Iface.Method) -> call sites
	Invokes map[string]int `json:"invokes"`
	// concrete type converted to an interface (MakeInterface) -> sites
	IfaceTypes map[string]int `json:"ifaceTypes"`
	// instructions by SSA opcode
	Opcodes map[string]int `json:"opcodes"`
}

func newTally() *Tally {
	return &Tally{
		Features: map[string]int{}, FeatureFns: map[string]int{}, Sites: map[string][]string{},
		CallsByPkg: map[string]int{}, Boundary: map[string]int{}, BoundaryCallers: map[string][]string{}, Reflect: map[string]map[string]int{},
		FloatByPkg: map[string]int{}, Invokes: map[string]int{}, IfaceTypes: map[string]int{}, MapTypes: map[string]int{}, IntOps: map[string]int{}, Opcodes: map[string]int{},
	}
}

func newCensus(fset *token.FileSet, fileKey map[string]string) *Census {
	return &Census{fset: fset, fileKey: fileKey, Static: newTally(), Dynamic: newTally()}
}

// Features whose sites are listed in full.
var siteFeatures = map[string]bool{
	"go": true, "select": true, "chan.make": true, "chan.send": true, "chan.recv": true, "chan.close": true,
	"recover": true, "unsafe.convert": true, "unsafe.String": true, "unsafe.StringData": true,
	"unsafe.Slice": true, "unsafe.SliceData": true, "unsafe.Add": true, "complex": true,
	"iter.Pull": true, "sync.Pool": true, "sync.Map": true, "sync.Cond": true, "finalizer": true,
	"regexp": true, "defer.loop": true, "panic": true, "unique": true, "weak": true, "reflect": true,
}

func (c *Census) function(r *Fn) {
	f := r.fn
	r.Features = map[string]int{}
	used := map[string]bool{}
	usedDyn := map[string]bool{}
	stat := c.StaticFilter == nil || c.StaticFilter(r)
	for bi, b := range f.Blocks {
		dyn := r.execBlock != nil && r.execBlock[bi]
		for _, in := range b.Instrs {
			scratch := c.Static
			if !stat {
				scratch = newTally()
			}
			feats := c.instr(r, in, scratch)
			for _, ft := range feats {
				r.Features[ft]++
				if stat {
					c.Static.Features[ft]++
					used[ft] = true
				}
			}
			if dyn {
				c.instr(r, in, c.Dynamic)
				for _, ft := range feats {
					c.Dynamic.Features[ft]++
					usedDyn[ft] = true
				}
			}
			for _, ft := range feats {
				if siteFeatures[ft] {
					site := fmt.Sprintf("%s (%s)", f.String(), c.where(in.Pos(), f))
					if stat {
						c.Static.Sites[ft] = append(c.Static.Sites[ft], site)
					}
					if dyn {
						c.Dynamic.Sites[ft] = append(c.Dynamic.Sites[ft], site)
					}
				}
			}
		}
	}
	for ft := range used {
		c.Static.FeatureFns[ft]++
	}
	for ft := range usedDyn {
		c.Dynamic.FeatureFns[ft]++
	}
	if len(r.Features) == 0 {
		r.Features = nil
	}
}

func (c *Census) where(pos token.Pos, f *ssa.Function) string {
	if !pos.IsValid() {
		pos = f.Pos()
	}
	p := c.fset.Position(pos)
	if !p.IsValid() {
		return "?"
	}
	return fmt.Sprintf("%s:%d", c.fileKey[p.Filename], p.Line)
}

func opcode(in ssa.Instruction) string {
	s := fmt.Sprintf("%T", in)
	return strings.TrimPrefix(s, "*ssa.")
}

// instr returns the features of one instruction and records the
// set-specific tables in t.
func (c *Census) instr(r *Fn, in ssa.Instruction, t *Tally) []string {
	var fs []string
	add := func(s ...string) { fs = append(fs, s...) }
	t.Opcodes[opcode(in)]++
	if v, ok := in.(ssa.Value); ok {
		if isComplex(v.Type()) {
			add("complex")
		}
		if isFloat(v.Type()) {
			t.FloatByPkg[r.Pkg]++
			add("float")
		}
	}
	switch v := in.(type) {
	case *ssa.Go:
		add("go")
	case *ssa.Defer:
		add("defer")
		if v.DeferStack != nil {
			add("defer.loop")
		}
	case *ssa.RunDefers:
		add("rundefers")
	case *ssa.Panic:
		add("panic")
	case *ssa.Select:
		add("select")
		if !v.Blocking {
			add("select.nonblocking")
		}
	case *ssa.Send:
		add("chan.send")
	case *ssa.MakeChan:
		add("chan.make")
	case *ssa.UnOp:
		if v.Op == token.ARROW {
			add("chan.recv")
		}
	case *ssa.MakeClosure:
		add("closure")
		if _, ok := v.Fn.(*ssa.Function); ok && strings.Contains(v.Fn.(*ssa.Function).Synthetic, "bound") {
			add("closure.bound")
		}
	case *ssa.MakeInterface:
		add("iface.make")
		t.IfaceTypes[typeName(v.X.Type())]++
	case *ssa.TypeAssert:
		if v.CommaOk {
			add("typeassert.commaok")
		}
		if types.IsInterface(v.AssertedType) {
			add("typeassert.toiface")
		} else {
			add("typeassert.concrete")
		}
	case *ssa.MakeMap:
		add("map.make", "map.make."+keyCat(v.Type()))
		t.MapTypes[typeName(v.Type())]++
	case *ssa.Lookup:
		if isMap(v.X.Type()) {
			add("map.lookup", "map.lookup."+keyCat(v.X.Type()))
			t.MapTypes[typeName(v.X.Type())]++
		} else {
			add("string.index")
		}
	case *ssa.Index:
		if isString(v.X.Type()) {
			add("string.index")
		} else {
			add("array.index.value") // indexing an array value (copy semantics)
		}
	case *ssa.MapUpdate:
		add("map.update", "map.update."+keyCat(v.Map.Type()))
		t.MapTypes[typeName(v.Map.Type())]++
	case *ssa.Range:
		if isMap(v.X.Type()) {
			add("map.range", "map.range."+keyCat(v.X.Type()))
			t.MapTypes[typeName(v.X.Type())]++
		} else {
			add("string.range")
		}
	case *ssa.Slice:
		if isString(v.X.Type()) {
			add("string.slice")
		} else {
			add("slice.slice")
		}
	case *ssa.MakeSlice:
		add("slice.make")
		if isSliceOfSlice(v.Type()) {
			add("slice.ofslice")
		}
	case *ssa.Convert:
		add(convertFeats(v)...)
	case *ssa.SliceToArrayPointer:
		add("slice.toarrayptr")
	case *ssa.BinOp:
		xt := v.X.Type()
		switch {
		case isString(xt) && v.Op == token.ADD:
			add("string.concat")
		case isString(xt):
			add("string.compare")
		case isInteger(xt):
			w := intWidth(xt)
			t.IntOps[fmt.Sprintf("%s/%d", v.Op, w)]++
			if w == 64 {
				add("int64.binop")
				switch v.Op {
				case token.MUL, token.QUO, token.REM:
					add("int64.muldiv")
				}
			}
		}
	case *ssa.Alloc:
		if v.Heap {
			add("alloc.heap")
		} else {
			add("alloc.local")
		}
	}
	if call, ok := in.(ssa.CallInstruction); ok {
		add(c.call(r, call.Common(), t)...)
	}
	for _, op := range in.Operands(nil) {
		if op == nil || *op == nil {
			continue
		}
		if g, ok := (*op).(*ssa.Global); ok && g.Pkg != nil {
			switch g.Pkg.Pkg.Path() {
			case "unicode":
				add("unicode.table")
			}
		}
	}
	return fs
}

func (c *Census) call(r *Fn, cc *ssa.CallCommon, t *Tally) []string {
	var fs []string
	if cc.IsInvoke() {
		t.Invokes[typeName(cc.Value.Type())+"."+cc.Method.Name()]++
		return []string{"call.invoke"}
	}
	if b, ok := cc.Value.(*ssa.Builtin); ok {
		name := b.Name()
		switch name {
		case "recover":
			fs = append(fs, "recover")
		case "close":
			fs = append(fs, "chan.close")
		case "String", "StringData", "Slice", "SliceData", "Add":
			fs = append(fs, "unsafe."+name)
		default:
			fs = append(fs, "builtin."+name)
		}
		return fs
	}
	callee := cc.StaticCallee()
	if callee == nil {
		return []string{"call.dynamic"}
	}
	fs = append(fs, "call.static")
	pkg := pkgOf(callee)
	t.CallsByPkg[pkg]++
	name := calleeName(callee)
	if group(r.Pkg) == "tsgo" && group(pkg) != "tsgo" {
		t.Boundary[name]++
		if r.Kind != "init" && !strings.HasSuffix(name, ".init") {
			if cs := t.BoundaryCallers[name]; len(cs) < 30 && (len(cs) == 0 || cs[len(cs)-1] != r.Name) {
				t.BoundaryCallers[name] = append(cs, r.Name)
			}
		}
	}
	switch {
	case pkg == "reflect":
		m := t.Reflect[name]
		if m == nil {
			m = map[string]int{}
			t.Reflect[name] = m
		}
		m[r.Pkg]++
		fs = append(fs, "reflect")
	case pkg == "sync":
		fs = append(fs, "sync."+syncType(name))
	case pkg == "sync/atomic":
		fs = append(fs, "atomic")
	case pkg == "iter" && strings.HasPrefix(callee.Name(), "Pull"):
		fs = append(fs, "iter.Pull")
	case pkg == "regexp":
		fs = append(fs, "regexp")
	case name == "runtime.SetFinalizer" || name == "runtime.AddCleanup":
		fs = append(fs, "finalizer")
	case pkg == "unique":
		fs = append(fs, "unique")
	case pkg == "weak":
		fs = append(fs, "weak")
	case pkg == "strings" && strings.Contains(name, "Builder"):
		fs = append(fs, "strings.Builder")
	case pkg == "sort":
		fs = append(fs, "sort")
	case pkg == "slices":
		fs = append(fs, "slices")
	case pkg == "fmt":
		fs = append(fs, "fmt")
	case pkg == "strconv":
		fs = append(fs, "strconv")
	case pkg == "math":
		fs = append(fs, "math")
	case pkg == "time":
		fs = append(fs, "time")
	case pkg == "os" || pkg == "syscall" || strings.HasPrefix(pkg, "internal/syscall") || pkg == "golang.org/x/sys/unix":
		fs = append(fs, "os/syscall")
	}
	if len(callee.Blocks) == 0 {
		fs = append(fs, "call.nobody")
	}
	return fs
}

// calleeName is pkg.Func or pkg.Type.Method, generic instances folded to
// their origin.
func calleeName(f *ssa.Function) string {
	if o := f.Origin(); o != nil {
		f = o
	}
	s := f.RelString(nil)
	s = strings.ReplaceAll(s, "(*", "")
	s = strings.ReplaceAll(s, ")", "")
	s = strings.ReplaceAll(s, "(", "")
	if i := strings.Index(s, "["); i >= 0 {
		s = s[:i]
	}
	return s
}

func syncType(name string) string {
	// sync.Mutex.Lock -> Mutex
	rest := strings.TrimPrefix(name, "sync.")
	if i := strings.IndexByte(rest, '$'); i >= 0 {
		rest = rest[:i]
	}
	if rest != "" && rest[0] >= 'a' && rest[0] <= 'z' {
		return "internal"
	}
	if i := strings.IndexByte(rest, '.'); i >= 0 {
		return rest[:i]
	}
	return rest
}

func under(t types.Type) types.Type { return t.Underlying() }

func isMap(t types.Type) bool {
	_, ok := under(t).(*types.Map)
	return ok
}

func isString(t types.Type) bool {
	b, ok := under(t).(*types.Basic)
	return ok && b.Info()&types.IsString != 0
}

func isInteger(t types.Type) bool {
	b, ok := under(t).(*types.Basic)
	return ok && b.Info()&types.IsInteger != 0
}

func isFloat(t types.Type) bool {
	b, ok := under(t).(*types.Basic)
	return ok && b.Info()&types.IsFloat != 0
}

func isComplex(t types.Type) bool {
	b, ok := under(t).(*types.Basic)
	return ok && b.Info()&types.IsComplex != 0
}

func isSliceOfSlice(t types.Type) bool {
	s, ok := under(t).(*types.Slice)
	if !ok {
		return false
	}
	_, ok = under(s.Elem()).(*types.Slice)
	return ok
}

func intWidth(t types.Type) int {
	switch under(t).(*types.Basic).Kind() {
	case types.Int8, types.Uint8:
		return 8
	case types.Int16, types.Uint16:
		return 16
	case types.Int32, types.Uint32:
		return 32
	}
	return 64 // int, uint, uintptr, int64, uint64 (64-bit targets)
}

func keyCat(t types.Type) string {
	m := coreMap(t)
	k := m.Key()
	switch u := under(k).(type) {
	case *types.Basic:
		switch {
		case u.Info()&types.IsString != 0:
			return "string"
		case u.Info()&types.IsInteger != 0:
			return "int"
		case u.Info()&types.IsFloat != 0:
			return "float"
		case u.Kind() == types.Bool:
			return "bool"
		case u.Kind() == types.UnsafePointer:
			return "unsafeptr"
		}
	case *types.Pointer:
		return "pointer"
	case *types.Struct:
		return "struct"
	case *types.Interface:
		return "interface"
	case *types.Array:
		return "array"
	case *types.Chan:
		return "chan"
	}
	return "other"
}

func typeName(t types.Type) string {
	return types.TypeString(t, func(p *types.Package) string { return p.Name() })
}

func convertFeats(v *ssa.Convert) []string {
	from, to := v.X.Type(), v.Type()
	isUP := func(t types.Type) bool {
		b, ok := under(t).(*types.Basic)
		return ok && b.Kind() == types.UnsafePointer
	}
	isBytes := func(t types.Type) bool {
		s, ok := under(t).(*types.Slice)
		if !ok {
			return false
		}
		b, ok := under(s.Elem()).(*types.Basic)
		return ok && (b.Kind() == types.Byte)
	}
	isRunes := func(t types.Type) bool {
		s, ok := under(t).(*types.Slice)
		if !ok {
			return false
		}
		b, ok := under(s.Elem()).(*types.Basic)
		return ok && b.Kind() == types.Rune
	}
	switch {
	case isUP(from) || isUP(to):
		return []string{"unsafe.convert"}
	case isString(to) && isBytes(from):
		return []string{"conv.bytes2string"}
	case isString(from) && isBytes(to):
		return []string{"conv.string2bytes"}
	case isString(to) && isRunes(from):
		return []string{"conv.runes2string"}
	case isString(from) && isRunes(to):
		return []string{"conv.string2runes"}
	case isString(to) && isInteger(from):
		return []string{"conv.int2string"}
	case isFloat(from) && isInteger(to):
		return []string{"conv.float2int"}
	case isInteger(from) && isFloat(to):
		return []string{"conv.int2float"}
	case isFloat(from) && isFloat(to):
		return []string{"conv.float2float"}
	case isInteger(from) && isInteger(to):
		return []string{"conv.int2int"}
	}
	return []string{"conv.other"}
}

func sortedKeys[M ~map[string]V, V any](m M) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

func coreMap(t types.Type) *types.Map {
	if m, ok := under(t).(*types.Map); ok {
		return m
	}
	return types.NewMap(types.Typ[types.Invalid], types.Typ[types.Invalid])
}
