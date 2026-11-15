package main

// Lowering of one go/ssa function to IR. The mapping of every go/ssa
// instruction kind is the switch in (*lowerer).instr; instrMapping below is
// the same table as data (printed by -mapping, checked by tests).

import (
	"encoding/json"
	"fmt"
	"go/constant"
	"go/token"
	"go/types"
	"math"
	"strconv"

	"golang.org/x/tools/go/ssa"
)

// instrMapping: go/ssa instruction -> IR. "trap" = becomes a trap
// instruction; "dropped" = emits nothing.
var instrMapping = [][2]string{
	{"*ssa.Alloc", "alloc"},
	{"*ssa.Phi", "phi"},
	{"*ssa.Call", "call (builtins: call {builtin}; float min/max: soft-float calls; complex/real/imag, unsafe.Add/Slice/String/StringData/SliceData outside the string<->slice patterns, ssa:deferstack uses outside defer: trap; math.Float*bits: changeType; ssa:deferstack: dropped)"},
	{"*ssa.BinOp", "binop (float: soft-float call; complex: trap)"},
	{"*ssa.UnOp", "* -> load, <- -> recv, - ! ^ -> unop (float -: soft-float call; complex: trap)"},
	{"*ssa.ChangeType", "changeType"},
	{"*ssa.Convert", "convert (float involved: soft-float calls + convert; *T<->unsafe.Pointer: changeType; uintptr<->unsafe.Pointer, complex: trap)"},
	{"*ssa.MultiConvert", "trap (only in generic bodies)"},
	{"*ssa.ChangeInterface", "changeInterface"},
	{"*ssa.SliceToArrayPointer", "sliceToArrayPtr"},
	{"*ssa.MakeInterface", "makeInterface"},
	{"*ssa.MakeClosure", "makeClosure"},
	{"*ssa.MakeMap", "makeMap"},
	{"*ssa.MakeChan", "makeChan"},
	{"*ssa.MakeSlice", "makeSlice"},
	{"*ssa.Slice", "slice"},
	{"*ssa.FieldAddr", "fieldAddr"},
	{"*ssa.Field", "field"},
	{"*ssa.IndexAddr", "indexAddr"},
	{"*ssa.Index", "index"},
	{"*ssa.Lookup", "lookup"},
	{"*ssa.Select", "trap"},
	{"*ssa.Range", "range"},
	{"*ssa.Next", "next"},
	{"*ssa.TypeAssert", "typeAssert"},
	{"*ssa.Extract", "extract"},
	{"*ssa.Jump", "jump"},
	{"*ssa.If", "if"},
	{"*ssa.Return", "return"},
	{"*ssa.RunDefers", "runDefers"},
	{"*ssa.Panic", "panic"},
	{"*ssa.Go", "trap"},
	{"*ssa.Defer", "defer (onto a range-over-func parent's stack: trap)"},
	{"*ssa.Send", "send"},
	{"*ssa.Store", "store"},
	{"*ssa.MapUpdate", "mapUpdate"},
	{"*ssa.DebugRef", "dropped"},
}

type lowerer struct {
	fe       *frontend
	f        *ssa.Function
	regs     map[ssa.Value]int
	subst    map[ssa.Value]Operand // values replaced by an operand (dropped producers)
	regTypes []int
	instrs   []any
	traps    int
}

func (fe *frontend) lowerBody(f *ssa.Function, out *Func) {
	l := &lowerer{fe: fe, f: f, regs: map[ssa.Value]int{}, subst: map[ssa.Value]Operand{}, regTypes: []int{}}
	for _, p := range f.Params {
		l.newReg(p)
	}
	for _, fv := range f.FreeVars {
		l.newReg(fv)
	}
	out.Params, out.FreeVars = len(f.Params), len(f.FreeVars)
	l.prepass()
	for _, b := range f.Blocks {
		for _, ins := range b.Instrs {
			if v, ok := ins.(ssa.Value); ok {
				if _, s := l.subst[v]; !s && hasResult(v) {
					l.newReg(v)
				}
			}
		}
	}
	for _, b := range f.Blocks {
		blk := &Block{Preds: []int{}, Succs: []int{}}
		for _, p := range b.Preds {
			blk.Preds = append(blk.Preds, p.Index)
		}
		for _, s := range b.Succs {
			blk.Succs = append(blk.Succs, s.Index)
		}
		l.instrs = []any{}
		for _, ins := range b.Instrs {
			l.instr(ins)
		}
		blk.Instrs = l.instrs
		out.Blocks = append(out.Blocks, blk)
	}
	out.Regs = len(l.regTypes)
	out.RegTypes = l.regTypes
	out.Recover = -1
	if f.Recover != nil {
		out.Recover = f.Recover.Index
	}
	fe.stats.trapInstrs += l.traps
}

