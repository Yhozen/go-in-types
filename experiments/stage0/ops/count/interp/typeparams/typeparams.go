// Package typeparams holds the one helper the interpreter used from
// golang.org/x/tools/internal/typeparams. Programs are built with
// ssa.InstantiateGenerics, so bodies never see type parameters.
package typeparams

import "go/types"

// MustDeref returns the element type of a pointer type.
func MustDeref(t types.Type) types.Type {
	if p, ok := t.Underlying().(*types.Pointer); ok {
		return p.Elem()
	}
	panic("not a pointer: " + t.String())
}
