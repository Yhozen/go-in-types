//go:build gointypes_cover

// go-in-types: native coverage builds only (scripts/tsgo-reflect.ts). When
// check starts, the counters so far (package initializers, reading the
// files in main) are written to $GOINTYPES_COVER_BEFORE; the profile written
// at exit minus that one is what ran inside check.
package main

import (
	"os"
	"runtime/coverage"
)

func init() {
	beforeCheck = func() {
		if dir := os.Getenv("GOINTYPES_COVER_BEFORE"); dir != "" {
			if err := coverage.WriteCountersDir(dir); err != nil {
				panic(err)
			}
		}
	}
}
