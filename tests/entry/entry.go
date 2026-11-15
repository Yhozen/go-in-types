// An entry called on a machine at rest (codec-state callState): count runs
// after init, like ts-in-types' checkWarm on a boot image. It uses the
// maps.clone and slices.overlaps intrinsics (maps.Clone, slices.Insert).
// The test also starts it mid-call (codec-state startState).
package main

import (
	"maps"
	"slices"

	"gointypes/rt"
)

var table = map[string]int{"a": 1, "bb": 2}

// a float-keyed map on the heap (codec-map float keys)
var weights = map[float64]int{1.5: 3, -2: 4}

var calls []string

func count(s string) int {
	m := maps.Clone(table)
	m[s] = len(s)
	calls = append(calls, s)
	xs := []int{1, 2, 3}
	xs = slices.Insert(xs, 1, len(m))
	// ys shares xs's array (enough capacity): xs[1] becomes 7
	ys := slices.Insert(xs[:2], 1, 7)
	rt.Write(1, []byte("count "+s+"\n"))
	return weights[1.5]*1000 + xs[1]*100 + ys[1]*10 + len(table)
}

func main() {}
