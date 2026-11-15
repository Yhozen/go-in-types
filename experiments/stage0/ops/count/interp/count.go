package interp

// Instruction counting (added to the copy of golang.org/x/tools/go/ssa/interp).
//
// Every SSA instruction the interpreter executes is counted once, phis
// included, attributed to the current phase (set by the target program
// calling main.Mark) and to the executing function. Functions replaced by
// externals execute no SSA instructions; their calls are counted by name.

import (
	"fmt"
	"go/token"
	"go/types"
	"io"
	"maps"
	"os"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync"
	"unsafe"

	"github.com/zeebo/xxh3"
	"golang.org/x/tools/go/ssa"
)

// Counts is one phase's tally.
type Counts struct {
	Instrs int64
	ByOp   map[string]int64 // instruction kind (Go type name) → executed
	Events map[string]int64 // calls, allocations, map ops, ...
	ByFunc map[*ssa.Function]int64
	Ext    map[string]int64 // externals called
}

func newCounts() *Counts {
	return &Counts{ByOp: map[string]int64{}, Events: map[string]int64{}, ByFunc: map[*ssa.Function]int64{}, Ext: map[string]int64{}}
}

// Counter collects counts by phase, in phase order.
type Counter struct {
	mu     sync.Mutex
	Order  []string
	Phases map[string]*Counts
	cur    *Counts
	total  int64
	// Out receives what the target passes to main.Output.
	Out io.Writer
	// Input is what main.Input returns.
	Mode, Lib, LibText string
}

// TheCounter is the active counter (the interpreter is not reentrant).
var TheCounter = NewCounter()

func NewCounter() *Counter {
	c := &Counter{Phases: map[string]*Counts{}}
	c.SetPhase("init")
	return c
}

func (c *Counter) SetPhase(name string) {
	p, ok := c.Phases[name]
	if !ok {
		p = newCounts()
		c.Phases[name] = p
		c.Order = append(c.Order, name)
	}
	c.cur = p
}

var opNames sync.Map // reflect.Type → string

func opName(instr ssa.Instruction) string {
	t := reflect.TypeOf(instr)
	if s, ok := opNames.Load(t); ok {
		return s.(string)
	}
	s := t.Elem().Name()
	opNames.Store(t, s)
	return s
}

// countBlock counts the instructions of one block execution: n phis
// (already run) plus each non-phi as it runs, via countInstr.
func (fr *frame) countPhis(n int) {
	if n == 0 {
		return
	}
	c := TheCounter
	if fr.i.goroutines > 1 {
		c.mu.Lock()
		defer c.mu.Unlock()
	}
	p := c.cur
	p.Instrs += int64(n)
	p.ByOp["Phi"] += int64(n)
	p.ByFunc[fr.fn] += int64(n)
}

func (fr *frame) countInstr(instr ssa.Instruction) {
	c := TheCounter
	if fr.i.goroutines > 1 {
		c.mu.Lock()
		defer c.mu.Unlock()
		c.cur.Events["instrs while >1 goroutine"]++
	}
	p := c.cur
	p.Instrs++
	c.total++
	if c.total&(1<<24-1) == 0 && Progress {
		fmt.Fprintf(os.Stderr, "progress: %dM instrs, phase %s, in %s\n", c.total>>20, c.Order[len(c.Order)-1], fr.fn)
	}
	p.ByOp[opName(instr)]++
	p.ByFunc[fr.fn]++
	ev := p.Events
	switch instr := instr.(type) {
	case *ssa.Call:
		countCall(ev, &instr.Call, "call")
	case *ssa.Defer:
		countCall(ev, &instr.Call, "defer")
	case *ssa.Go:
		countCall(ev, &instr.Call, "go")
	case *ssa.Alloc:
		if instr.Heap {
			ev["alloc (heap)"]++
		} else {
			ev["alloc (local)"]++
		}
	case *ssa.Lookup:
		if _, ok := instr.X.Type().Underlying().(*types.Map); ok {
			ev["map lookup"]++
		} else {
			ev["string index"]++
		}
	case *ssa.MapUpdate:
		ev["map update"]++
	case *ssa.Range:
		if _, ok := instr.X.Type().Underlying().(*types.Map); ok {
			ev["map range"]++
		} else {
			ev["string range"]++
		}
	case *ssa.Next:
		if instr.IsString {
			ev["string range next"]++
		} else {
			ev["map range next"]++
		}
	case *ssa.UnOp:
		if instr.Op.String() == "<-" {
			ev["chan recv"]++
		}
	}
}

