package main

import (
	"fmt"
	"math"
	"strconv"
)

func main() {
	a, b := 0.1, 0.2
	fmt.Println(a+b, a*b, a/b, a-b, a+b == 0.3)
	var f32 float32 = 1.0 / 3.0
	fmt.Println(f32, float64(f32), f32*3, float32(16777217))
	fmt.Println(math.Inf(1), -math.Inf(1), math.NaN() == math.NaN(), math.MaxFloat64, math.SmallestNonzeroFloat64)
	z := 0.0
	fmt.Println(1/z, -1/z, z/z, math.Copysign(0, -1), 1/math.Copysign(0, -1))
	f1, f2, f3 := 3.99, -3.99, 255.0
	fmt.Println(int(f1), int(f2), int64(f1*1e17), uint8(f3), float64(1<<62), float64(-7)/2)
	fmt.Println(math.Floor(-2.5), math.Ceil(2.1), math.Trunc(-2.7), math.Abs(-3), math.Sqrt(16), math.Mod(7, 3))
	fmt.Println(math.Pow(2, 10), math.Exp(1), math.Log(math.E), math.Max(1, 2), math.Min(-0.0, 0), math.Hypot(3, 4))
	fmt.Printf("%f %.2f %8.3f %-8.1f| %e %E %g %G %v\n", math.Pi, math.Pi, math.Pi, math.Pi, 123456.789, 0.000123, 1e100, 1e-10, 100.0)
	fmt.Printf("%g %g %g %g %v %v\n", 1e20, 1e21, 123456789.0, 0.0001, float32(0.1), 2.5e-8)
	fmt.Println(strconv.FormatFloat(1.5, 'f', -1, 64), strconv.FormatFloat(1e21, 'g', -1, 64), strconv.FormatFloat(255, 'x', -1, 64))
	v, err := strconv.ParseFloat("3.14159e2", 64)
	fmt.Println(v, err)
	_, err = strconv.ParseFloat("abc", 64)
	fmt.Println(err)
	fmt.Println(math.Float64bits(1.0), math.Float64frombits(0x4000000000000000), math.Float32bits(1.5))
	x := 1.0
	for i := 0; i < 60; i++ {
		x = x*1.1 + 0.3
	}
	fmt.Println(x, x > 1e3, x < 1e3, x >= x, -x)
	var acc float64
	for i := 1; i <= 100; i++ {
		acc += 1 / float64(i)
	}
	fmt.Println(acc, math.IsNaN(acc), math.IsInf(1/z, 1), math.Signbit(-0.0*1))
	fmt.Println(uint64(float64(math.MaxUint32)*2), int32(float32(-2147483648)), float32(math.MaxFloat32)*float32(f3))
}
