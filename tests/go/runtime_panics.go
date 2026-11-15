package main

import "fmt"

type T struct{ x int }

func try(name string, f func()) {
	defer func() {
		r := recover()
		if e, ok := r.(error); ok {
			fmt.Println(name, "->", e.Error())
		} else {
			fmt.Println(name, "->", r)
		}
	}()
	f()
}

func main() {
	var s []int = []int{1, 2, 3}
	i, j := 5, 1
	var m map[string]int
	var p *T
	var a any = "x"
	var arr [4]int
	zero := 0
	try("index", func() { _ = s[i] })
	try("index-neg", func() { k := -1; _ = s[k] })
	try("slice", func() { _ = s[2:i] })
	try("slice-inv", func() { _ = s[2:j] })
	try("slice3", func() { _ = s[0:1:i] })
	try("string-index", func() { _ = "abc"[i] })
	try("string-slice", func() { _ = "abc"[i:] })
	try("array", func() { _ = arr[i] })
	try("nil-map", func() { m["a"] = 1 })
	try("nil-deref", func() { _ = p.x })
	try("assert", func() { _ = a.(int) })
	try("assert-iface", func() { _ = a.(fmt.Stringer) })
	try("div", func() { _ = 1 / zero })
	try("nil-func", func() { var f func(); f() })
	try("make-neg", func() { _ = make([]int, i-10) })
	try("custom", func() { panic(fmt.Errorf("custom %d", 9)) })
	try("arr-ptr", func() { _ = (*[5]int)(s) })
	fmt.Println("done")
	var q *T
	fmt.Println(q.x)
}