func countCall(ev map[string]int64, cc *ssa.CallCommon, kind string) {
	switch {
	case cc.IsInvoke():
		ev[kind+" (interface method)"]++
	default:
		switch v := cc.Value.(type) {
		case *ssa.Builtin:
			ev[kind+" (builtin "+v.Name()+")"]++
		case *ssa.Function:
			ev[kind+" (static)"]++
		case *ssa.MakeClosure:
			ev[kind+" (closure literal)"]++
		default:
			ev[kind+" (func value)"]++
		}
	}
}

func (fr *frame) countExt(name string) {
	c := TheCounter
	if fr.i.goroutines > 1 {
		c.mu.Lock()
		defer c.mu.Unlock()
	}
	c.cur.Ext[name]++
}

// Report helpers.

// Sum adds counts of the named phases.
func (c *Counter) Sum(names []string) *Counts {
	s := newCounts()
	for _, n := range names {
		p := c.Phases[n]
		if p == nil {
			continue
		}
		s.Instrs += p.Instrs
		for k, v := range p.ByOp {
			s.ByOp[k] += v
		}
		for k, v := range p.Events {
			s.Events[k] += v
		}
		for k, v := range p.ByFunc {
			s.ByFunc[k] += v
		}
		for k, v := range p.Ext {
			s.Ext[k] += v
		}
	}
	return s
}

type KV struct {
	K string
	V int64
}

func sorted(m map[string]int64) []KV {
	var r []KV
	for k, v := range m {
		r = append(r, KV{k, v})
	}
	sort.Slice(r, func(i, j int) bool {
		if r[i].V != r[j].V {
			return r[i].V > r[j].V
		}
		return r[i].K < r[j].K
	})
	return r
}

func FuncName(f *ssa.Function) string { return f.String() }

// PkgOf names the package a function's code comes from (the origin's
// package for generic instantiations; "(synthetic)" for wrappers).
func PkgOf(f *ssa.Function) string {
	for f.Parent() != nil {
		f = f.Parent()
	}
	if o := f.Origin(); o != nil {
		f = o
	}
	if f.Pkg != nil {
		return f.Pkg.Pkg.Path()
	}
	if f.Object() != nil && f.Object().Pkg() != nil {
		return f.Object().Pkg().Path()
	}
	return "(synthetic " + f.Synthetic + ")"
}

// Write prints a report of s.
func Write(w io.Writer, title string, s *Counts, topFuncs int) {
	fmt.Fprintf(w, "### %s\n\ninstructions: %d\n\n", title, s.Instrs)
	fmt.Fprintf(w, "by op:\n")
	for _, kv := range sorted(s.ByOp) {
		fmt.Fprintf(w, "  %-22s %12d\n", kv.K, kv.V)
	}
	fmt.Fprintf(w, "events:\n")
	for _, kv := range sorted(s.Events) {
		fmt.Fprintf(w, "  %-36s %12d\n", kv.K, kv.V)
	}
	byPkg := map[string]int64{}
	byFn := map[string]int64{}
	for f, v := range s.ByFunc {
		byPkg[PkgOf(f)] += v
		byFn[FuncName(f)] += v
	}
	fmt.Fprintf(w, "by package:\n")
	for _, kv := range sorted(byPkg) {
		fmt.Fprintf(w, "  %-60s %12d  %5.1f%%\n", kv.K, kv.V, 100*float64(kv.V)/float64(s.Instrs+1e-9*0+boolInt(s.Instrs == 0)))
	}
	fmt.Fprintf(w, "top functions:\n")
	for i, kv := range sorted(byFn) {
		if i >= topFuncs {
			break
		}
		fmt.Fprintf(w, "  %12d  %5.1f%%  %s\n", kv.V, 100*float64(kv.V)/float64(s.Instrs+1e-9*0+boolInt(s.Instrs == 0)), kv.K)
	}
	fmt.Fprintf(w, "functions executed: %d\n", len(byFn))
	if len(s.Ext) > 0 {
		fmt.Fprintf(w, "externals (calls not interpreted):\n")
		for _, kv := range sorted(s.Ext) {
			fmt.Fprintf(w, "  %-60s %12d\n", kv.K, kv.V)
		}
	}
	fmt.Fprintln(w)
}