func hasResult(v ssa.Value) bool {
	if t, ok := v.Type().(*types.Tuple); ok && t.Len() == 0 {
		return false
	}
	return true
}

func (l *lowerer) newReg(v ssa.Value) int {
	r := len(l.regTypes)
	l.regTypes = append(l.regTypes, l.fe.tt.id(v.Type()))
	if v != nil {
		l.regs[v] = r
	}
	return r
}

func (l *lowerer) temp(t types.Type) int {
	r := len(l.regTypes)
	l.regTypes = append(l.regTypes, l.fe.tt.id(t))
	return r
}

// prepass marks values whose producer is dropped: ssa:deferstack() calls
// and unsafe.SliceData/StringData feeding a recognised pattern.
func (l *lowerer) prepass() {
	for _, b := range l.f.Blocks {
		for _, ins := range b.Instrs {
			c, ok := ins.(*ssa.Call)
			if !ok {
				continue
			}
			bi, ok := c.Call.Value.(*ssa.Builtin)
			if !ok {
				continue
			}
			switch bi.Name() {
			case "Sizeof", "Alignof":
				t := c.Call.Args[0].Type()
				n := l.fe.sizes.Sizeof(t)
				if bi.Name() == "Alignof" {
					n = l.fe.sizes.Alignof(t)
				}
				l.subst[c] = opInt(n, l.fe.tt.id(c.Type()))
			case "ssa:deferstack":
				l.subst[c] = opZero(l.fe.tt.id(c.Type()))
			case "SliceData", "StringData":
				all := true
				for _, r := range *c.Referrers() {
					if !l.isUnsafePattern(r, c) {
						all = false
					}
				}
				if all {
					l.subst[c] = opZero(l.fe.tt.id(c.Type()))
				}
			}
		}
	}
}

// isUnsafePattern: r is unsafe.String(v, n) or unsafe.Slice(v, n).
func (l *lowerer) isUnsafePattern(r ssa.Instruction, v ssa.Value) bool {
	c, ok := r.(*ssa.Call)
	if !ok {
		return false
	}
	bi, ok := c.Call.Value.(*ssa.Builtin)
	return ok && (bi.Name() == "String" || bi.Name() == "Slice") && c.Call.Args[0] == v
}

func (l *lowerer) emit(i any) { l.instrs = append(l.instrs, i) }

func (l *lowerer) trap(what string) {
	l.traps++
	l.emit(ITrap{Op: "trap", What: what})
}

func (l *lowerer) t(v ssa.Value) int { return l.fe.tt.id(v.Type()) }

// ---------------------------------------------------------------- operands

func (l *lowerer) op(v ssa.Value) Operand {
	if o, ok := l.subst[v]; ok {
		return o
	}
	switch v := v.(type) {
	case *ssa.Const:
		return l.fe.constOp(v)
	case *ssa.Global:
		return opGlobal(l.fe.global(v))
	case *ssa.Function:
		return opFunc(l.fe.funcID(v))
	case *ssa.Builtin:
		panic("builtin used as a value: " + v.Name())
	}
	r, ok := l.regs[v]
	if !ok {
		panic(fmt.Sprintf("%s: no register for %s (%T)", l.f, v.Name(), v))
	}
	return opReg(r)
}

func (l *lowerer) ops(vs []ssa.Value) []Operand {
	out := make([]Operand, len(vs))
	for i, v := range vs {
		out[i] = l.op(v)
	}
	return out
}

