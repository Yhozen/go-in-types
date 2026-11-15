package main

// Intrinsics: functions whose body the runtime provides, by go/ssa name
// (for generic instances, the name of the generic origin). The list is
// mirrored by src/ref/intrinsics.ts; a function here gets
// `body: "intrinsic"` and `intrinsic: <name>`. Semantics are
// single-threaded and deterministic. Keep the comments exact: they are the
// specification the reference implements.

import "strings"

var intrinsics = map[string]string{
	// internal/bytealg (assembly in Go).
	"internal/bytealg.Compare":                        "(a, b []byte) int: -1/0/+1 bytewise",
	"internal/bytealg.Count":                          "(b []byte, c byte) int",
	"internal/bytealg.CountString":                    "(s string, c byte) int",
	"internal/bytealg.Equal":                          "(a, b []byte) bool",
	"internal/bytealg.Index":                          "(a, b []byte) int: first index of b in a, or -1",
	"internal/bytealg.IndexString":                    "(a, b string) int",
	"internal/bytealg.IndexByte":                      "(b []byte, c byte) int",
	"internal/bytealg.IndexByteString":                "(s string, c byte) int",
	"internal/bytealg.MakeNoZero":                     "(n int) []byte: make([]byte, n) (zeroed is fine)",
	"internal/bytealg.abigen_runtime_cmpstring":       "(a, b string) int",
	"internal/bytealg.abigen_runtime_memequal":        "(a, b unsafe.Pointer, size uintptr) bool: traps",
	"internal/bytealg.abigen_runtime_memequal_varlen": "(a, b unsafe.Pointer) bool: traps",

	// sync/atomic: plain loads, stores and read-modify-writes.
	"sync/atomic.AddInt32": "(p *int32, d int32) (new int32)", "sync/atomic.AddInt64": "(p *int64, d int64) int64",
	"sync/atomic.AddUint32": "(p *uint32, d uint32) uint32", "sync/atomic.AddUint64": "(p *uint64, d uint64) uint64",
	"sync/atomic.AddUintptr": "(p *uintptr, d uintptr) uintptr",
	"sync/atomic.AndInt32":   "(p *int32, m int32) (old int32)", "sync/atomic.AndInt64": "(p *int64, m int64) (old int64)",
	"sync/atomic.AndUint32": "(p *uint32, m uint32) (old uint32)", "sync/atomic.AndUint64": "(p *uint64, m uint64) (old uint64)",
	"sync/atomic.AndUintptr": "(p *uintptr, m uintptr) (old uintptr)",
	"sync/atomic.OrInt32":    "(p *int32, m int32) (old int32)", "sync/atomic.OrInt64": "(p *int64, m int64) (old int64)",
	"sync/atomic.OrUint32": "(p *uint32, m uint32) (old uint32)", "sync/atomic.OrUint64": "(p *uint64, m uint64) (old uint64)",
	"sync/atomic.OrUintptr":           "(p *uintptr, m uintptr) (old uintptr)",
	"sync/atomic.CompareAndSwapInt32": "(p *int32, old, new int32) (swapped bool)", "sync/atomic.CompareAndSwapInt64": "(p *int64, old, new int64) bool",
	"sync/atomic.CompareAndSwapUint32": "(p *uint32, old, new uint32) bool", "sync/atomic.CompareAndSwapUint64": "(p *uint64, old, new uint64) bool",
	"sync/atomic.CompareAndSwapUintptr": "(p *uintptr, old, new uintptr) bool",
	"sync/atomic.CompareAndSwapPointer": "(p *unsafe.Pointer, old, new unsafe.Pointer) bool: pointer identity",
	"sync/atomic.LoadInt32":             "(p *int32) int32", "sync/atomic.LoadInt64": "(p *int64) int64",
	"sync/atomic.LoadUint32": "(p *uint32) uint32", "sync/atomic.LoadUint64": "(p *uint64) uint64",
	"sync/atomic.LoadUintptr": "(p *uintptr) uintptr", "sync/atomic.LoadPointer": "(p *unsafe.Pointer) unsafe.Pointer",
	"sync/atomic.StoreInt32": "(p *int32, v int32)", "sync/atomic.StoreInt64": "(p *int64, v int64)",
	"sync/atomic.StoreUint32": "(p *uint32, v uint32)", "sync/atomic.StoreUint64": "(p *uint64, v uint64)",
	"sync/atomic.StoreUintptr": "(p *uintptr, v uintptr)", "sync/atomic.StorePointer": "(p *unsafe.Pointer, v unsafe.Pointer)",
	"sync/atomic.SwapInt32": "(p *int32, v int32) (old int32)", "sync/atomic.SwapInt64": "(p *int64, v int64) (old int64)",
	"sync/atomic.SwapUint32": "(p *uint32, v uint32) (old uint32)", "sync/atomic.SwapUint64": "(p *uint64, v uint64) (old uint64)",
	"sync/atomic.SwapUintptr": "(p *uintptr, v uintptr) (old uintptr)", "sync/atomic.SwapPointer": "(p *unsafe.Pointer, v unsafe.Pointer) (old unsafe.Pointer)",
	"sync/atomic.runtime_procPin": "() int: returns 0", "sync/atomic.runtime_procUnpin": "(): no-op",

	// unsafe-based helpers.
	"strings.(*Builder).String": "(b *Builder) string: string(b.buf) (field 1)",
	"internal/abi.NoEscape":     "(p unsafe.Pointer) unsafe.Pointer: identity",
	"slices.overlaps":           "[E](a, b []E) bool: a and b share an element slot (same object, intervals intersect; false if either is empty)",

	// runtime services used from std.
	"runtime.KeepAlive":                    "(x any): no-op",
	"runtime.SetFinalizer":                 "(obj, finalizer any): no-op",
	"runtime.GC":                           "(): no-op",
	"runtime.Gosched":                      "(): no-op",
	"runtime.GOMAXPROCS":                   "(n int) int: returns 1",
	"runtime.NumCPU":                       "() int: returns 1",
	"runtime.NumGoroutine":                 "() int: returns 1",
	"time.runtimeNano":                     "() int64: returns 0",
	"time.now":                             "() (sec int64, nsec int32, mono int64): returns (0, 0, 0)",
	"os.runtime_args":                      "() []string: the host's argument list (default [program name])",
	"syscall.runtime_envs":                 "() []string: returns nil",
	"internal/godebug.setUpdate":           "(update func(string, string)): no-op",
	"internal/godebug.setNewIncNonDefault": "(newIncNonDefault func(string) func()): no-op",
	"internal/godebug.registerMetric":      "(name string, read func() uint64): no-op",
	"internal/chacha8rand.block":           "(seed *[4]uint64, blocks *[32]uint64, counter uint32): see Go's chacha8rand/chacha8_generic.go",
	"sync.runtime_canSpin":                 "(i int) bool: returns false",
	"sync.runtime_doSpin":                  "(): no-op",
	"sync.runtime_nanotime":                "() int64: returns 0",
	"sync.runtime_notifyListCheck":         "(size uintptr): no-op",
	"sync.runtime_registerPoolCleanup":     "(cleanup func()): no-op",
	"sync.runtime_procPin":                 "() int: returns 0",
	"sync.runtime_procUnpin":               "(): no-op",
	"sync.throw":                           "(s string): fatal error: s (exit 2)",
	"sync.fatal":                           "(s string): fatal error: s (exit 2)",
	"internal/sync.throw":                  "(s string): fatal error: s (exit 2)",
	"internal/sync.fatal":                  "(s string): fatal error: s (exit 2)",

	// go-in-types runtime package (overlay gointypes/rt).
	"gointypes/rt.Write": "(fd int, b []byte): append b to stderr if fd == 2, else to stdout",
	"gointypes/rt.Exit":  "(code int): end the run with exit status code",

	// Package initializers of replaced runtime packages (see runtimePkg).
	"noop": "package initializer of a runtime package: no-op",
}

// callRewrites are call sites replaced by an instruction (the callee is not
// called). Float bit conversions are identities on the soft-float bit
// pattern: they become `changeType`.
var callRewrites = map[string]string{
	"math.Float64bits":     "changeType",
	"math.Float64frombits": "changeType",
	"math.Float32bits":     "changeType",
	"math.Float32frombits": "changeType",
}

// runtimePkg: packages replaced by the engine runtime. Their functions are
// not compiled: intrinsics if listed, initializers are "noop", the rest
// trap.
func runtimePkg(path string) bool {
	return path == "runtime" || strings.HasPrefix(path, "runtime/") || strings.HasPrefix(path, "internal/runtime/")
}
