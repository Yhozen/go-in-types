// math/rand/v2's ChaCha8 generator: internal/chacha8rand.block (an engine
// intrinsic) must match Go's assembly/generic block function exactly.
package main

import (
	"fmt"
	"math/rand/v2"
)

func main() {
	var seed [32]byte
	for i := range seed {
		seed[i] = byte(i*7 + 1)
	}
	c := rand.NewChaCha8(seed)
	for i := 0; i < 5; i++ {
		fmt.Println(c.Uint64())
	}
	// Past several refills and a reseed (ctrMax).
	var sum uint64
	for i := 0; i < 20000; i++ {
		sum += c.Uint64()
	}
	fmt.Println(sum)
	r := rand.New(rand.NewChaCha8([32]byte{}))
	fmt.Println(r.IntN(1000), r.IntN(1000), r.Float64() < 1)
	b := make([]byte, 10)
	c.Read(b)
	fmt.Println(b)
}
