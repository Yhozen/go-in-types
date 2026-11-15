// == and != on structs, arrays and interfaces holding floats follow float
// semantics (NaN != NaN, +0 == -0), not bit patterns.
package main

import (
	"fmt"
	"math"
)

type P struct {
	X, Y float64
}

type Q struct {
	N int
	F float32
}

type Nest struct {
	Ps [2]P
	S  string
}

func main() {
	nan := math.NaN()
	negz := math.Copysign(0, -1)
	a, b := P{nan, 1}, P{nan, 1}
	fmt.Println("nan struct", a == b, a != b, a == a)
	c, d := P{0, 1}, P{negz, 1}
	fmt.Println("zero struct", c == d, c != d)
	arr1, arr2 := [2]float64{nan, 0}, [2]float64{nan, 0}
	fmt.Println("nan array", arr1 == arr2)
	arr3, arr4 := [2]float64{1, negz}, [2]float64{1, 0}
	fmt.Println("zero array", arr3 == arr4)
	var i1, i2 any = nan, nan
	fmt.Println("nan iface", i1 == i2, i1 != i2)
	var i3, i4 any = 0.0, negz
	fmt.Println("zero iface", i3 == i4)
	var f1, f2 any = float32(negz), float32(0)
	fmt.Println("zero iface32", f1 == f2)
	var j1, j2 any = a, b
	fmt.Println("nan struct iface", j1 == j2)
	var j3, j4 any = c, d
	fmt.Println("zero struct iface", j3 == j4)
	q1, q2 := Q{1, float32(negz)}, Q{1, 0}
	fmt.Println("float32 field", q1 == q2)
	q3, q4 := Q{1, float32(nan)}, Q{1, float32(nan)}
	fmt.Println("float32 nan field", q3 == q4)
	n1, n2 := Nest{[2]P{{1, negz}, {2, 3}}, "s"}, Nest{[2]P{{1, 0}, {2, 3}}, "s"}
	fmt.Println("nested", n1 == n2)
	n2.Ps[1].Y = nan
	n1.Ps[1].Y = nan
	fmt.Println("nested nan", n1 == n2)
	fmt.Println("bits differ", math.Float64bits(0) != math.Float64bits(negz))
}
