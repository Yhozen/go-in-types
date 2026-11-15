// go-in-types overlay of package sync (Go 1.27.4): single-threaded. A
// program has one goroutine, so blocking where real sync would wait is a
// deadlock and panics. No runtime hooks, no atomics, no unsafe.

package sync

// Cond is a condition variable (single-threaded: Wait deadlocks).
type Cond struct {
	noCopy noCopy
	L      Locker
}

func NewCond(l Locker) *Cond {
	return &Cond{L: l}
}

func (c *Cond) Wait() {
	panic("sync: deadlock: Cond.Wait (single-threaded)")
}

func (c *Cond) Signal()    {}
func (c *Cond) Broadcast() {}

// noCopy may be added to structs which must not be copied (go vet).
type noCopy struct{}

func (*noCopy) Lock()   {}
func (*noCopy) Unlock() {}
