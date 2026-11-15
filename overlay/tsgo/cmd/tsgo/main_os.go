//go:build !gointypes

// go-in-types overlay: the harness's native main. Files named on the command
// line are read from disk into the in-memory FS, then check runs (or boot
// and checkWarm, with $GOINTYPES_WARM).
package main

import (
	"gointypes/rt"
	"os"
	"path/filepath"
	rtdebug "runtime/debug"
	"strconv"
	"strings"
)

func main() {
	applyDebugStackLimit()
	args := os.Args[1:]
	files := map[string]string{}
	for _, a := range args {
		if !strings.HasPrefix(a, "-") && strings.HasSuffix(a, ".ts") {
			b, err := os.ReadFile(a)
			if err != nil {
				rt.Exit(3)
			}
			files["/p/"+filepath.Base(a)] = string(b)
		}
	}
	// GOINTYPES_WARM=<file>: boot with <file> as main.ts (output dropped),
	// then checkWarm the real main.ts: the boot image's path, natively.
	if w := os.Getenv("GOINTYPES_WARM"); w != "" { //nolint:forbidigo
		b, err := os.ReadFile(w)
		if err != nil {
			rt.Exit(3)
		}
		real := files[mainPath]
		files[mainPath] = string(b)
		bootQuiet(files, args)
		rt.Exit(checkWarm(real))
	}
	rt.Exit(check(files, args))
}

// applyDebugStackLimit is core.ApplyDebugStackLimit (removed from the core
// overlay so that core does not import os).
func applyDebugStackLimit() {
	v := os.Getenv("TS_GO_DEBUG_STACK_LIMIT") //nolint:forbidigo
	if v == "" {
		return
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return
	}
	rtdebug.SetMaxStack(n)
}