func (fe *frontend) constOp(c *ssa.Const) Operand {
	t := fe.tt.id(c.Type())
	if c.Value == nil {
		switch c.Type().Underlying().(type) {
		case *types.Struct, *types.Array:
			return opZero(t)
		case *types.Basic:
			if isUnsafePointer(c.Type()) {
				return opConst("null", t)
			}
			return opZero(t)
		}
		return opConst("null", t)
	}
	switch c.Value.Kind() {
	case constant.Bool:
		return opConst(strconv.FormatBool(constant.BoolVal(c.Value)), t)
	case constant.String:
		return opConst(byteString(constant.StringVal(c.Value)), t)
	case constant.Int:
		if isFloat(c.Type()) {
			break
		}
		return opConst(`{"i":"`+c.Value.ExactString()+`"}`, t)
	case constant.Complex:
		return opZero(t)
	}
	if isFloat(c.Type()) {
		if floatBits(c.Type()) == 32 {
			f, _ := constant.Float32Val(constant.ToFloat(c.Value))
			return opConst(fmt.Sprintf(`{"fbits":"0x%08x"}`, math.Float32bits(f)), t)
		}
		f, _ := constant.Float64Val(constant.ToFloat(c.Value))
		return opConst(fmt.Sprintf(`{"fbits":"0x%016x"}`, math.Float64bits(f)), t)
	}
	if isComplex(c.Type()) {
		return opZero(t)
	}
	panic(fmt.Sprintf("constant %s of type %s", c.Value, c.Type()))
}

// byteString encodes a Go string as a JSON string with one char per byte.
func byteString(s string) string {
	rs := make([]rune, len(s))
	for i := 0; i < len(s); i++ {
		rs[i] = rune(s[i])
	}
	b, _ := json.Marshal(string(rs))
	return string(b)
}

// ------------------------------------------------------------ instructions

func (l *lowerer) dst(v ssa.Value) int { return l.regs[v] }

func (l *lowerer) instr(ins ssa.Instruction) {
	switch v := ins.(type) {
	case *ssa.DebugRef:
	case *ssa.Alloc:
		l.emit(IAlloc{Op: "alloc", Dst: l.dst(v), T: l.t(v), Elem: l.fe.tt.id(deref(v.Type())), Heap: v.Heap})
	case *ssa.Phi:
		l.emit(IPhi{Op: "phi", Dst: l.dst(v), T: l.t(v), Edges: l.ops(v.Edges)})
	case *ssa.Call:
		l.call(v)
	case *ssa.BinOp:
		l.binop(v)
	case *ssa.UnOp:
		l.unop(v)
	case *ssa.ChangeType:
		l.emit(IX{Op: "changeType", Dst: l.dst(v), T: l.t(v), X: l.op(v.X)})
	case *ssa.Convert:
		l.convert(v)
	case *ssa.MultiConvert:
		l.trap("MultiConvert (generic body)")
	case *ssa.ChangeInterface:
		l.emit(IX{Op: "changeInterface", Dst: l.dst(v), T: l.t(v), X: l.op(v.X)})
	case *ssa.SliceToArrayPointer:
		l.emit(IX{Op: "sliceToArrayPtr", Dst: l.dst(v), T: l.t(v), X: l.op(v.X)})
	case *ssa.MakeInterface:
		l.fe.noteIface(v.X.Type())
		l.emit(IMakeInterface{Op: "makeInterface", Dst: l.dst(v), T: l.t(v), X: l.op(v.X), XT: l.fe.tt.id(v.X.Type())})
	case *ssa.MakeClosure:
		l.emit(IMakeClosure{Op: "makeClosure", Dst: l.dst(v), T: l.t(v), Fn: l.fe.funcID(v.Fn.(*ssa.Function)), Bindings: l.ops(v.Bindings)})
	case *ssa.MakeMap:
		i := IMakeMap{Op: "makeMap", Dst: l.dst(v), T: l.t(v)}
		if v.Reserve != nil {
			o := l.op(v.Reserve)
			i.Reserve = &o
		}
		l.emit(i)
	case *ssa.MakeChan:
		l.emit(IMakeChan{Op: "makeChan", Dst: l.dst(v), T: l.t(v), Size: l.op(v.Size)})
	case *ssa.MakeSlice:
		l.emit(IMakeSlice{Op: "makeSlice", Dst: l.dst(v), T: l.t(v), Len: l.op(v.Len), Cap: l.op(v.Cap)})
	case *ssa.Slice:
		i := ISlice{Op: "slice", Dst: l.dst(v), T: l.t(v), X: l.op(v.X)}
		i.Low, i.High, i.Max = l.optOp(v.Low), l.optOp(v.High), l.optOp(v.Max)
		l.emit(i)
	case *ssa.FieldAddr:
		l.emit(IField{Op: "fieldAddr", Dst: l.dst(v), T: l.t(v), X: l.op(v.X), Field: v.Field})
	case *ssa.Field:
		l.emit(IField{Op: "field", Dst: l.dst(v), T: l.t(v), X: l.op(v.X), Field: v.Field})
	case *ssa.IndexAddr:
		l.emit(IIndex{Op: "indexAddr", Dst: l.dst(v), T: l.t(v), X: l.op(v.X), Index: l.op(v.Index)})
	case *ssa.Index:
		l.emit(IIndex{Op: "index", Dst: l.dst(v), T: l.t(v), X: l.op(v.X), Index: l.op(v.Index)})
	case *ssa.Lookup:
		l.emit(ILookup{Op: "lookup", Dst: l.dst(v), T: l.t(v), X: l.op(v.X), Index: l.op(v.Index), CommaOk: v.CommaOk})
	case *ssa.Select:
		l.trap("select not supported")
	case *ssa.Range:
		l.emit(IX{Op: "range", Dst: l.dst(v), T: l.t(v), X: l.op(v.X)})
	case *ssa.Next:
		l.emit(INext{Op: "next", Dst: l.dst(v), T: l.t(v), Iter: l.op(v.Iter), IsString: v.IsString})
	case *ssa.TypeAssert:
		l.emit(ITypeAssert{Op: "typeAssert", Dst: l.dst(v), T: l.t(v), X: l.op(v.X), Assert: l.fe.tt.id(v.AssertedType), CommaOk: v.CommaOk})
	case *ssa.Extract:
		l.emit(IExtract{Op: "extract", Dst: l.dst(v), T: l.t(v), Tuple: l.op(v.Tuple), Index: v.Index})
	case *ssa.Jump:
		l.emit(IOp{Op: "jump"})
	case *ssa.If:
		l.emit(IIf{Op: "if", Cond: l.op(v.Cond)})
	case *ssa.Return:
		l.emit(IReturn{Op: "return", Results: l.ops(v.Results)})
	case *ssa.RunDefers:
		l.emit(IOp{Op: "runDefers"})
	case *ssa.Panic:
		l.emit(IPanic{Op: "panic", X: l.op(v.X)})
	case *ssa.Go:
		l.trap("goroutine not supported")
	case *ssa.Defer:
		if v.DeferStack != nil {
			if _, own := l.subst[v.DeferStack]; !own {
				l.trap("defer in a range-over-func body not supported")
				return
			}
		}
		callee, args, ok := l.callee(&v.Call)
		if !ok {
			return
		}
		l.emit(IDefer{Op: "defer", Callee: callee, Args: args})
	case *ssa.Send:
		l.emit(ISend{Op: "send", Chan: l.op(v.Chan), Val: l.op(v.X)})
	case *ssa.Store:
		l.emit(IStore{Op: "store", Ptr: l.op(v.Addr), Val: l.op(v.Val)})
	case *ssa.MapUpdate:
		l.emit(IMapUpdate{Op: "mapUpdate", Map: l.op(v.Map), Key: l.op(v.Key), Val: l.op(v.Value)})
	default:
		panic(fmt.Sprintf("unmapped go/ssa instruction %T", ins))
	}
}

