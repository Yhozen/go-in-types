# go-in-types: design contract (stage 1)

The contract every stage builds on. IR types: `src/ir/types.ts`. Inputs:
`docs/stage0/HEAP.md` (heap rules H1–H5), `docs/stage0/CENSUS.md` (what tsgo
needs), `docs/stage0/OPS.md` (op counts), `docs/LESSONS.md`. If an agent
finds the contract wrong, it stops and reports to the planner with the
evidence instead of working around it silently.

## Pipeline

```
Go source + overlays ──frontend (Go, build time)──▶ prog.json (IR)
prog.json ──src/ref (TypeScript)──▶ output, exact op counts, snapshots
prog.json (+ snapshot) ──emitter (stage 5)──▶ .d.ts aliases run by tsrs
```

## Build configuration

- `CGO_ENABLED=0`, `-tags purego`, a 64-bit target (`int` is 64-bit). The
  front end loads packages for `GOOS=linux GOARCH=amd64` by default; it may
  switch target if that leaves fewer bodyless functions, recorded in
  `Program.build`.
- Overlays (`go build -overlay`) live in `overlay/` as real `.go` files plus
  a generated `overlay/<config>.json`. The same overlays are used for the
  native comparison run (`go run -overlay`), so native and engine run the
  same Go code.
- tsgo always runs with `--singleThreaded`.

## Front end (`frontend/`, Go module)

`go run ./frontend -C <module dir> -overlay <json> -o prog.json <pkg>
[-entry name=pkg.Func]...`

1. Load with `go/packages`, build SSA with `ssa.InstantiateGenerics`
   (no generic bodies remain).
2. Reachability: VTA from `init`, `main` and entries, **plus every closure
   created in a reachable function** (VTA misses some; census caveat), plus
   methods reachable by interface dispatch. Option `-keep <file>`: only listed
   functions get bodies; others become `body: "trap"` (size mode).
3. Lowering:
   - Floats: every float op/comparison/conversion becomes a call to a soft
     float function (Go's `runtime/softfloat64.go`, copied into an overlay
     package `gointypes/softfloat`). Float values are their bit patterns.
     `math.Float64bits`/`Float64frombits` (and 32-bit) become identity
     conversions.
   - Intrinsics: functions replaced by name, list in
     `frontend/intrinsics.go` mirrored in `src/ref/intrinsics.ts`: at least
     `internal/bytealg.*`, `sync/atomic.*` (single-threaded semantics),
     `strings.Builder.String`, the `unsafe.String` sites, `slices.overlaps`,
     `gointypes/rt.Write`, `gointypes/rt.Exit`.
   - Bodyless functions not in the list, `go` statements, `select`, complex
     numbers, unsafe pointer arithmetic: `trap` (function body or
     instruction). A trap reached at run time aborts with its message; one in
     unreached code costs nothing.
   - `DebugRef` and other no-ops are dropped.
4. Registers: params, then free vars, then each value instruction's result,
   numbered per function.
5. Output deterministic (same input → same bytes).

## Value model (reference interpreter)

Memory is a set of **objects**, each a flat array of **slots**; a type's
slot count is in the IR (`array`/`struct` flatten, everything else is 1
slot). Values:

| Go                                | reference value                                                  |
| --------------------------------- | ---------------------------------------------------------------- |
| bool                              | `boolean`                                                        |
| int8..int32, uint8..uint32        | `number`, normalised to the width                                |
| int64, uint64, int, uint, uintptr | `bigint`, normalised (`BigInt.asIntN/asUintN`)                   |
| float32/64                        | `number` (uint32 bits) / `bigint` (uint64 bits)                  |
| string                            | JS string, one char per byte (0..255)                            |
| pointer                           | `null` or `{ o: object, i: slot index }`                         |
| slice                             | `null` or `{ o, i, len, cap }` (elements at `i + k*elemSlots`)   |
| map                               | `null` or a map object: insertion-ordered, keys canonicalised    |
| chan                              | `null` or a queue object                                         |
| func                              | `null` or `{ fn: FuncId, env: value[] }`                         |
| interface                         | `null` or `{ t: TypeId, v: value }` (dynamic type and its value) |
| struct, array (in registers)      | `value[]` of length `slots`                                      |

