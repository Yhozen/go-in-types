// print and println of floats (runtime.printfloat: +d.dddddde+ddd), deferred
// prints of floats, and an unrecovered panic with a named float value.
package main

import "math"

type Celsius float64

type T32 float32

func show(v float64) {
	println(v)
}

func main() {
	println(1.5, -2.25, 0.0)
	var z float64
	println(z, -z, 1/z, -1/z, z/z)
	println(math.MaxFloat64, math.SmallestNonzeroFloat64, 1e300, 1e-300)
	println(0.1, 0.2, 0.1+0.2, 1.0/3, 2.0/3, 9.99999999, 9.9999994, 123456789.0)
	var f32 float32 = 0.1
	println(f32, float32(1)/3, float32(math.MaxFloat32), float32(1e-45))
	print(3.0, 4.0, "\n")
	print("mixed ", 7, " ", 7.5, " ", true, "\n")
	c := Celsius(36.6)
	println(c, T32(2.5))
	for i := 0; i < 5; i++ {
		show(float64(i) * 1.25e10)
	}
	x := 1.0
	for i := 0; i < 30; i++ {
		x *= -7.3
	}
	println(x)
	defer println("deferred", 2.5, float32(0.75))
	panic(Celsius(-40.125))
}
