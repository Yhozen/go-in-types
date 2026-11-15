//go:build wasip1

package main

import "unsafe"

//go:wasmimport ops mark
//go:noescape
func opsMark(ptr unsafe.Pointer, n uint32)

// hostMark tells the wasm runner (../wasm/run.py) that a phase starts, so
// it can attribute the fuel consumed so far.
func hostMark(name string) {
	opsMark(unsafe.Pointer(unsafe.StringData(name)), uint32(len(name)))
}
