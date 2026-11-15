// go-in-types overlay of package sync (Go 1.27.4): single-threaded. A
// program has one goroutine, so blocking where real sync would wait is a
// deadlock and panics. No runtime hooks, no atomics, no unsafe.

package sync

// A Pool is a set of temporary objects (single-threaded: a stack).
type Pool struct {
	noCopy noCopy
	items  []any

	// New optionally specifies a function to generate
	// a value when Get would otherwise return nil.
	New func() any
}

func (p *Pool) Put(x any) {
	if x == nil {
		return
	}
	p.items = append(p.items, x)
}

func (p *Pool) Get() any {
	if n := len(p.items); n > 0 {
		x := p.items[n-1]
		p.items[n-1] = nil
		p.items = p.items[:n-1]
		return x
	}
	if p.New != nil {
		return p.New()
	}
	return nil
}
