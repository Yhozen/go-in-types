// go-in-types overlay of package sync (Go 1.27.4): single-threaded. A
// program has one goroutine, so blocking where real sync would wait is a
// deadlock and panics. No runtime hooks, no atomics, no unsafe.

package sync

// A Mutex is a mutual exclusion lock (single-threaded).
type Mutex struct {
	_      noCopy
	locked bool
}

// A Locker represents an object that can be locked and unlocked.
type Locker interface {
	Lock()
	Unlock()
}

func (m *Mutex) Lock() {
	if m.locked {
		panic("sync: deadlock: Lock of locked Mutex (single-threaded)")
	}
	m.locked = true
}

func (m *Mutex) TryLock() bool {
	if m.locked {
		return false
	}
	m.locked = true
	return true
}

func (m *Mutex) Unlock() {
	if !m.locked {
		stFatal("sync: unlock of unlocked mutex")
	}
	m.locked = false
}
