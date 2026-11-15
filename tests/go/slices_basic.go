package main

import "fmt"

func main() {
	var s []int
	fmt.Println(s == nil, len(s), cap(s))
	for i := 0; i < 20; i++ {
		s = append(s, i*i)
	}
	fmt.Println(len(s), s)
	t := s[2:5]
	t[0] = -1
	fmt.Println(s[2], len(t), cap(t) == cap(s)-2)
	u := s[2:5:6]
	u = append(u, 100)
	fmt.Println(s[5], len(u), cap(u))
	u = append(u, 200)
	u[0] = 999
	fmt.Println(s[2], u)
	c := make([]int, 3, 10)
	n := copy(c, s)
	fmt.Println(n, c, copy(s, []int{}))
	b := make([]byte, 5)
	fmt.Println(copy(b, "hello world"), string(b))
	o := []int{1, 2, 3, 4, 5}
	copy(o[1:], o)
	fmt.Println(o)
	m := [][]string{{"a"}, {"b", "c"}, nil}
	m[2] = append(m[2], "d")
	fmt.Println(m, len(m[1]))
	s = append(s[:3], s[10:]...)
	fmt.Println(len(s), s)
	clear(o)
	fmt.Println(o, min(3, 1, 2), max(2.5, 1.0), min("b", "a"))
	arr := [5]int{1, 2, 3}
	p := arr[:]
	p[4] = 9
	fmt.Println(arr[4], len(arr))
	ap := (*[3]int)(p)
	ap[1] = 7
	fmt.Println(arr[1])
}
