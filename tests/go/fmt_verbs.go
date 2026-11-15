package main

import (
	"errors"
	"fmt"
)

type S struct{ n int }

func (s S) String() string { return fmt.Sprintf("S<%d>", s.n) }

type E struct{}

func (E) Error() string { return "E!" }

type F int

func (f F) Format(st fmt.State, verb rune) {
	w, ok := st.Width()
	fmt.Fprintf(st, "F[%c %d %v %v]", verb, int(f), w, ok)
}

func main() {
	fmt.Printf("%d|%5d|%-5d|%05d|%+d|% d|%x|%#x|%o|%#o|%b\n", 42, 42, 42, 42, 42, 42, 3054, 3054, 8, 8, 10)
	fmt.Printf("%s|%10s|%-10s|%q|%v|%x|%X|% X\n", "go", "go", "go", "go\n", "go", "go", "go", "go")
	fmt.Printf("%t|%v|%5t\n", true, false, true)
	fmt.Printf("%c|%q|%U|%#U\n", 'G', 'G', 'G', '世')
	fmt.Printf("%*d|%-*d|%.*s|%*s\n", 6, 7, 6, 7, 2, "abcdef", -4, "x")
	fmt.Printf("%v|%s|%d\n", S{1}, S{2}, S{3}.n)
	fmt.Printf("%v|%s|%q\n", E{}, error(E{}), E{})
	fmt.Printf("%v|%6d\n", F(5), F(6))
	fmt.Printf("%v %v %v\n", []string{"a", "b"}, []int{}, []any{1, "x", nil, S{4}})
	fmt.Printf("%v %v\n", map[string]int{"z": 1, "a": 2}, map[int]string{3: "c", 1: "a"})
	fmt.Printf("%T %T %T %T %T\n", 1, "s", 2.0, []int{}, nil)
	fmt.Printf("%d %s\n", "str", 5)
	fmt.Printf("%d\n")
	fmt.Printf("%d %d\n", 1, 2, 3)
	fmt.Printf("%!|%%|%z\n", 1)
	fmt.Printf("%[2]d %[1]d\n", 1, 2)
	fmt.Println(fmt.Sprint("a", 1, 2, "b", "c", 3.0), fmt.Sprintln("x", 1))
	err := fmt.Errorf("outer: %w", E{})
	fmt.Println(err, errors.Is(err, E{}), errors.Unwrap(err) == E{})
	e2 := fmt.Errorf("two: %w + %w", E{}, errors.New("n"))
	fmt.Println(e2, errors.Is(e2, E{}))
	n, err := fmt.Printf("%s\n", "count")
	fmt.Println(n, err)
	fmt.Printf("%v %v %v %v\n", int8(-5), uint16(7), int64(-1<<63), uint64(1<<64-1))
	fmt.Printf("%x %X %x\n", -255, []byte{1, 171}, "\xff")
	fmt.Printf("%6.2f|%-8.3e|%g|%.3g|%+.1f\n", 3.14159, 1234.5678, 0.000001234, 1234567.0, 2.25)
	fmt.Printf("%08.3f|%x|%.0f|%.0f\n", -3.14159, 1.0, 0.5, 1.5)
	fmt.Printf("%s %v\n", []byte("raw"), []byte("raw"))
	fmt.Printf("%q\n", []string{"a b", "c"})
	h := [16]byte{0xde, 0xad, 1}
	fmt.Printf("%x %v %T\n", h, h, h)
}
