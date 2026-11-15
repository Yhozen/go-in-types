// go-in-types overlay of internal/collections/syncmap.go (typescript-go
// v7.0.2): single-threaded, on a plain map[K]V plus an insertion-ordered
// entry list, instead of sync.Map (which would need interface-keyed maps in
// the engine). Range visits live entries in insertion order (sync.Map's
// order is unspecified).
package collections

import "iter"

type syncMapEntry[K comparable, V any] struct {
	key   K
	value V
	live  bool
}

type SyncMap[K comparable, V any] struct {
	idx     map[K]int
	entries []syncMapEntry[K, V]
}

func (s *SyncMap[K, V]) Load(key K) (value V, ok bool) {
	if i, ok := s.idx[key]; ok {
		return s.entries[i].value, true
	}
	return value, false
}

func (s *SyncMap[K, V]) Store(key K, value V) {
	if i, ok := s.idx[key]; ok {
		s.entries[i].value = value
		return
	}
	if s.idx == nil {
		s.idx = make(map[K]int)
	}
	s.idx[key] = len(s.entries)
	s.entries = append(s.entries, syncMapEntry[K, V]{key, value, true})
}

func (s *SyncMap[K, V]) LoadOrStore(key K, value V) (actual V, loaded bool) {
	if i, ok := s.idx[key]; ok {
		return s.entries[i].value, true
	}
	s.Store(key, value)
	return value, false
}

func (s *SyncMap[K, V]) Delete(key K) {
	if i, ok := s.idx[key]; ok {
		delete(s.idx, key)
		var zero syncMapEntry[K, V]
		s.entries[i] = zero
		if len(s.idx) == 0 {
			s.entries = nil
		}
	}
}

func (s *SyncMap[K, V]) Clear() {
	s.idx = nil
	s.entries = nil
}

func (s *SyncMap[K, V]) Range(f func(key K, value V) bool) {
	n := len(s.entries)
	for i := 0; i < n && i < len(s.entries); i++ {
		e := s.entries[i]
		if e.live && !f(e.key, e.value) {
			return
		}
	}
}

// Size returns the number of items in the map.
func (s *SyncMap[K, V]) Size() int {
	return len(s.idx)
}

func (s *SyncMap[K, V]) ToMap() map[K]V {
	m := make(map[K]V, s.Size())
	s.Range(func(key K, value V) bool {
		m[key] = value
		return true
	})
	return m
}

func (s *SyncMap[K, V]) Keys() iter.Seq[K] {
	return func(yield func(K) bool) {
		s.Range(func(key K, value V) bool {
			return yield(key)
		})
	}
}

func (s *SyncMap[K, V]) Clone() *SyncMap[K, V] {
	clone := &SyncMap[K, V]{}
	s.Range(func(key K, value V) bool {
		clone.Store(key, value)
		return true
	})
	return clone
}
