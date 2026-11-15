// An entry called on a machine at rest (codec-state callState): count runs
// after init, like ts-in-types' checkWarm on a boot image. It uses the
// maps.clone and slices.overlaps intrinsics (maps.Clone, slices.Insert).
package main

import (
	"maps"
	"slices"

	"gointypes/rt"
)

var table = map[string]int{"a": 1, "bb": 2}

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
	return xs[1]*100 + ys[1]*10 + len(table)
}

func main() {}
