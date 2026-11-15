// Copyright 2024 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

// Overlay for the counting interpreter (go-in-types stage 0): a
// single-goroutine Map over a plain Go map. The real one is a hash-trie
// (internal/sync.HashTrieMap) hashing keys through internal/abi.

package sync

// Map is like a Go map[any]any but is safe for concurrent use
// by multiple goroutines without additional locking or coordination.
type Map struct {
	_ noCopy

	m map[any]any
}

func (m *Map) Load(key any) (value any, ok bool) {
	value, ok = m.m[key]
	return value, ok
}

func (m *Map) Store(key, value any) {
	if m.m == nil {
		m.m = map[any]any{}
	}
	m.m[key] = value
}

func (m *Map) Clear() {
	clear(m.m)
}

func (m *Map) LoadOrStore(key, value any) (actual any, loaded bool) {
	if v, ok := m.m[key]; ok {
		return v, true
	}
	m.Store(key, value)
	return value, false
}

func (m *Map) LoadAndDelete(key any) (value any, loaded bool) {
	value, loaded = m.m[key]
	if loaded {
		delete(m.m, key)
	}
	return value, loaded
}

func (m *Map) Delete(key any) {
	delete(m.m, key)
}

func (m *Map) Swap(key, value any) (previous any, loaded bool) {
	previous, loaded = m.m[key]
	m.Store(key, value)
	return previous, loaded
}

func (m *Map) CompareAndSwap(key, old, new any) (swapped bool) {
	if v, ok := m.m[key]; ok && v == old {
		m.m[key] = new
		return true
	}
	return false
}

func (m *Map) CompareAndDelete(key, old any) (deleted bool) {
	if v, ok := m.m[key]; ok && v == old {
		delete(m.m, key)
		return true
	}
	return false
}

func (m *Map) Range(f func(key, value any) bool) {
	for k, v := range m.m {
		if !f(k, v) {
			break
		}
	}
}
