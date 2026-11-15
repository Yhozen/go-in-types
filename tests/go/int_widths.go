package main

import "fmt"

func main() {
	var i8 int8 = 127
	i8++
	var u8 uint8 = 0
	u8--
	var i16 int16 = -32768
	i16--
	var u16 uint16 = 65535
	u16 += 2
	var i32 int32 = 2147483647
	i32 += 10
	var u32 uint32 = 1 << 31
	u32 *= 2
	var i64 int64 = 9223372036854775807
	i64++
	var u64 uint64 = 0
	u64 -= 1
	fmt.Println(i8, u8, i16, u16, i32, u32, i64, u64)
	var a int8 = -100
	var b int8 = 100
	fmt.Println(a*3, b*b, a-b, -a, ^a, ^uint8(a))
	x := int32(-7)
	fmt.Println(x/2, x%2, -x/2, x%-3, uint32(x)/3, uint32(x)%5)
	min := int64(-9223372036854775808)
	fmt.Println(min/-1, min%-1, -min)
	c300, cm1, c70k, cm2 := 300, int16(-1), 70000, int8(-2)
	fmt.Println(int8(c300), uint8(cm1), int16(c70k), uint32(cm2), int64(uint32(c70k)<<20), uint64(int32(cm1)))
	fmt.Println(int(int8(-128))*int(int8(-128)), uint16(c70k)*uint16(c70k))
	fmt.Printf("%x %X %o %b %d\n", uint64(0xdeadbeefcafe), int32(-255), 8, 5, -0)
}