// PhaseNames returns phase names in order, filtered by keep.
func (c *Counter) PhaseNames(keep func(string) bool) []string {
	return slices.DeleteFunc(slices.Clone(c.Order), func(s string) bool { return !keep(s) })
}

var _ = maps.Keys[map[int]int]
var _ = strings.HasPrefix

var harnessExternals = map[string]externalFn{}

func init() {
	externals := harnessExternals
	externals["Mark"] = func(fr *frame, args []value) value {
		TheCounter.SetPhase(args[0].(string))
		return nil
	}
	externals["Input"] = func(fr *frame, args []value) value {
		c := TheCounter
		return tuple{c.Mode, c.Lib, c.LibText}
	}
	externals["Output"] = func(fr *frame, args []value) value {
		io.WriteString(TheCounter.Out, args[0].(string))
		return nil
	}
}

func boolInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

var stackDumped bool

// Progress enables a progress line on stderr every 16M instructions.
var Progress = true

// dumpStack prints the target's call stack once (for -crash debugging).
func dumpStack(fr *frame) {
	if stackDumped {
		return
	}
	stackDumped = true
	fmt.Fprintln(os.Stderr, "target stack:")
	for f := fr; f != nil; f = f.caller {
		pos := ""
		if f.block != nil && len(f.block.Instrs) > 0 {
			for _, in := range f.block.Instrs {
				if in.Pos().IsValid() {
					pos = f.fn.Prog.Fset.Position(in.Pos()).String()
					break
				}
			}
		}
		fmt.Fprintf(os.Stderr, "  %s  block %v  %s\n", f.fn, f.block, pos)
	}
}

// skipInit lists standard packages whose package initializers are not
// interpreted (runtime and OS plumbing the interpreter cannot run).
func skipInit(path string) bool {
	switch path {
	case "runtime", "syscall", "os", "os/signal", "time", "sync", "sync/atomic", "unsafe",
		"internal/poll", "internal/syscall/unix", "internal/testlog", "runtime/debug", "internal/godebug",
		"reflect", "errors" /* errorType via internal/abi; only ErrUnsupported otherwise */ :
		return true
	}
	return strings.HasPrefix(path, "internal/") || strings.HasPrefix(path, "encoding/json/") ||
		strings.HasPrefix(path, "net/") || path == "net" || path == "unique" ||
		strings.HasPrefix(path, "github.com/go-json-experiment/") || strings.HasPrefix(path, "runtime/") ||
		strings.HasPrefix(path, "golang.org/x/sys/")
}

// SkippedInits names the package initializers replaced by no-ops.
var SkippedInits []string

func installInitSkips(prog *ssa.Program) {
	for _, p := range prog.AllPackages() {
		if skipInit(p.Pkg.Path()) {
			name := p.Pkg.Path() + ".init"
			SkippedInits = append(SkippedInits, name)
			externals[name] = func(fr *frame, args []value) value { return nil }
		}
	}
	sort.Strings(SkippedInits)
}

