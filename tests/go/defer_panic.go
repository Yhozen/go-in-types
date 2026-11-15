package main

import (
	"errors"
	"fmt"
)

func order() {
	for i := 0; i < 3; i++ {
		defer fmt.Print(i, " ")
	}
	fmt.Print("body ")
}

func named() (r int) {
	defer func() { r *= 2 }()
	return 21
}

func safe(f func()) (msg string) {
	defer func() {
		if r := recover(); r != nil {
			msg = fmt.Sprint("caught: ", r)
		}
	}()
	f()
	return "ok"
}

type MyErr struct{ code int }

func (e *MyErr) Error() string { return fmt.Sprintf("myerr %d", e.code) }

func nested() (s string) {
	defer func() {
		r := recover()
		s = fmt.Sprint("outer got ", r)
	}()
	defer func() {
		r := recover()
		panic(fmt.Sprint("re-", r))
	}()
	panic("first")
}

func main() {
	order()
	fmt.Println()
	fmt.Println(named())
	fmt.Println(safe(func() {}))
	fmt.Println(safe(func() { panic("boom") }))
	fmt.Println(safe(func() { panic(errors.New("err value")) }))
	fmt.Println(safe(func() { panic(&MyErr{7}) }))
	fmt.Println(safe(func() { panic(42) }))
	fmt.Println(safe(func() {
		var a []int
		i := 3
		_ = a[i]
	}))
	fmt.Println(nested())
	fmt.Println(recover())
	func() {
		defer func() {
			fmt.Println("deferred in panicking frame")
		}()
		defer fmt.Println("second deferred")
	}()
	err := fmt.Errorf("ctx: %w", &MyErr{3})
	me, ok := errors.AsType[*MyErr](err)
	fmt.Println(err, ok, me.code)
	defer fmt.Println("deferred before fatal panic")
	panic(fmt.Sprintf("final %d", 1))
}
