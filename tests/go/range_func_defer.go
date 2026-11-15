// defer inside range-over-func bodies: the deferred calls go onto the
// enclosing function's frame and run when it returns or panics.
package main

import "fmt"

func seq(n int) func(func(int) bool) {
	return func(yield func(int) bool) {
		for i := 0; i < n; i++ {
			if !yield(i) {
				return
			}
		}
	}
}

func pairs(n int) func(func(int, string) bool) {
	return func(yield func(int, string) bool) {
		for i := 0; i < n; i++ {
			if !yield(i, fmt.Sprint("p", i)) {
				return
			}
		}
	}
}

// Only the loop bodies defer: the parent has no defer statement of its own.
func onlyBodies() {
	for i := range seq(3) {
		defer fmt.Println("body defer", i)
	}
	fmt.Println("onlyBodies returns")
}

func nested() {
	defer fmt.Println("outer first")
	for i := range seq(2) {
		for k, v := range pairs(2) {
			defer fmt.Println("inner", i, k, v)
		}
		defer fmt.Println("middle", i)
	}
	fmt.Println("nested returns")
}

func breakEarly() int {
	n := 0
	for i := range seq(10) {
		defer func() { n += i }()
		if i == 3 {
			break
		}
	}
	return n
}

func namedResult() (r int) {
	defer func() { r *= 10 }()
	for i := range seq(4) {
		defer func() { r += i }()
	}
	return 1
}

func recovers() (msg string) {
	defer func() {
		if e := recover(); e != nil {
			msg = fmt.Sprint("recovered: ", e)
		}
	}()
	for i := range seq(5) {
		defer fmt.Println("unwinding", i)
		if i == 2 {
			panic(fmt.Sprint("at ", i))
		}
	}
	return "no panic"
}

func recur(d int) {
	if d == 0 {
		return
	}
	for i := range seq(2) {
		defer fmt.Println("depth", d, "i", i)
		if i == 0 {
			recur(d - 1)
		}
	}
}

func main() {
	onlyBodies()
	nested()
	fmt.Println(breakEarly())
	fmt.Println(namedResult())
	fmt.Println(recovers())
	recur(2)
}
