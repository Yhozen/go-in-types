// Copyright 2013 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

// Overlay for the counting interpreter (go-in-types stage 0): a
// single-goroutine Pool, a LIFO free list. The real one indexes per-P
// arrays through unsafe.Pointer arithmetic.

package sync

import _ "unsafe" // for go:linkname

type Pool struct {
	noCopy noCopy

	items []any

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

func runtime_randn(n uint32) uint32

func runtime_registerPoolCleanup(cleanup func())
func runtime_procPin() int
func runtime_procUnpin()