func (l *lowerer) optOp(v ssa.Value) *Operand {
	if v == nil {
		return nil
	}
	o := l.op(v)
	return &o
}

func deref(t types.Type) types.Type { return t.Underlying().(*types.Pointer).Elem() }

var binopKinds = map[token.Token]string{
	token.ADD: "+", token.SUB: "-", token.MUL: "*", token.QUO: "/", token.REM: "%",
	token.AND: "&", token.OR: "|", token.XOR: "^", token.AND_NOT: "&^", token.SHL: "<<", token.SHR: ">>",
	token.EQL: "==", token.NEQ: "!=", token.LSS: "<", token.LEQ: "<=", token.GTR: ">", token.GEQ: ">=",
}

var floatBinops = map[token.Token]string{
	token.ADD: "Add", token.SUB: "Sub", token.MUL: "Mul", token.QUO: "Div",
	token.EQL: "Eq", token.NEQ: "Ne", token.LSS: "Lt", token.LEQ: "Le", token.GTR: "Gt", token.GEQ: "Ge",
}

func (l *lowerer) binop(v *ssa.BinOp) {
	if isComplex(v.X.Type()) {
		l.trap("complex numbers not supported")
		return
	}
	if isFloat(v.X.Type()) {
		name, ok := floatBinops[v.Op]
		if !ok {
			panic("float binop " + v.Op.String())
		}
		l.sfCall(name+strconv.Itoa(floatBits(v.X.Type())), l.dst(v), v.Type(), l.op(v.X), l.op(v.Y))
		return
	}
	l.emit(IBinop{Op: "binop", Dst: l.dst(v), T: l.t(v), Kind: binopKinds[v.Op], X: l.op(v.X), Y: l.op(v.Y)})
}

