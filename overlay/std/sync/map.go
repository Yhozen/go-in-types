// go-in-types overlay of package sync (Go 1.27.4): single-threaded. A
// program has one goroutine, so blocking where real sync would wait is a
// deadlock and panics. No runtime hooks, no atomics, no unsafe.

package sync

// Map is a map[any]any (single-threaded). Entries are kept in a slice in
// insertion order and found by == on the key, so the engine never needs
// interface-keyed maps. Range visits entries in insertion order.
type Map struct {
	_       noCopy
	entries []mapEntry
}

type mapEntry struct {
	key, value any
}

func (m *Map) find(key any) int {
	for i := range m.entries {
		if m.entries[i].key == key {
			return i
		}
	}
	return -1
}

func (m *Map) Load(key any) (value any, ok bool) {
	if i := m.find(key); i >= 0 {
		return m.entries[i].value, true
	}
	return nil, false
}

func (m *Map) Store(key, value any) {
	m.Swap(key, value)
}

func (m *Map) Clear() {
	m.entries = nil
}

func (m *Map) LoadOrStore(key, value any) (actual any, loaded bool) {
	if i := m.find(key); i >= 0 {
		return m.entries[i].value, true
	}
	m.entries = append(m.entries, mapEntry{key, value})
	return value, false
}

func (m *Map) LoadAndDelete(key any) (value any, loaded bool) {
	i := m.find(key)
	if i < 0 {
		return nil, false
	}
	value = m.entries[i].value
	m.entries = append(m.entries[:i:i], m.entries[i+1:]...)
	return value, true
}

func (m *Map) Delete(key any) {
	m.LoadAndDelete(key)
}

func (m *Map) Swap(key, value any) (previous any, loaded bool) {
	if i := m.find(key); i >= 0 {
		previous = m.entries[i].value
		m.entries[i].value = value
		return previous, true
	}
	m.entries = append(m.entries, mapEntry{key, value})
	return nil, false
}

func (m *Map) CompareAndSwap(key, old, new any) (swapped bool) {
	if i := m.find(key); i >= 0 && m.entries[i].value == old {
		m.entries[i].value = new
		return true
	}
	return false
}

func (m *Map) CompareAndDelete(key, old any) (deleted bool) {
	if i := m.find(key); i >= 0 && m.entries[i].value == old {
		m.entries = append(m.entries[:i:i], m.entries[i+1:]...)
		return true
	}
	return false
}

func (m *Map) Range(f func(key, value any) bool) {
	entries := m.entries
	for _, e := range entries {
		if !f(e.key, e.value) {
			break
		}
	}
}
