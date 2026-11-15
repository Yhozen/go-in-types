//go:build !gointypes

// go-in-types overlay: the harness's native main. Files named on the command
// line are read from disk into the in-memory FS, then check runs.
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
