package main

import "fmt"

func div(a, b int) (q int, err any) {
	defer func() { err = recover() }()
	return a / b, nil
}

func main() {
	pairs := [][2]int{{7, 2}, {-7, 2}, {7, -2}, {-7, -2}, {0, 5}, {1, 0}}
	for _, p := range pairs {
		q, err := div(p[0], p[1])
		fmt.Println(p[0], p[1], q, err)
	}
	var z uint8
	j := -1
	fmt.Println(uint8(200)/7, uint8(200)%7, int16(-32768)/int16(j))
	fmt.Println(5 % (z + 1))
	var m int64 = 0
	fmt.Println(10 % m)
}
