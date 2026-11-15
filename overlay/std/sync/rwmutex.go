// go-in-types overlay of package sync (Go 1.27.4): single-threaded. A
// program has one goroutine, so blocking where real sync would wait is a
// deadlock and panics. No runtime hooks, no atomics, no unsafe.

package sync

import _ "unsafe" // go:linkname

// An RWMutex is a reader/writer mutual exclusion lock (single-threaded).
type RWMutex struct {
	_       noCopy
	writer  bool
	readers int
}

func (rw *RWMutex) RLock() {
	if rw.writer {
		panic("sync: deadlock: RLock of write-locked RWMutex (single-threaded)")
	}
	rw.readers++
}

func (rw *RWMutex) TryRLock() bool {
	if rw.writer {
		return false
	}
	rw.readers++
	return true
}

func (rw *RWMutex) RUnlock() {
	if rw.readers <= 0 {
		stFatal("sync: RUnlock of unlocked RWMutex")
	}
	rw.readers--
}

func (rw *RWMutex) Lock() {
	if rw.writer || rw.readers > 0 {
		panic("sync: deadlock: Lock of locked RWMutex (single-threaded)")
	}
	rw.writer = true
}

func (rw *RWMutex) TryLock() bool {
	if rw.writer || rw.readers > 0 {
		return false
	}
	rw.writer = true
	return true
}

func (rw *RWMutex) Unlock() {
	if !rw.writer {
		stFatal("sync: Unlock of unlocked RWMutex")
	}
	rw.writer = false
}

// syscall_hasWaitingReaders: syscall.ForkLock pulls this by linkname.
//
//go:linkname syscall_hasWaitingReaders syscall.hasWaitingReaders
func syscall_hasWaitingReaders(rw *RWMutex) bool {
	return false
}

func (rw *RWMutex) RLocker() Locker {
	return (*rlocker)(rw)
}

type rlocker RWMutex

func (r *rlocker) Lock()   { (*RWMutex)(r).RLock() }
func (r *rlocker) Unlock() { (*RWMutex)(r).RUnlock() }
