package main

// The type table: every go/types type the IR mentions gets a TypeId, with
// slot layout (DESIGN.md "Value model") resolved here.

import (
	"fmt"
	"go/types"

	"golang.org/x/tools/go/types/typeutil"
)

type typeTable struct {
	ids   typeutil.Map // types.Type -> int
	slots typeutil.Map // types.Type -> int
	list  []any
	named []namedEntry // filled with method sets at the end
}

// namedEntry is a type whose method sets are filled at the end: a named
// type, or an unnamed struct with embedded fields (promoted methods).
type namedEntry struct {
	id int
	t  types.Type
}

var intKinds = map[types.BasicKind][2]string{
	types.Int8: {"int8"}, types.Int16: {"int16"}, types.Int32: {"int32"}, types.Int64: {"int64"},
	types.Uint8: {"uint8"}, types.Uint16: {"uint16"}, types.Uint32: {"uint32"}, types.Uint64: {"uint64"},
	types.Int: {"int64", "int"}, types.Uint: {"uint64", "uint"}, types.Uintptr: {"uint64", "uintptr"},
}

// methodKey is the dispatch name of a method: exported names as is,
// unexported ones qualified by package path (they never match across
// packages in Go).
func methodKey(m *types.Func) string {
	if m.Exported() || m.Pkg() == nil {
		return m.Name()
	}
	return m.Pkg().Path() + "." + m.Name()
}

// typeName prints a named type as Go's %T does (package name, not path).
func typeName(t types.Type) string {
	return canon(t, func(p *types.Package) string { return p.Name() })
}

func (tt *typeTable) slotsOf(t types.Type) int {
	t = types.Unalias(t)
	if v := tt.slots.At(t); v != nil {
		return v.(int)
	}
	n := 1
	switch u := t.Underlying().(type) {
	case *types.Array:
		n = int(u.Len()) * tt.slotsOf(u.Elem())
	case *types.Struct:
		n = 0
		for i := 0; i < u.NumFields(); i++ {
			n += tt.slotsOf(u.Field(i).Type())
		}
	case *types.Tuple:
		n = 0
		for i := 0; i < u.Len(); i++ {
			n += tt.slotsOf(u.At(i).Type())
		}
	}
	tt.slots.Set(t, n)
	return n
}

// fieldOffset is the slot offset of field i of struct s.
func (tt *typeTable) fieldOffset(s *types.Struct, i int) int {
	off := 0
	for j := 0; j < i; j++ {
		off += tt.slotsOf(s.Field(j).Type())
	}
	return off
}

func (tt *typeTable) id(t types.Type) int {
	t = types.Unalias(t)
	if v := tt.ids.At(t); v != nil {
		return v.(int)
	}
	id := len(tt.list)
	tt.list = append(tt.list, nil)
	tt.ids.Set(t, id)
	tt.list[id] = tt.build(t, id)
	return id
}

