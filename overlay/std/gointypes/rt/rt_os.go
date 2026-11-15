//go:build !gointypes

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
