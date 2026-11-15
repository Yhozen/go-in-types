package main

// Canonical names. Type arguments may be spelled through aliases (e.g.
// ast.Statement = ast.Node), and which spelling go/types and go/ssa record
// for an instance depends on load order, so names are printed here with
// every alias removed.

import (
	"go/types"
	"strconv"
	"strings"

	"golang.org/x/tools/go/ssa"
)

// canon prints t like types.TypeString, with aliases resolved at every level.
func canon(t types.Type, q types.Qualifier) string {
	var b strings.Builder
	writeCanon(&b, t, q)
	return b.String()
}

func writeCanon(b *strings.Builder, t types.Type, q types.Qualifier) {
	t = types.Unalias(t)
	switch t := t.(type) {
	case *types.Named:
		obj := t.Obj()
		if obj.Pkg() != nil {
			if p := q(obj.Pkg()); p != "" {
				b.WriteString(p + ".")
			}
		}
		b.WriteString(obj.Name())
		if args := t.TypeArgs(); args.Len() > 0 {
			b.WriteByte('[')
			for i := 0; i < args.Len(); i++ {
				if i > 0 {
					b.WriteString(", ")
				}
				writeCanon(b, args.At(i), q)
			}
			b.WriteByte(']')
		}
	case *types.Pointer:
		b.WriteByte('*')
		writeCanon(b, t.Elem(), q)
	case *types.Slice:
		b.WriteString("[]")
		writeCanon(b, t.Elem(), q)
	case *types.Array:
		b.WriteString("[" + strconv.FormatInt(t.Len(), 10) + "]")
		writeCanon(b, t.Elem(), q)
	case *types.Map:
		b.WriteString("map[")
		writeCanon(b, t.Key(), q)
		b.WriteByte(']')
		writeCanon(b, t.Elem(), q)
	case *types.Chan:
		switch t.Dir() {
		case types.SendRecv:
			b.WriteString("chan ")
		case types.SendOnly:
			b.WriteString("chan<- ")
		default:
			b.WriteString("<-chan ")
		}
		writeCanon(b, t.Elem(), q)
	case *types.Signature:
		b.WriteString("func")
		writeTuple(b, t.Params(), t.Variadic(), q)
		if r := t.Results(); r.Len() == 1 {
			b.WriteByte(' ')
			writeCanon(b, r.At(0).Type(), q)
		} else if r.Len() > 1 {
			b.WriteByte(' ')
			writeTuple(b, r, false, q)
		}
	case *types.Tuple:
		writeTuple(b, t, false, q)
	case *types.Struct:
		b.WriteString("struct{")
		for i := 0; i < t.NumFields(); i++ {
			if i > 0 {
				b.WriteString("; ")
			}
			f := t.Field(i)
			if !f.Embedded() {
				b.WriteString(f.Name() + " ")
			}
			writeCanon(b, f.Type(), q)
			if tag := t.Tag(i); tag != "" {
				b.WriteString(" " + strconv.Quote(tag))
			}
		}
		b.WriteByte('}')
	case *types.Interface:
		if t.NumMethods() == 0 && t.NumEmbeddeds() == 0 {
			b.WriteString("interface {}")
			return
		}
		b.WriteString("interface{")
		for i := 0; i < t.NumMethods(); i++ {
			if i > 0 {
				b.WriteString("; ")
			}
			m := t.Method(i)
			b.WriteString(m.Name())
			writeCanon(b, m.Type(), q)
		}
		b.WriteByte('}')
	default:
		b.WriteString(types.TypeString(t, q))
	}
}

func writeTuple(b *strings.Builder, t *types.Tuple, variadic bool, q types.Qualifier) {
	b.WriteByte('(')
	for i := 0; i < t.Len(); i++ {
		if i > 0 {
			b.WriteString(", ")
		}
		ty := t.At(i).Type()
		if variadic && i == t.Len()-1 {
			b.WriteString("...")
			ty = ty.(*types.Slice).Elem()
		}
		writeCanon(b, ty, q)
	}
	b.WriteByte(')')
}

func pathQual(p *types.Package) string { return p.Path() }

// funcName is go/ssa's Function.String() with canonical type arguments.
func funcName(f *ssa.Function) string {
	if p := f.Parent(); p != nil {
		return funcName(p) + strings.TrimPrefix(f.Name(), p.Name())
	}
	targs := f.TypeArgs()
	recv := f.Signature.Recv()
	if len(targs) == 0 && (recv == nil || !hasTypeArgs(recv.Type())) {
		return f.String()
	}
	name := f.Name()
	if i := strings.IndexByte(name, '['); i >= 0 {
		name = name[:i]
	}
	var b strings.Builder
	if recv != nil {
		b.WriteString("(" + canon(recv.Type(), pathQual) + ")." + name)
	} else {
		pkg := pkgPathOf(f)
		if pkg != "" {
			b.WriteString(pkg + ".")
		}
		b.WriteString(name)
	}
	if len(targs) > 0 {
		b.WriteByte('[')
		for i, t := range targs {
			if i > 0 {
				b.WriteString(", ")
			}
			b.WriteString(canon(t, pathQual))
		}
		b.WriteByte(']')
	}
	// Synthetic suffixes ($bound, $thunk) survive in f.Name().
	if i := strings.LastIndex(f.Name(), "$"); i >= 0 && !strings.Contains(f.Name()[i:], "]") {
		b.WriteString(f.Name()[i:])
	}
	return b.String()
}

func hasTypeArgs(t types.Type) bool {
	if p, ok := types.Unalias(t).(*types.Pointer); ok {
		t = p.Elem()
	}
	n, ok := types.Unalias(t).(*types.Named)
	return ok && n.TypeArgs().Len() > 0
}
