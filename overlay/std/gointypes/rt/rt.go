// Package rt is the go-in-types runtime interface: the only I/O a program
// has. The front end treats Write and Exit as intrinsics (DESIGN.md); these
// bodies are the native implementation used by `go run -overlay`.
package rt

import "os"

// Write writes b to fd 1 (stdout) or 2 (stderr).
func Write(fd int, b []byte) {
	if fd == 2 {
		os.Stderr.Write(b)
	} else {
		os.Stdout.Write(b)
	}
}

// Exit ends the program with the given status.
func Exit(code int) {
	os.Exit(code)
}
