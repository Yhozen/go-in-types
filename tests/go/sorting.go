package main

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

type person struct {
	name string
	age  int
}

type byAge []person

func (a byAge) Len() int           { return len(a) }
func (a byAge) Swap(i, j int)      { a[i], a[j] = a[j], a[i] }
func (a byAge) Less(i, j int) bool { return a[i].age < a[j].age }

func main() {
	people := []person{{"alice", 30}, {"bob", 25}, {"carol", 35}, {"dave", 25}}
	sort.Sort(byAge(people))
	for _, p := range people {
		fmt.Print(p.name, ":", p.age, " ")
	}
	fmt.Println()
	sort.SliceStable(people, func(i, j int) bool { return people[i].name > people[j].name })
	fmt.Println(people[0].name, people[3].name)
	xs := make([]int, 0)
	seed := uint32(12345)
	for i := 0; i < 50; i++ {
		seed = seed*1664525 + 1013904223
		xs = append(xs, int(seed>>16)%1000)
	}
	sort.Ints(xs)
	fmt.Println(xs[:10], sort.IntsAreSorted(xs), sort.SearchInts(xs, 500))
	words := strings.Fields("the quick brown fox jumps over the lazy dog")
	sort.Strings(words)
	fmt.Println(strings.Join(words, " "))
	n, err := strconv.Atoi("12345")
	fmt.Println(n+1, err)
	_, err = strconv.Atoi("12a")
	fmt.Println(err)
	i64, _ := strconv.ParseInt("-ff", 16, 64)
	u, err := strconv.ParseUint("300", 10, 8)
	fmt.Println(i64, u, err)
	fmt.Println(strconv.Itoa(-99), strconv.FormatInt(255, 2), strconv.Quote("a\"b"), strconv.QuoteRune('☺'))
	b, _ := strconv.ParseBool("true")
	s, err := strconv.Unquote(`"é\n"`)
	fmt.Println(b, s, err, strconv.AppendInt([]byte("x"), 42, 10))
}