// prefixExternal handles generic instantiations of emulated functions.
func prefixExternal(fn *ssa.Function) externalFn {
	name := fn.String()
	if fn.Pkg != nil && fn.Pkg.Pkg.Name() == "main" && fn.Signature.Recv() == nil {
		if ext := harnessExternals[fn.Name()]; ext != nil {
			return ext
		}
	}
	if fn.Blocks == nil && fn.Pkg != nil {
		switch fn.Pkg.Pkg.Path() {
		case "sync/atomic", "internal/runtime/atomic":
			if ext := atomicExternal(fn.Pkg.Pkg.Path(), fn.Name()); ext != nil {
				return ext
			}
		case "sync", "internal/sync":
			if ext := syncRuntimeExternal(fn.Name()); ext != nil {
				return ext
			}
		}
	}
	switch {
	case strings.HasPrefix(name, "slices.overlaps["):
		// Pointer comparison through unsafe in the real code; computed on
		// the interpreter's own backing arrays.
		return func(fr *frame, args []value) value {
			a, b := args[0].([]value), args[1].([]value)
			if len(a) == 0 || len(b) == 0 {
				return false
			}
			const sz = unsafe.Sizeof(value(nil))
			a0, a1 := uintptr(unsafe.Pointer(&a[0])), uintptr(unsafe.Pointer(&a[len(a)-1]))
			b0, b1 := uintptr(unsafe.Pointer(&b[0])), uintptr(unsafe.Pointer(&b[len(b)-1]))
			return a0 <= b1+(sz-1) && b0 <= a1+(sz-1)
		}
	case strings.HasPrefix(name, "reflect.TypeFor["):
		t := fn.TypeArgs()[0]
		return func(fr *frame, args []value) value { return makeReflectType(rtype{t}) }
	}
	return nil
}

func init() {
	externals["internal/bytealg.MakeNoZero"] = func(fr *frame, args []value) value {
		n := args[0].(int)
		s := make([]value, n)
		for i := range s {
			s[i] = byte(0)
		}
		return s
	}
}

// atomicExternal emulates the assembly primitives of sync/atomic and
// internal/runtime/atomic (not atomic: the target runs single-threaded).
func atomicExternal(pkg, name string) externalFn {
	ops := []string{"CompareAndSwap", "Swap", "Add", "And", "Or", "Load", "Store", "Cas", "Xadd", "Xchg"}
	for _, op := range ops {
		if !strings.HasPrefix(name, op) {
			continue
		}
		switch op {
		case "Load":
			return func(fr *frame, args []value) value { return *args[0].(*value) }
		case "Store":
			return func(fr *frame, args []value) value { *args[0].(*value) = args[1]; return nil }
		case "Swap", "Xchg":
			return func(fr *frame, args []value) value {
				p := args[0].(*value)
				old := *p
				*p = args[1]
				return old
			}
		case "CompareAndSwap", "Cas":
			return func(fr *frame, args []value) value {
				p := args[0].(*value)
				if equals(fr.fn.Signature.Params().At(1).Type(), *p, args[1]) {
					*p = args[2]
					return true
				}
				return false
			}
		case "Add", "Xadd":
			return func(fr *frame, args []value) value {
				p := args[0].(*value)
				t := fr.fn.Signature.Params().At(1).Type()
				*p = binop(token.ADD, t, *p, args[1])
				return *p
			}
		case "And", "Or":
			tok := token.AND
			if op == "Or" {
				tok = token.OR
			}
			return func(fr *frame, args []value) value {
				p := args[0].(*value)
				old := *p
				t := fr.fn.Signature.Params().At(1).Type()
				*p = binop(tok, t, *p, args[1])
				return old
			}
		}
	}
	return nil
}

// syncRuntimeExternal emulates the runtime hooks of sync and internal/sync
// for a single goroutine. Blocking hooks mean a deadlock and panic.
func syncRuntimeExternal(name string) externalFn {
	nop := func(fr *frame, args []value) value { return nil }
	switch name {
	case "runtime_procPin", "runtime_canSpin":
		return func(fr *frame, args []value) value {
			if name == "runtime_canSpin" {
				return false
			}
			return 0
		}
	case "runtime_procUnpin", "runtime_registerPoolCleanup", "runtime_doSpin", "runtime_notifyListCheck",
		"runtime_notifyListNotifyAll", "runtime_notifyListNotifyOne", "runtime_Semrelease":
		return nop
	case "runtime_nanotime":
		return func(fr *frame, args []value) value { return int64(0) }
	case "runtime_randn":
		return func(fr *frame, args []value) value { return uint32(0) }
	case "runtime_rand":
		return func(fr *frame, args []value) value { return uint64(0x9e3779b97f4a7c15) }
	case "throw", "fatal":
		return func(fr *frame, args []value) value { panic("sync: " + args[0].(string)) }
	}
	if strings.HasPrefix(name, "runtime_Semacquire") || strings.HasPrefix(name, "runtime_notifyList") {
		return func(fr *frame, args []value) value { panic("deadlock: " + name + " with one goroutine") }
	}
	return nil
}

