package main

import (
	"cmp"
	"fmt"
	"slices"
	"strings"
)

type Number interface {
	~int | ~int8 | ~int64 | ~uint16 | ~float64
}

func Sum[T Number](xs []T) T {
	var s T
	for _, x := range xs {
		s += x
	}
	return s
}

func Map[T, U any](xs []T, f func(T) U) []U {
	out := make([]U, 0, len(xs))
	for _, x := range xs {
		out = append(out, f(x))
	}
	return out
}

type Stack[T any] struct{ items []T }

func (s *Stack[T]) Push(x T) { s.items = append(s.items, x) }
func (s *Stack[T]) Pop() (T, bool) {
	var zero T
	if len(s.items) == 0 {
		return zero, false
	}
	x := s.items[len(s.items)-1]
	s.items = s.items[:len(s.items)-1]
	return x, true
}

type Pair[K comparable, V any] struct {
	Key K
	Val V
}

func MaxBy[T any, K cmp.Ordered](xs []T, key func(T) K) T {
	best := xs[0]
	for _, x := range xs[1:] {
		if key(x) > key(best) {
			best = x
		}
	}
	return best
}

type MyInt int8

func main() {
	fmt.Println(Sum([]int{1, 2, 3}), int8(Sum([]MyInt{100, 27, 1})), Sum([]uint16{65535, 2}), Sum([]float64{0.5, 0.25}))
	fmt.Println(Map([]int{1, 2, 3}, func(i int) string { return strings.Repeat("*", i) }))
	var s Stack[string]
	s.Push("a")
	s.Push("b")
	x, ok := s.Pop()
	y, _ := s.Pop()
	_, ok2 := s.Pop()
	fmt.Println(x, ok, y, ok2)
	ps := []Pair[string, int]{{"a", 3}, {"b", 9}, {"c", 1}}
	fmt.Println(MaxBy(ps, func(p Pair[string, int]) int { return p.Val }).Key)
	xs := []int{5, 2, 8, 1, 9, 3}
	slices.Sort(xs)
	idx, found := slices.BinarySearch(xs, 8)
	fmt.Println(xs, idx, found, slices.Index(xs, 3), slices.Contains(xs, 7), slices.Max(xs))
	slices.SortFunc(ps, func(a, b Pair[string, int]) int { return cmp.Compare(b.Val, a.Val) })
	fmt.Println(ps[0].Key, ps[1].Key, ps[2].Key)
	r := slices.Clone(xs)
	slices.Reverse(r)
	fmt.Println(r, cmp.Compare("a", "b"), slices.Equal(r, xs))
}
