//go:build gointypes_cover

// go-in-types: native coverage builds only (scripts/tsgo-reflect.ts). The
// counters are cleared when check starts, so the profile written at exit
// holds only what ran inside check (not package initializers or the file
// reading in main).
package main

import "runtime/coverage"

func init() {
	beforeCheck = func() {
		if err := coverage.ClearCounters(); err != nil {
			panic(err)
		}
	}
}