// xxh3 (github.com/zeebo/xxh3) reads memory through unsafe.Pointer
// arithmetic, which the boxed interpreter cannot do. Its entry points are
// computed natively; calls and hashed bytes are counted as externals
// (Ext and Events "xxh3 bytes").
var xxh3States = map[*value]*xxh3.Hasher{}

func bytesOf(v value) []byte {
	s := v.([]value)
	b := make([]byte, len(s))
	for i, x := range s {
		b[i] = x.(byte)
	}
	return b
}

func u128(u xxh3.Uint128) value { return structure{u.Hi, u.Lo} }

func xxh3State(p *value) *xxh3.Hasher {
	h := xxh3States[p]
	if h == nil {
		h = xxh3.New()
		xxh3States[p] = h
	}
	return h
}

func init() {
	const pkg = "github.com/zeebo/xxh3"
	bytes := func(n int) { TheCounter.cur.Events["xxh3 bytes hashed (external)"] += int64(n) }
	externals[pkg+".HashString128"] = func(fr *frame, args []value) value {
		s := args[0].(string)
		bytes(len(s))
		return u128(xxh3.HashString128(s))
	}
	externals[pkg+".HashString"] = func(fr *frame, args []value) value {
		s := args[0].(string)
		bytes(len(s))
		return xxh3.HashString(s)
	}
	externals[pkg+".Hash128"] = func(fr *frame, args []value) value {
		b := bytesOf(args[0])
		bytes(len(b))
		return u128(xxh3.Hash128(b))
	}
	externals[pkg+".Hash"] = func(fr *frame, args []value) value {
		b := bytesOf(args[0])
		bytes(len(b))
		return xxh3.Hash(b)
	}
	externals["(*"+pkg+".Hasher).Write"] = func(fr *frame, args []value) value {
		b := bytesOf(args[1])
		bytes(len(b))
		xxh3State(args[0].(*value)).Write(b)
		return tuple{len(b), iface{}}
	}
	externals["(*"+pkg+".Hasher).WriteString"] = func(fr *frame, args []value) value {
		s := args[1].(string)
		bytes(len(s))
		xxh3State(args[0].(*value)).WriteString(s)
		return tuple{len(s), iface{}}
	}
	externals["(*"+pkg+".Hasher).Sum128"] = func(fr *frame, args []value) value {
		return u128(xxh3State(args[0].(*value)).Sum128())
	}
	externals["(*"+pkg+".Hasher).Sum64"] = func(fr *frame, args []value) value {
		return xxh3State(args[0].(*value)).Sum64()
	}
	externals["(*"+pkg+".Hasher).Reset"] = func(fr *frame, args []value) value {
		delete(xxh3States, args[0].(*value))
		return nil
	}
}

func init() {
	// maps.clone is implemented in the runtime (linkname).
	externals["maps.clone"] = func(fr *frame, args []value) value {
		it := args[0].(iface)
		switch m := it.v.(type) {
		case map[value]value:
			c := make(map[value]value, len(m))
			for k, v := range m {
				c[k] = v
			}
			return iface{it.t, c}
		case *hashmap:
			if m == nil {
				return it
			}
			c := &hashmap{keyType: m.keyType, table: make(map[int]*entry, len(m.table)), length: m.length}
			for h, e := range m.table {
				var head *entry
				var tail **entry = &head
				for ; e != nil; e = e.next {
					*tail = &entry{key: e.key, value: e.value}
					tail = &(*tail).next
				}
				c.table[h] = head
			}
			return iface{it.t, c}
		case nil:
			return it
		}
		panic(fmt.Sprintf("maps.clone: %T", it.v))
	}
}