func (tt *typeTable) build(t types.Type, id int) any {
	slots := tt.slotsOf(t)
	switch t := t.(type) {
	case *types.Basic:
		if k, ok := intKinds[t.Kind()]; ok {
			return TInt{K: "int", Int: k[0], Name: k[1], Slots: 1}
		}
		switch t.Kind() {
		case types.Bool, types.UntypedBool:
			return TBasic{K: "bool", Slots: 1}
		case types.String, types.UntypedString:
			return TBasic{K: "string", Slots: 1}
		case types.Float32:
			return TFloat{K: "float", Bits: 32, Slots: 1}
		case types.Float64, types.UntypedFloat:
			return TFloat{K: "float", Bits: 64, Slots: 1}
		case types.UntypedInt, types.UntypedRune:
			return TInt{K: "int", Int: "int64", Slots: 1}
		}
		return TOpaque{K: "opaque", What: t.String(), Slots: 1}
	case *types.Pointer:
		return TElem{K: "pointer", Elem: tt.id(t.Elem()), Slots: 1}
	case *types.Slice:
		return TElem{K: "slice", Elem: tt.id(t.Elem()), Slots: 1}
	case *types.Chan:
		return TElem{K: "chan", Elem: tt.id(t.Elem()), Slots: 1}
	case *types.Array:
		return TArray{K: "array", Elem: tt.id(t.Elem()), Len: t.Len(), Slots: slots}
	case *types.Map:
		return TMap{K: "map", Key: tt.id(t.Key()), Elem: tt.id(t.Elem()), Slots: 1}
	case *types.Struct:
		fs := make([]Field, t.NumFields())
		off := 0
		for i := range fs {
			f := t.Field(i)
			fs[i] = Field{Name: f.Name(), Type: tt.id(f.Type()), Offset: off, Embedded: f.Embedded()}
			off += tt.slotsOf(f.Type())
		}
		res := TStruct{K: "struct", Fields: fs, Slots: slots}
		for _, f := range fs {
			if f.Embedded {
				res.Methods, res.PtrMethods = map[string]int{}, map[string]int{}
				tt.named = append(tt.named, namedEntry{id, t})
				break
			}
		}
		return res
	case *types.Signature:
		return tt.sig(t, nil)
	case *types.Interface:
		ms := make([]string, t.NumMethods())
		sigs := make([]int, t.NumMethods())
		for i := range ms {
			ms[i] = methodKey(t.Method(i))
		}
		// Built after the methods: tt.id may append to tt.list.
		res := TInterface{K: "interface", Methods: ms, Sigs: sigs, Slots: 1}
		for i := range sigs {
			sigs[i] = tt.id(t.Method(i).Type())
		}
		return res
	case *types.Tuple:
		es := make([]int, t.Len())
		for i := range es {
			es[i] = tt.id(t.At(i).Type())
		}
		return TTuple{K: "tuple", Elems: es, Slots: slots}
	case *types.Named:
		if o := t.Obj(); o.Pkg() != nil && o.Pkg().Path() == "$ssa" && o.Name() == "deferStack" {
			return TOpaque{K: "opaque", What: "deferstack", Slots: 1} // ssa:deferstack()'s result
		}
		if t.TypeParams().Len() > t.TypeArgs().Len() {
			return TOpaque{K: "opaque", What: "generic " + typeName(t), Slots: 1}
		}
		u := tt.id(t.Underlying())
		tt.named = append(tt.named, namedEntry{id, t})
		return TNamed{K: "named", Name: typeName(t), Underlying: u, Slots: slots, Methods: map[string]int{}, PtrMethods: map[string]int{}}
	case *types.TypeParam:
		return TOpaque{K: "opaque", What: "type parameter " + t.String(), Slots: 1}
	}
	return TOpaque{K: "opaque", What: fmt.Sprintf("%T %s", t, t), Slots: 1}
}

// sig is a func type; recv (if any) becomes the first parameter.
func (tt *typeTable) sig(s *types.Signature, recv *types.Var) TFunc {
	ps := []int{}
	if recv != nil {
		ps = append(ps, tt.id(recv.Type()))
	}
	for i := 0; i < s.Params().Len(); i++ {
		ps = append(ps, tt.id(s.Params().At(i).Type()))
	}
	rs := []int{}
	for i := 0; i < s.Results().Len(); i++ {
		rs = append(rs, tt.id(s.Results().At(i).Type()))
	}
	return TFunc{K: "func", Params: ps, Results: rs, Variadic: s.Variadic(), Slots: 1}
}

// sigID interns a signature that includes the receiver as first parameter.
func (tt *typeTable) sigID(s *types.Signature) int {
	if s.Recv() == nil {
		return tt.id(s)
	}
	vars := []*types.Var{s.Recv()}
	for i := 0; i < s.Params().Len(); i++ {
		vars = append(vars, s.Params().At(i))
	}
	return tt.id(types.NewSignatureType(nil, nil, nil, types.NewTuple(vars...), s.Results(), s.Variadic()))
}

func isFloat(t types.Type) bool {
	b, ok := t.Underlying().(*types.Basic)
	return ok && b.Info()&types.IsFloat != 0
}

func floatBits(t types.Type) int {
	if t.Underlying().(*types.Basic).Kind() == types.Float32 {
		return 32
	}
	return 64
}

func isComplex(t types.Type) bool {
	b, ok := t.Underlying().(*types.Basic)
	return ok && b.Info()&types.IsComplex != 0
}

func isUnsafePointer(t types.Type) bool {
	b, ok := t.Underlying().(*types.Basic)
	return ok && b.Kind() == types.UnsafePointer
}

func isUnsigned(t types.Type) bool {
	b, ok := t.Underlying().(*types.Basic)
	return ok && b.Info()&types.IsUnsigned != 0
}

func isInteger(t types.Type) bool {
	b, ok := t.Underlying().(*types.Basic)
	return ok && b.Info()&types.IsInteger != 0
}

func is64(t types.Type) bool {
	switch t.Underlying().(*types.Basic).Kind() {
	case types.Int, types.Int64, types.Uint, types.Uint64, types.Uintptr:
		return true
	}
	return false
}