// sfCall emits dst = softfloat.name(args...); dst keeps the Go result type.
func (l *lowerer) sfCall(name string, dst int, t types.Type, args ...Operand) {
	tid := l.fe.tt.id(t)
	l.emit(ICall{Op: "call", Dst: ip(dst), T: ip(tid), Callee: Callee{Static: ip(l.fe.softfloat(name))}, Args: args})
}

func (l *lowerer) unop(v *ssa.UnOp) {
	switch v.Op {
	case token.MUL:
		l.emit(ILoad{Op: "load", Dst: l.dst(v), T: l.t(v), Ptr: l.op(v.X)})
		return
	case token.ARROW:
		l.emit(IRecv{Op: "recv", Dst: l.dst(v), T: l.t(v), Chan: l.op(v.X), CommaOk: v.CommaOk})
		return
	}
	if isComplex(v.X.Type()) {
		l.trap("complex numbers not supported")
		return
	}
	if v.Op == token.SUB && isFloat(v.X.Type()) {
		l.sfCall("Neg"+strconv.Itoa(floatBits(v.X.Type())), l.dst(v), v.Type(), l.op(v.X))
		return
	}
	kind := map[token.Token]string{token.SUB: "-", token.NOT: "!", token.XOR: "^"}[v.Op]
	l.emit(IUnop{Op: "unop", Dst: l.dst(v), T: l.t(v), Kind: kind, X: l.op(v.X)})
}

func (l *lowerer) convert(v *ssa.Convert) {
	from, to := v.X.Type(), v.Type()
	switch {
	case isComplex(from) || isComplex(to):
		l.trap("complex numbers not supported")
	case isUnsafePointer(from) || isUnsafePointer(to):
		_, fp := from.Underlying().(*types.Pointer)
		_, tp := to.Underlying().(*types.Pointer)
		if fp || tp || (isUnsafePointer(from) && isUnsafePointer(to)) {
			l.emit(IX{Op: "changeType", Dst: l.dst(v), T: l.t(v), X: l.op(v.X)})
		} else {
			l.trap("unsafe pointer arithmetic not supported")
		}
	case isFloat(from) && isFloat(to):
		fb, tb := floatBits(from), floatBits(to)
		if fb == tb {
			l.emit(IX{Op: "changeType", Dst: l.dst(v), T: l.t(v), X: l.op(v.X)})
		} else {
			l.sfCall(fmt.Sprintf("F%dto%d", fb, tb), l.dst(v), to, l.op(v.X))
		}
	case isFloat(to): // integer -> float
		x := l.op(v.X)
		name := "Int64to"
		wide := types.Typ[types.Int64]
		if isUnsigned(from) {
			name, wide = "Uint64to", types.Typ[types.Uint64]
		}
		if !is64(from) {
			r := l.temp(wide)
			l.emit(IX{Op: "convert", Dst: r, T: l.fe.tt.id(wide), X: x})
			x = opReg(r)
		}
		l.sfCall(name+strconv.Itoa(floatBits(to)), l.dst(v), to, x)
	case isFloat(from): // float -> integer
		name := fmt.Sprintf("F%dtoInt64", floatBits(from))
		wide := types.Typ[types.Int64]
		if isUnsigned(to) {
			name, wide = fmt.Sprintf("F%dtoUint64", floatBits(from)), types.Typ[types.Uint64]
		}
		if is64(to) {
			l.sfCall(name, l.dst(v), to, l.op(v.X))
			return
		}
		r := l.temp(wide)
		l.sfCall(name, r, wide, l.op(v.X))
		l.emit(IX{Op: "convert", Dst: l.dst(v), T: l.t(v), X: opReg(r)})
	default:
		l.emit(IX{Op: "convert", Dst: l.dst(v), T: l.t(v), X: l.op(v.X)})
	}
}

