package main

import "fmt"

func main() {
	for _, s := range []uint{0, 1, 7, 8, 15, 31, 32, 63, 64, 100} {
		fmt.Println(s, int8(-128)>>s, uint8(0x81)>>s, int8(1)<<s, int32(-1)<<s, int64(-5)>>s, uint64(1)<<s, uint32(0xffffffff)>>s)
	}
	var n int = 3
	fmt.Println(1<<n, -16>>n, uint16(1)<<(n*5))
	defer func() { fmt.Println("recovered:", recover()) }()
	n = -1
	fmt.Println(1 << n)
}
