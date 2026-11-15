package main

import "fmt"

func classify(n int) string {
	switch {
	case n < 0:
		return "neg"
	case n == 0:
		return "zero"
	case n%2 == 0:
		return "even"
	default:
		return "odd"
	}
}

func sw(x int) {
	switch x {
	case 1, 2:
		fmt.Print("one-two ")
		fallthrough
	case 3:
		fmt.Print("three ")
	case 4:
		fmt.Print("four ")
		break
	default:
		fmt.Print("default ")
	}
	fmt.Println()
}

func main() {
	for _, n := range []int{-3, 0, 4, 7} {
		fmt.Print(classify(n), " ")
	}
	fmt.Println()
	for i := 1; i <= 5; i++ {
		sw(i)
	}
outer:
	for i := 0; i < 5; i++ {
		for j := 0; j < 5; j++ {
			if j == 3 {
				continue outer
			}
			if i == 3 {
				break outer
			}
			fmt.Print(i, j, " ")
		}
	}
	fmt.Println()
	i := 0
loop:
	if i < 5 {
		fmt.Print(i)
		i++
		goto loop
	}
	fmt.Println()
	n := 27
	steps := 0
	for n != 1 {
		if n%2 == 0 {
			n /= 2
		} else {
			n = 3*n + 1
		}
		steps++
	}
	fmt.Println("collatz", steps)
	k := 0
	for {
		k++
		if k > 10 {
			break
		}
	}
	fmt.Println(k)
	switch s := "go"; s + "lang" {
	case "golang":
		fmt.Println("matched", s)
	}
	var x any = 3.5
	switch x.(type) {
	case int:
		fmt.Println("int")
	case float64, float32:
		fmt.Println("float")
	}
	sum := 0
	for i := range 10 {
		if i%3 == 0 {
			continue
		}
		sum += i
	}
	fmt.Println(sum)
}
