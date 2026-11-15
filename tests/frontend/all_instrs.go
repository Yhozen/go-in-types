// Front-end test program: together with the other files here it makes the
// front end emit every IR instruction kind (tests/frontend.test.ts checks).
// Uses only println so it needs no overlay.
package main

type Shape interface{ Area() int }
type Named interface {
	Shape
	Name() string
}

type Rect struct{ w, h int }

func (r Rect) Area() int     { return r.w * r.h }
func (r *Rect) Name() string { return "rect" }

type Celsius int

func pair(a, b int) (int, int) { return b, a }

func mk(w int) Rect { return Rect{w, w + 1} }

func pick(a [3]int, i int) int { return a[i] }

func apply(f func(int) int, x int) int { return f(x) }

func safeDiv(a, b int) (q int, err any) {
	defer func() {
		if r := recover(); r != nil {
			err = r
		}
	}()
	return a / b, nil
}

func main() {
	// alloc, store, load, fieldAddr, field, indexAddr, index
	r := &Rect{2, 3}
	r.w++
	v := *r
	arr := [3]int{1, 2, 3}
	idx := 1
	println(v.h, arr[idx], r.Area(), mk(idx).h, pick(arr, idx))

	// binop, unop, convert, changeType
	var x int32 = 7
	y := -x ^ 3
	b := !(x > y)
	c := Celsius(int(x))
	u := uint8(x) << 2
	println(y, b, c, u, int64(x)%3)

	// makeSlice, slice, sliceToArrayPtr, builtins
	s := make([]int, idx, idx+10)
	s = append(s, 4, 5)
	t := s[1:3:4]
	p := (*[2]int)(t)
	println(len(s), cap(t), p[0], min(idx, 3), max(2, idx))
	copy(s, t)

	// makeMap, mapUpdate, lookup (comma-ok), range/next over map, delete
	m := map[string]int{}
	m["a"] = 1
	m["b"] = 2
	n, ok := m["a"]
	sum := 0
	for k, val := range m {
		sum += len(k) + val
	}
	delete(m, "a")
	println(n, ok, sum, len(m))

	// range/next over a string
	for i, ch := range "héllo" {
		println(i, ch)
	}
	bs := []byte("hi")
	str := string(bs) + string(rune(65))
	println(str, str[idx])

	// makeChan, send, recv, close
	ch := make(chan int, 2)
	ch <- 1
	got, okc := <-ch
	close(ch)
	println(got, okc)

	// makeInterface, changeInterface, typeAssert, invoke
	var sh Shape = v
	var nm Named = r
	sh = nm
	if rr, ok := sh.(*Rect); ok {
		println(rr.w)
	}
	var e any = sh
	_ = e.(Shape)
	println(sh.Area(), nm.Name())

	// makeClosure, call through a value, extract, phi, if/jump
	k := 10
	add := func(z int) int { return z + k }
	q1, q2 := pair(apply(add, 1), 2)
	acc := 0
	for i := 0; i < 3; i++ {
		acc += i
	}
	f := pair
	println(q1, q2, acc, f != nil)

	// defer, recover, runDefers, panic
	_, err := safeDiv(1, 0)
	println(err != nil)
	defer println("deferred")
	if acc > 100 {
		panic("big")
	}
}
