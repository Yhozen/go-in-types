// panic(nil) panics with a *runtime.PanicNilError (Go 1.21+): recover
// returns it, and an unrecovered one prints its Error().
package main

import (
	"errors"
	"fmt"
)

func try(f func()) (r any) {
	defer func() { r = recover() }()
	f()
	return "no panic"
}

type runtimeError interface {
	error
	RuntimeError()
}

func main() {
	r := try(func() { panic(nil) })
	fmt.Println(r != nil)
	err, ok := r.(error)
	fmt.Println(ok, err)
	_, isRT := r.(runtimeError)
	fmt.Println("runtime error:", isRT)
	fmt.Printf("%T\n", r)
	var e error
	fmt.Println(try(func() { panic(e) }) != nil)
	var p *int
	fmt.Println(try(func() { panic(p) }) == p)
	fmt.Println(errors.Is(err, err))
	defer fmt.Println("deferred")
	panic(nil)
}
