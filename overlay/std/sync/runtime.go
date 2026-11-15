// go-in-types overlay of package sync (Go 1.27.4): single-threaded. A
// program has one goroutine, so blocking where real sync would wait is a
// deadlock and panics. No runtime hooks, no atomics, no unsafe.

package sync

// stFatal reports an unrecoverable misuse (real sync: runtime fatal error).
func stFatal(s string) {
	panic("fatal error: " + s)
}
