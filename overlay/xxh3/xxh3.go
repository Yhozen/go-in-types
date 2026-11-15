// Package xxh3 is the go-in-types replacement for github.com/zeebo/xxh3
// v1.1.0: the same API, but no hashing at all. A Hasher collects the bytes
// written to it, and Sum128 interns them: the first distinct byte string
// (per seed) gets {0, 1}, the next {0, 2}, and so on, never zero. So equal
// inputs give equal values and different inputs different values (no
// collisions, unlike any real hash), at the cost of an append per write and
// one map lookup per sum. The values differ from real XXH3; typescript-go
// only uses them as map keys and identities on the check path (the
// checker's CacheHashKey), never orders by them or prints them, so its
// output is unchanged (checked natively on the corpus by
// scripts/tsgo-parity.ts). Values depend on the order of first use within
// the process, so they are not stable across processes and must not be
// persisted. Used through a go.mod replace directive (the module cache
// cannot be overlaid).
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

// interned maps each seed's byte strings to their values (Lo: 1, 2, ...).
var interned map[uint64]map[string]uint64

func intern(seed uint64, s string) Uint128 {
	if interned == nil {
		interned = map[uint64]map[string]uint64{}
	}
	m := interned[seed]
	if m == nil {
		m = map[string]uint64{}
		interned[seed] = m
	}
	v, ok := m[s]
	if !ok {
		v = uint64(len(m)) + 1
		m[s] = v
	}
	return Uint128{Lo: v}
}

// Hasher collects the bytes of a streaming "hash".
type Hasher struct {
	buf  []byte
	seed uint64
}

// Hasher128 is the same hasher, for the 128-bit API.
type Hasher128 = Hasher

func New() *Hasher { return new(Hasher) }

func NewSeed(seed uint64) *Hasher { return &Hasher{seed: seed} }

func New128() *Hasher                { return New() }
func NewSeed128(seed uint64) *Hasher { return NewSeed(seed) }

func (h *Hasher) Reset() { h.ResetSeed(0) }

func (h *Hasher) ResetSeed(seed uint64) {
	h.seed = seed
	h.buf = h.buf[:0]
}

func (h *Hasher) BlockSize() int { return 64 }
func (h *Hasher) Size() int      { return 8 }

func (h *Hasher) Write(buf []byte) (int, error) {
	h.buf = append(h.buf, buf...)
	return len(buf), nil
}

func (h *Hasher) WriteString(buf string) (int, error) {
	h.buf = append(h.buf, buf...)
	return len(buf), nil
}

func (h *Hasher) Sum128() Uint128 { return intern(h.seed, string(h.buf)) }

func (h *Hasher) Sum64() uint64 { return h.Sum128().Lo }

// Sum appends the 64-bit (Hasher) value to b, big-endian.
func (h *Hasher) Sum(b []byte) []byte {
	v := h.Sum64()
	return append(b, byte(v>>56), byte(v>>48), byte(v>>40), byte(v>>32), byte(v>>24), byte(v>>16), byte(v>>8), byte(v))
}

func Hash128(b []byte) Uint128                    { return intern(0, string(b)) }
func HashString128(s string) Uint128              { return intern(0, s) }
func Hash(b []byte) uint64                        { return Hash128(b).Lo }
func HashString(s string) uint64                  { return HashString128(s).Lo }
func HashSeed(b []byte, seed uint64) uint64       { return Hash128Seed(b, seed).Lo }
func HashStringSeed(s string, seed uint64) uint64 { return HashString128Seed(s, seed).Lo }

func Hash128Seed(b []byte, seed uint64) Uint128       { return intern(seed, string(b)) }
func HashString128Seed(s string, seed uint64) Uint128 { return intern(seed, s) }
