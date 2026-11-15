package main

import "fmt"

type Point struct{ X, Y int }

type Rect struct {
	Min, Max Point
	Name     string
	Tags     [3]string
}

func (p Point) Add(q Point) Point { return Point{p.X + q.X, p.Y + q.Y} }
func (p *Point) Scale(k int)      { p.X *= k; p.Y *= k }

func newRect() *Rect { return &Rect{Name: "r"} }

func main() {
	r := Rect{Min: Point{1, 2}, Max: Point{3, 4}}
	r2 := r
	r2.Min.X = 100
	r2.Tags[0] = "t"
	fmt.Println(r.Min.X, r2.Min.X, r.Tags[0] == "", r2.Tags[0])
	p := &r.Max
	p.Scale(10)
	fmt.Println(r.Max.X, r.Max.Y, r.Min.Add(r.Max).X)
	q := newRect()
	q.Max = Point{5, 6}
	(*q).Min.Y = 7
	fmt.Println(q.Name, q.Max.Y, q.Min.Y)
	arr := [3]Point{{1, 1}, {2, 2}}
	brr := arr
	brr[0].X = 9
	fmt.Println(arr[0].X, brr[0].X, arr == brr, arr[2] == Point{})
	pp := &arr[1]
	pp.Y = 20
	fmt.Println(arr[1].X, arr[1].Y)
	ptrs := []*Point{}
	for i := 0; i < 3; i++ {
		ptrs = append(ptrs, &Point{i, i})
	}
	for _, pt := range ptrs {
		pt.Scale(2)
	}
	fmt.Println(ptrs[2].X, ptrs[1].Y)
	var np *Point
	fmt.Println(np == nil, r.Min == Point{1, 2})
	type anon struct {
		a int8
		b struct{ c, d uint16 }
	}
	var an anon
	an.b.d = 65535
	an.b.d++
	fmt.Println(an.a, an.b.c, an.b.d)
	defer func() { fmt.Println("recovered:", recover()) }()
	fmt.Println(np.X)
}
