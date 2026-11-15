package softfloat

import (
	"math"
	"math/rand"
	"testing"
)

func TestAgainstHardware(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	special := []float64{0, math.Copysign(0, -1), 1, -1, 0.5, 3, 1e300, -1e-300, math.Inf(1), math.Inf(-1), math.NaN(), 1 << 63, 1<<64 - 1024}
	vals := append([]float64{}, special...)
	for i := 0; i < 2000; i++ {
		vals = append(vals, math.Float64frombits(r.Uint64()), r.NormFloat64()*1e6)
	}
	b := math.Float64bits
	for i, x := range vals {
		y := vals[(i*7+3)%len(vals)]
		chk := func(name string, got, want uint64) {
			if got != want && !(math.IsNaN(math.Float64frombits(got)) && math.IsNaN(math.Float64frombits(want))) {
				t.Fatalf("%s(%v, %v) = %x, want %x", name, x, y, got, want)
			}
		}
		chk("add", Add64(b(x), b(y)), b(x+y))
		chk("sub", Sub64(b(x), b(y)), b(x-y))
		chk("mul", Mul64(b(x), b(y)), b(x*y))
		chk("div", Div64(b(x), b(y)), b(x/y))
		chk("min", Min64(b(x), b(y)), b(min(x, y)))
		chk("max", Max64(b(x), b(y)), b(max(x, y)))
		if Lt64(b(x), b(y)) != (x < y) || Le64(b(x), b(y)) != (x <= y) || Eq64(b(x), b(y)) != (x == y) || Ne64(b(x), b(y)) != (x != y) {
			t.Fatalf("compare %v %v", x, y)
		}
		fx, fy := float32(x), float32(y)
		c32 := func(name string, got uint32, want float32) {
			if got != math.Float32bits(want) && !(want != want) {
				t.Fatalf("%s32(%v, %v) = %x, want %x", name, fx, fy, got, math.Float32bits(want))
			}
		}
		c32("conv", F64to32(b(x)), fx)
		c32("add", Add32(math.Float32bits(fx), math.Float32bits(fy)), fx+fy)
		c32("sub", Sub32(math.Float32bits(fx), math.Float32bits(fy)), fx-fy)
		c32("mul", Mul32(math.Float32bits(fx), math.Float32bits(fy)), fx*fy)
		if math.Abs(x) < 1<<62 && !math.IsNaN(x) {
			if F64toInt64(b(x)) != int64(x) {
				t.Fatalf("toint %v", x)
			}
		}
		if x >= 0 && x < 1<<64 {
			if F64toUint64(b(x)) != uint64(x) {
				t.Fatalf("touint %v", x)
			}
		}
		n := int64(r.Uint64())
		chk("i2f", Int64to64(n), b(float64(n)))
		u := r.Uint64()
		chk("u2f", Uint64to64(u), b(float64(u)))
		if Uint64to32(u) != math.Float32bits(float32(u)) {
			t.Fatalf("u2f32 %v", u)
		}
	}
}
