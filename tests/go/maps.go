package main

import (
	"fmt"
	"sort"
)

type key struct {
	a int
	b string
}

func main() {
	m := map[string]int{}
	words := []string{"b", "a", "c", "a", "b", "a"}
	for _, w := range words {
		m[w]++
	}
	fmt.Println(m, len(m))
	v, ok := m["z"]
	fmt.Println(v, ok)
	delete(m, "a")
	delete(m, "nope")
	keys := make([]string, 0)
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	fmt.Println(keys)
	sm := map[key][]int{}
	sm[key{1, "x"}] = append(sm[key{1, "x"}], 1)
	sm[key{1, "x"}] = append(sm[key{1, "x"}], 2)
	sm[key{2, "x"}] = nil
	fmt.Println(len(sm), sm[key{1, "x"}], sm[key{3, ""}] == nil)
	am := map[[2]int8]bool{{1, 2}: true}
	fmt.Println(am[[2]int8{1, 2}], am[[2]int8{2, 1}])
	pm := map[*int]string{}
	x, y := 1, 1
	pm[&x] = "x"
	pm[&y] = "y"
	fmt.Println(len(pm), pm[&x], pm[&y])
	var nm map[string]int
	fmt.Println(nm["a"], len(nm))
	im := map[int]int{}
	for i := 0; i < 1000; i++ {
		im[i%37] += i
	}
	sum := 0
	for k, v := range im {
		sum += k * v
	}
	fmt.Println(len(im), sum)
	clear(im)
	fmt.Println(len(im))
	defer func() { fmt.Println("recovered:", recover()) }()
	nm["boom"] = 1
}
