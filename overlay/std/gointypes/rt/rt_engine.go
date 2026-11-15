//go:build gointypes

package rt

// Write writes b to fd 1 (stdout) or 2 (stderr). Engine intrinsic.
func Write(fd int, b []byte)

// Exit ends the program with the given status. Engine intrinsic.
func Exit(code int)
