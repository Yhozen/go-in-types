// Package xxh3 is the go-in-types replacement for github.com/zeebo/xxh3
// v1.1.0: the same API, but a small pure-Go hash (two 64-bit lanes,
// byte-wise, no assembly, no unsafe, no 64x64->128 multiplies). The values
// differ from real XXH3; typescript-go only uses them as map keys and
// identities, so its output is unchanged (checked natively on the corpus by
// scripts/tsgo-parity.ts). Used through a go.mod replace directive (the
// module cache cannot be overlaid).
package xxh3

// Uint128 is a 128 bit value: u.Hi<<64 | u.Lo.
type Uint128 struct {
	Hi, Lo uint64
}

// Bytes returns the uint128 as big-endian bytes.
func (u Uint128) Bytes() [16]byte {
	return [16]byte{
		byte(u.Hi >> 0x38), byte(u.Hi >> 0x30), byte(u.Hi >> 0x28), byte(u.Hi >> 0x20),
		byte(u.Hi >> 0x18), byte(u.Hi >> 0x10), byte(u.Hi >> 0x08), byte(u.Hi),
		byte(u.Lo >> 0x38), byte(u.Lo >> 0x30), byte(u.Lo >> 0x28), byte(u.Lo >> 0x20),
		byte(u.Lo >> 0x18), byte(u.Lo >> 0x10), byte(u.Lo >> 0x08), byte(u.Lo),
	}
}

const (
	offsetA = 0xcbf29ce484222325 // FNV-1a 64 offset basis
	primeA  = 0x100000001b3      // FNV-1a 64 prime
	offsetB = 0x84222325cbf29ce4
	primeB  = 0x9e3779b97f4a7c15 // golden ratio
)

// Hasher computes a streaming hash.
type Hasher struct {
	a, b, n uint64
	seed    uint64
}

// Hasher128 is the same hasher, for the 128-bit API.
type Hasher128 = Hasher

func New() *Hasher {
	h := new(Hasher)
	h.Reset()
	return h
}

func NewSeed(seed uint64) *Hasher {
	h := new(Hasher)
	h.ResetSeed(seed)
	return h
}

func New128() *Hasher                { return New() }
func NewSeed128(seed uint64) *Hasher { return NewSeed(seed) }

func (h *Hasher) Reset() { h.ResetSeed(0) }

func (h *Hasher) ResetSeed(seed uint64) {
	h.seed = seed
	h.a = offsetA ^ seed
	h.b = offsetB + seed
	h.n = 0
}

func (h *Hasher) BlockSize() int { return 64 }
func (h *Hasher) Size() int      { return 8 }

func (h *Hasher) step(c byte) {
	if h.a == 0 && h.b == 0 && h.n == 0 && h.seed == 0 {
		// Zero Hasher (declared, not made with New): start like Reset.
		h.a, h.b = offsetA, offsetB
	}
	h.a = (h.a ^ uint64(c)) * primeA
	h.b = (h.b + uint64(c) + 1) * primeB
	h.b ^= h.b >> 29
	h.n++
}

func (h *Hasher) Write(buf []byte) (int, error) {
	for _, c := range buf {
		h.step(c)
	}
	return len(buf), nil
}

func (h *Hasher) WriteString(buf string) (int, error) {
	for i := 0; i < len(buf); i++ {
		h.step(buf[i])
	}
	return len(buf), nil
}

func mix(x uint64) uint64 {
	x ^= x >> 33
	x *= 0xff51afd7ed558ccd
	x ^= x >> 33
	x *= 0xc4ceb9fe1a85ec53
	x ^= x >> 33
	return x
}

func (h *Hasher) Sum128() Uint128 {
	a, b := h.a, h.b
	if a == 0 && b == 0 && h.n == 0 && h.seed == 0 {
		a, b = offsetA, offsetB
	}
	lo := mix(a ^ h.n)
	hi := mix(b + lo)
	return Uint128{Hi: hi, Lo: lo}
}

func (h *Hasher) Sum64() uint64 { return h.Sum128().Lo }

// Sum appends the 64-bit (Hasher) hash to b, big-endian.
func (h *Hasher) Sum(b []byte) []byte {
	v := h.Sum64()
	return append(b, byte(v>>56), byte(v>>48), byte(v>>40), byte(v>>32), byte(v>>24), byte(v>>16), byte(v>>8), byte(v))
}

func Hash128(b []byte) Uint128                    { return Hash128Seed(b, 0) }
func HashString128(s string) Uint128              { return HashString128Seed(s, 0) }
func Hash(b []byte) uint64                        { return Hash128(b).Lo }
func HashString(s string) uint64                  { return HashString128(s).Lo }
func HashSeed(b []byte, seed uint64) uint64       { return Hash128Seed(b, seed).Lo }
func HashStringSeed(s string, seed uint64) uint64 { return HashString128Seed(s, seed).Lo }

func Hash128Seed(b []byte, seed uint64) Uint128 {
	var h Hasher
	h.ResetSeed(seed)
	h.Write(b)
	return h.Sum128()
}

func HashString128Seed(s string, seed uint64) Uint128 {
	var h Hasher
	h.ResetSeed(seed)
	h.WriteString(s)
	return h.Sum128()
}
