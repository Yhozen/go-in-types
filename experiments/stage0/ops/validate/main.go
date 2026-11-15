// Command validate is a hand-checkable program for the counter: see
// ../README.md for the expected per-phase counts derived from its SSA.
package main

//go:noinline
func Mark(name string) {}

type shape interface{ area() int }

type sq struct{ n int }

func (s sq) area() int { return s.n * s.n }

func main() {
	Mark("loop")
	s := 0
	for i := 0; i < 10; i++ {
		s += i
	}
	Mark("calls")
	var sh shape = sq{3}
	t := 0
	for range 4 {
		t += sh.area()
	}
	Mark("map")
	m := map[string]int{}
	m["a"] = s
	m["b"] = t
	Mark("end")
	println(s, t, len(m))
}