Rules:

- `load`/`store` copy `slots` consecutive slots; aggregates are copied, never
  aliased.
- `alloc` creates a zeroed object of the element's slots; `heap` is only a
  hint. A pointer to a field/element is `{o, i + offset}`.
- A dynamic type implements an interface when its method set (`methods` of
  a named type or of an unnamed struct with embedded fields, `ptrMethods`
  for a pointer to either) has every method name of the interface with the
  identical signature (`sigs`, receiver dropped).
  Runtime panics are `runtime.errorString` (message without the
  "runtime error: " prefix) or `runtime.plainError` (no prefix: nil-map
  writes, type assertions, channel misuse); both are always in the program.
- Map keys canonicalise to a string from their slots (strings, integers,
  bools, pointers by object identity + index, structs/arrays slotwise).
  Float and interface keys trap (not used by tsgo). Iteration order is
  insertion order with deleted keys removed; iterating while inserting sees
  the new keys only if added after the cursor. Programs must not depend on
  it (Go randomises); tsgo doesn't.
- Strings are byte strings; `range` over a string and `[]rune(s)` decode
  UTF-8 exactly as Go (invalid byte → U+FFFD, width 1). Hosts pass text as
  UTF-8 bytes.
- `==`/`!=` on structs, arrays and interfaces compare slot by slot with
  the slot's type: float slots compare as floats (NaN != NaN, +0 == -0),
  not as bit patterns. This is the one place float semantics are not
  lowered to soft float (scalar float `==` is a soft-float call): the
  type level checks the two bit patterns for equality, then the NaN
  (exponent all ones, mantissa non-zero) and ±0 (all bits but the sign
  zero) cases, which is cheaper than a call per float field.
- Integer arithmetic wraps; `/` and `%` truncate; division by zero, nil
  dereference, index/slice out of range and failed type assertions panic
  with Go's runtime error message text.
- Shifts: count ≥ width gives 0 (or the sign fill for `>>` on signed);
  negative count panics.
- `panic`/`defer`/`recover` follow Go (deferred calls run on panic and
  return; `recover` in a deferred call stops the panic). An unrecovered
  panic ends the run with `panic: <message>` (Go's format for the common
  value kinds) and exit status 2. `panic(nil)` panics with a
  `*runtime.PanicNilError` (Go 1.21+; always in the program), which
  `recover` returns.
