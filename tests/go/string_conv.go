// string(x) for integers of every width, on run-time values: a valid rune
// encodes as UTF-8, anything else (negative, surrogate, beyond U+10FFFF) is
// U+FFFD.
package main

import "fmt"

func show(s string) {
	fmt.Println(len(s), []byte(s))
}

func i64(x int64) string    { return string(x) }
func u64(x uint64) string   { return string(x) }
func in(x int) string       { return string(x) }
func un(x uint) string      { return string(x) }
func i32(x int32) string    { return string(x) }
func u8(x uint8) string     { return string(x) }
func i16(x int16) string    { return string(x) }
func uptr(x uintptr) string { return string(x) }

func main() {
	for _, x := range []int64{0x4e16, -1, 0x10ffff, 0x110000, 0xd800, 0x100000041, 'A', -1 << 63} {
		show(i64(x))
		show(in(int(x)))
	}
	for _, x := range []uint64{1 << 63, 0x1f600, 0xffffffff, 0x7f} {
		show(u64(x))
		show(un(uint(x)))
		show(uptr(uintptr(x)))
	}
	show(i32(0x1f600))
	show(i32(-5))
	show(u8(200))
	show(i16(-2))
}
