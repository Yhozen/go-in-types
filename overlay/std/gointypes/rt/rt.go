// Package rt is the go-in-types runtime interface: the only I/O a program
// has. The front end treats Write and Exit as intrinsics (DESIGN.md).
//
// Two builds: rt_os.go (default) implements them natively with package os,
// for `go run -overlay`; rt_engine.go (build tag gointypes, set by the front
// end) only declares them, so the engine's program does not import os.
package rt
