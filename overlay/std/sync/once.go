// go-in-types overlay of package sync (Go 1.27.4): single-threaded. A
// program has one goroutine, so blocking where real sync would wait is a
// deadlock and panics. No runtime hooks, no atomics, no unsafe.

package sync

// Once performs exactly one action.
type Once struct {
	_       noCopy
	done    bool
	running bool
}

func (o *Once) Do(f func()) {
	if o.done {
		return
	}
	if o.running {
		panic("sync: deadlock: recursive Once.Do (single-threaded)")
	}
	o.running = true
	defer func() {
		o.done = true
		o.running = false
	}()
	f()
}