// callee resolves a call's target; ok=false if a trap was emitted instead.
func (l *lowerer) callee(c *ssa.CallCommon) (Callee, []Operand, bool) {
	if c.IsInvoke() {
		key := methodKey(c.Method)
		l.fe.noteInvoke(key)
		recv := l.op(c.Value)
		return Callee{Invoke: &recv, Method: key}, l.ops(c.Args), true
	}
	switch fn := c.Value.(type) {
	case *ssa.Builtin:
		switch fn.Name() {
		case "complex", "real", "imag":
			l.trap("complex numbers not supported")
			return Callee{}, nil, false
		case "ssa:deferstack", "Add", "Slice", "SliceData", "String", "StringData", "Alignof", "Offsetof", "Sizeof":
			l.trap("unsafe." + fn.Name() + " not supported")
			return Callee{}, nil, false
		}
		name := fn.Name()
		if name == "ssa:wrapnilchk" {
			name = "wrapnilchk"
		}
		return Callee{Builtin: name}, l.ops(c.Args), true
	case *ssa.Function:
		return Callee{Static: ip(l.fe.funcID(fn))}, l.ops(c.Args), true
	}
	v := l.op(c.Value)
	return Callee{Value: &v}, l.ops(c.Args), true
}

func (l *lowerer) call(v *ssa.Call) {
	if _, dropped := l.subst[v]; dropped {
		return
	}
	c := &v.Call
	if fn, ok := c.Value.(*ssa.Function); ok {
		if callRewrites[fn.String()] == "changeType" {
			l.emit(IX{Op: "changeType", Dst: l.dst(v), T: l.t(v), X: l.op(c.Args[0])})
			return
		}
	}
	if bi, ok := c.Value.(*ssa.Builtin); ok {
		switch bi.Name() {
		case "min", "max":
			if isFloat(v.Type()) {
				name := "Min"
				if bi.Name() == "max" {
					name = "Max"
				}
				name += strconv.Itoa(floatBits(v.Type()))
				acc := l.op(c.Args[0])
				for i, a := range c.Args[1:] {
					d := l.dst(v)
					if i < len(c.Args)-2 {
						d = l.temp(v.Type())
					}
					l.sfCall(name, d, v.Type(), acc, l.op(a))
					acc = opReg(d)
				}
				if len(c.Args) == 1 {
					l.emit(IX{Op: "changeType", Dst: l.dst(v), T: l.t(v), X: acc})
				}
				return
			}
		case "String", "Slice":
			if l.unsafeView(v, bi.Name()) {
				return
			}
		}
	}
	callee, args, ok := l.callee(c)
	if !ok {
		return
	}
	i := ICall{Op: "call", Callee: callee, Args: args}
	if hasResult(v) {
		i.Dst, i.T = ip(l.dst(v)), ip(l.t(v))
	}
	l.emit(i)
}

// unsafeView lowers unsafe.String(p, n) with p = &x[0] or SliceData(x),
// x a []byte, to string(x[:n]), and unsafe.Slice(p, n) with p =
// StringData(s) to []byte(s[:n]) (a copy: valid while nobody writes it).
func (l *lowerer) unsafeView(v *ssa.Call, kind string) bool {
	p, n := v.Call.Args[0], v.Call.Args[1]
	var x ssa.Value
	switch p := p.(type) {
	case *ssa.IndexAddr:
		if c, ok := p.Index.(*ssa.Const); ok && c.Int64() == 0 {
			if _, ok := p.X.Type().Underlying().(*types.Slice); ok {
				x = p.X
			}
		}
	case *ssa.Call:
		if bi, ok := p.Call.Value.(*ssa.Builtin); ok && (bi.Name() == "SliceData" || bi.Name() == "StringData") {
			x = p.Call.Args[0]
		}
	}
	if x == nil {
		return false
	}
	isStr := isString(x.Type())
	if (kind == "String") == isStr {
		return false
	}
	if !isInteger(n.Type()) {
		return false
	}
	nOp := l.op(n)
	if !is64(n.Type()) || isUnsigned(n.Type()) {
		r := l.temp(types.Typ[types.Int])
		l.emit(IX{Op: "convert", Dst: r, T: l.fe.tt.id(types.Typ[types.Int]), X: nOp})
		nOp = opReg(r)
	}
	r := l.temp(x.Type())
	l.emit(ISlice{Op: "slice", Dst: r, T: l.fe.tt.id(x.Type()), X: l.op(x), High: &nOp})
	l.emit(IX{Op: "convert", Dst: l.dst(v), T: l.t(v), X: opReg(r)})
	return true
}

func isString(t types.Type) bool {
	b, ok := t.Underlying().(*types.Basic)
	return ok && b.Info()&types.IsString != 0
}
