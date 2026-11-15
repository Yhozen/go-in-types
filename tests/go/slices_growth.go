package main

import "fmt"

// sink makes every slice escape to the heap: cap() of a non-escaping slice
// depends on the Go compiler's stack buffers (e.g. 32 bytes), not on growslice.
var sink []any

func keep(v any) { sink = append(sink, v) }

func main() {
	// cap growth is part of observable behaviour (aliasing after append).
	var s []int
	last := -1
	for i := 0; i < 2000; i++ {
		s = append(s, i)
		keep(s)
		if cap(s) != last {
			last = cap(s)
			fmt.Print(cap(s), " ")
		}
	}
	fmt.Println()
	var b []byte
	last = -1
	for i := 0; i < 3000; i++ {
		b = append(b, 'x')
		keep(b)
		if cap(b) != last {
			last = cap(b)
			fmt.Print(cap(b), " ")
		}
	}
	fmt.Println()
	type big struct{ a, b, c int64 }
	var g []big
	last = -1
	for i := 0; i < 300; i++ {
		g = append(g, big{})
		keep(g)
		if cap(g) != last {
			last = cap(g)
			fmt.Print(cap(g), " ")
		}
	}
	fmt.Println()
	x := append([]int{1, 2, 3}, 4, 5, 6, 7)
	fmt.Println(len(x), cap(x))
	y := append([]string(nil), "a")
	fmt.Println(len(y), cap(y))
	z := append(make([]int32, 5), make([]int32, 7)...)
	keep(x)
	keep(y)
	keep(z)
	fmt.Println(len(z), cap(z))
}