- `defer` in a range-over-func body targets the enclosing function's
  frame (go/ssa's `ssa:deferstack`). The front end keeps an
  `ssa:deferstack()` call only when a closure uses it, lowered to
  `call {builtin: "deferstack"}`: its value (type opaque "deferstack") names
  the calling frame (in the reference, its stack index; the frame is live
  while its loop bodies run). `defer` with `stack: <that value>` pushes onto
  that frame's defer list; without `stack`, onto the current frame's.
  go/ssa drops `RunDefers` from a function without `defer` statements of
  its own, so the front end emits `runDefers` before each `return` of a
  function that keeps the call and has none.
- Goroutines: `go` traps. Channels: buffered queues; a receive on an empty
  channel or send on a full one traps ("deadlock"), except a receive from a
  closed channel, which yields the zero value.
- `print`/`println` write to stderr in Go's format; `gointypes/rt.Write(fd,
  b)` writes bytes to fd 1 or 2. The run's result is `{ stdout, stderr,
  exit, ops }`.

## Contract changes

- IR 2 (stage 2 close): `struct` types may carry `methods`/`ptrMethods`
  (unnamed structs with embedded fields); builtin `deferstack`; `defer`
  takes an optional `stack` operand (range-over-func bodies).

## Ops and snapshots

- **One op = one executed IR instruction** (`phi` included, `trap` included).
  Calls to intrinsics count 1 plus whatever the intrinsic declares in
  `src/ref/intrinsics.ts`. The reference counts ops in total, per function
  and per instruction kind.
- **Snapshots from day one:** the whole machine state (objects, globals,
  frames with pc = block + instruction index, registers, defer lists, panic
  state, output so far, op counter) serialises to JSON and back. The
  reference can pause after any op count and resume from a snapshot (fresh
  process) with identical final output and op total. The boot image (stage 3) is a snapshot.
- Snapshot object identity: objects get ids in allocation order; snapshots
  preserve them, so map iteration and pointer keys stay identical.

## Type level (stages 4–5; binding rules now)

- Heap: candidate A of HEAP.md: `[next, root]`, 16-wide tuple trie, ids as
  fixed-width hex, objects as slot tuples (≤16 per node, nested beyond).
- Rules H1–H5 of HEAP.md are mandatory. In short: nothing generic-looking
  reachable from the heap; the heap only ever travels as an alias argument,
  never as a conditional's check type or through a tuple pattern; big tables
  read as `K extends keyof T ? T[K] : never`; constructors are conditional
  aliases whose tuples contain only their parameters; cost tests at 0, 1k,
  10k, 100k live objects plus a walk/op = 0 diag check.
- From LESSONS.md: at most 4 `infer` bindings per alias; dispatch by
  interface property lookup; fuel pool literal per chunk; emit `.d.ts`.
- Value encodings must each have a bijection to the reference value above,
  with converters in `src/types/codec.ts` (reference value + IR type ↔ type
  literal source text), so snapshots convert both ways.

### Type-level encodings (stage 4 contract)

Code lives in `src/types/` (type-level `.ts` modules, generated tables as
`*.gen.ts`); tests in `tests/types/`.

| Go                                                       | type-level value                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bool                                                     | `true` / `false`                                                                                                                                                                                                                                                                                                                                                                                                              |
| every integer width, signed or unsigned                  | lua-in-types' int64 nibble string (lowercase hex, least significant nibble first, shortest two's complement that sign-extends; `0`→`"0"`, `-1`→`"f"`, `8`→`"80"`) of the value's **w-bit pattern sign-extended to 64 bits**. So uint8 255 is `"f"`, uint64 max is `"f"`, int16 -2 is `"e"`. Every value of every width has one canonical form; signedness and width live in the op, which the emitter picks from the IR type. |
| float32/64                                               | the bit pattern as the matching unsigned integer (above)                                                                                                                                                                                                                                                                                                                                                                      |
| string                                                   | a string literal of bytes (chars 0..255), indexed with a `Chars`-style trie for long strings                                                                                                                                                                                                                                                                                                                                  |
| nil (any kind)                                           | `null`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| pointer, slice, map, chan, func, interface, struct/array | defined by the heap module (`src/types/heap.ts`), documented in its header and in this section by stage 4                                                                                                                                                                                                                                                                                                                     |

Start from lua-in-types (`../lua-in-types/src/aot/types/`: `int64.ts`,
`int64-tables.ts`, `str.ts`, `lstr.ts`, `hash.ts`, `trie.ts`): copy and
adapt, never import across repos. Each primitive gets a fuzz test against
the reference interpreter's own functions (`src/ref/values.ts` etc.) and,
if it touches the heap, the H5 cost test at 0, 1k, 10k, 100k live objects.
Run tsrs benchmarks and gates through `scripts/heavy.sh` (two machine-wide
slots).

## Testing and gates (stage 2)

- `tests/go/`: Go test programs, each `name.go` (package main, uses `fmt`
  overlay / `rt`) with expected output produced by native `go run` with the
  same overlays (`tests/go/<name>.out`, generated, never hand-edited).
  Sources: hand-written programs per feature, plus the in-scope subset of
  `$GOROOT/test` `// run` tests (no goroutines/select/reflect/unsafe).
- A fuzzer generates random well-typed Go programs (integer widths, strings,
  slices, maps, structs, pointers, interfaces, closures, defer/panic/recover,
  floats via soft float) and compares engine vs native.
- Snapshot test: every corpus program paused at several op counts and resumed
  from JSON in a fresh process gives identical output and op totals.
- Tiered: `vp test` smoke (seconds); `vp run gate:ref` full corpus + fuzz N.
