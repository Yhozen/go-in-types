//go:build gointypes

// go-in-types overlay: the harness's main in the engine's program. A host
// calls check directly (node scripts/run.ts prog.json --check "ARGS"), so
// main has nothing to do and the program does not import os.
package main

func main() {}
