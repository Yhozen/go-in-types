// Front-end test program: features that lower to traps (go, select,
// complex numbers, unsafe pointer arithmetic) and to soft-float calls.
package main

import "unsafe"

func worker(c chan int) { c <- 1 }

func worker2() string { return "seven" }

func main() {
	f := 1.5
	g := float32(f) * 2
	h := f/3 - float64(g)
	n := len(make([]int, len(worker2())))
	println(h < f, int(h), uint32(f), float64(n), -f, min(f, h, 2.5))

	if len("x") == 2 { // never true: the traps below are never reached
		c := make(chan int)
		go worker(c)
		select {
		case v := <-c:
			println(v)
		default:
		}
		z := complex(1, 2)
		println(real(z))
		var a [2]int
		p := unsafe.Pointer(&a[0])
		q := (*int)(unsafe.Pointer(uintptr(p) + 8))
		println(*q)
	}
	b := []byte("abc")
	s := unsafe.String(&b[0], len(b))
	bb := unsafe.Slice(unsafe.StringData(s), len(s))
	println(s, len(bb), unsafe.Sizeof(f))
}
