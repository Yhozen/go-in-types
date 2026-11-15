package main

import (
	"fmt"
	"strconv"
)

type Shape interface {
	Area() int
	Name() string
}

type Sq struct{ s int }
type Re struct{ w, h int }

func (s Sq) Area() int     { return s.s * s.s }
func (s Sq) Name() string  { return "sq" }
func (r *Re) Area() int    { return r.w * r.h }
func (r *Re) Name() string { return "re" }
func (r *Re) String() string {
	return "Re(" + strconv.Itoa(r.w) + "x" + strconv.Itoa(r.h) + ")"
}

type Named interface{ Name() string }

type Base struct{ id int }

func (b Base) ID() int         { return b.id }
func (b *Base) SetID(i int)    { b.id = i }
type Derived struct {
	Base
	label string
}

func describe(x any) string {
	switch v := x.(type) {
	case nil:
		return "nil"
	case int, int64:
		return fmt.Sprint("integer ", v)
	case string:
		return "string " + v
	case Shape:
		return "shape " + v.Name() + " " + strconv.Itoa(v.Area())
	case error:
		return "error " + v.Error()
	case []int:
		return "slice " + strconv.Itoa(len(v))
	default:
		return "other"
	}
}

func main() {
	shapes := []Shape{Sq{3}, &Re{2, 5}}
	total := 0
	for _, s := range shapes {
		total += s.Area()
	}
	fmt.Println(total, shapes[1])
	var n Named = shapes[0]
	_, isShape := n.(Shape)
	sq, isSq := n.(Sq)
	_, isRe := n.(*Re)
	fmt.Println(isShape, isSq, sq.s, isRe)
	for _, x := range []any{nil, 1, int64(2), "s", Sq{2}, fmt.Errorf("e%d", 1), []int{1}, 3.5, int8(1)} {
		fmt.Println(describe(x))
	}
	var a, b any = 1, 1
	var c any = int64(1)
	fmt.Println(a == b, a == c, a != nil, any(Sq{1}) == any(Sq{1}))
	d := &Derived{Base{1}, "d"}
	d.SetID(42)
	fmt.Println(d.ID(), d.Base.id, d.label)
	type IDer interface{ ID() int }
	var ider IDer = d
	fmt.Println(ider.ID())
	f := d.ID
	g := (*Base).SetID
	g(&d.Base, 7)
	fmt.Println(f(), d.ID())
	h := Shape.Area
	fmt.Println(h(Sq{4}))
	defer func() { fmt.Println("recovered:", recover()) }()
	var e any = "str"
	fmt.Println(e.(int))
}
