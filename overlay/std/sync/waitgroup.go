// go-in-types overlay of package sync (Go 1.27.4): single-threaded. A
// program has one goroutine, so blocking where real sync would wait is a
// deadlock and panics. No runtime hooks, no atomics, no unsafe.

package sync

// A WaitGroup waits for a collection of tasks to finish (single-threaded:
// Go runs f at once).
type WaitGroup struct {
	noCopy noCopy
	n      int
}

func (wg *WaitGroup) Add(delta int) {
	wg.n += delta
	if wg.n < 0 {
		panic("sync: negative WaitGroup counter")
	}
}

func (wg *WaitGroup) Done() {
	wg.Add(-1)
}

func (wg *WaitGroup) Wait() {
	if wg.n != 0 {
		panic("sync: deadlock: WaitGroup.Wait with pending tasks (single-threaded)")
	}
}

// Go calls f synchronously (there are no goroutines).
func (wg *WaitGroup) Go(f func()) {
	wg.Add(1)
	defer wg.Done()
	f()
}
