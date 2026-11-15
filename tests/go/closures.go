package main

import "fmt"

func counter() (func() int, func()) {
	n := 0
	return func() int { n++; return n }, func() { n = 100 }
}

func apply(xs []int, f func(int) int) []int {
	out := make([]int, len(xs))
	for i, x := range xs {
		out[i] = f(x)
	}
	return out
}

func fib() func() int {
	a, b := 0, 1
	return func() int {
		r := a
		a, b = b, a+b
		return r
	}
}

func main() {
	inc, reset := counter()
	fmt.Println(inc(), inc(), inc())
	reset()
	fmt.Println(inc())
	k := 3
	fmt.Println(apply([]int{1, 2, 3}, func(x int) int { return x * k }))
	var fs []func() int
	for i := 0; i < 3; i++ {
		fs = append(fs, func() int { return i * 10 })
	}
	for _, f := range fs {
		fmt.Print(f(), " ")
	}
	fmt.Println()
	f := fib()
	for i := 0; i < 10; i++ {
		fmt.Print(f(), " ")
	}
	fmt.Println()
	var rec func(int) int
	rec = func(n int) int {
		if n <= 1 {
			return 1
		}
		return n * rec(n-1)
	}
	fmt.Println(rec(10))
	func() {
		k++
	}()
	fmt.Println(k)
	var nf func()
	fmt.Println(nf == nil)
	seq := func(yield func(int) bool) {
		for i := 0; i < 5; i++ {
			if !yield(i * i) {
				return
			}
		}
	}
	for v := range seq {
		if v > 9 {
			break
		}
		fmt.Print(v, " ")
	}
	fmt.Println()
	for i := range 3 {
		fmt.Print(i)
	}
	fmt.Println()
}
