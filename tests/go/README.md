# Go test corpus

Each `name.go` is a `package main` program; `name.out` is its expected
output, **generated** by `node scripts/gen-go-out.ts` (never hand-edited)
from a native run:

```
GOARCH=amd64 CGO_ENABLED=0 go build -overlay overlay/tests.json name.go && ./name
```

amd64 (Rosetta on Apple silicon) because the Go compiler fuses `x*y+z` into
FMA on arm64, which soft float does not; amd64 (GOAMD64=v1) never fuses.
The overlay (`overlay/tests.json`, from `node overlay/gen.ts`) supplies
`gointypes/rt`, the reflection-free `fmt`, `errors`, single-threaded `sync`
and pure-Go `math`; the engine runs the same Go code.

## .out format

```
<stdout bytes, verbatim>
--- stderr ---          only when the normalised stderr is non-empty
<stderr bytes>
--- exit N ---
```

- If stdout (or stderr) does not end in `\n`, a line `--- no newline ---`
  follows it.
- stderr is normalised (`scripts/go-out.ts`): everything from the first
  `goroutine N [...]:` line on is dropped, with the blank lines before it,
  and `[signal SIGSEGV ...]` lines (addresses) are dropped. What remains of a
  panic is Go's `panic: <message>` line(s), including nested
  `panic: ... [recovered]` lines.
- Files are bytes (read and written as latin1).
- An unrecovered panic exits 2; `rt.Exit(n)` exits n.

## Rules for programs

- Deterministic: no map-order dependence (sort keys or aggregate
  order-independently), no goroutines, select, reflect, unsafe, os, time.
- `fmt` is the overlay: basic types, `error`, `Stringer`, `Formatter`,
  `[]T`/`map[K]V` of common basic T (see `printValue` in
  `overlay/std/fmt/print.go`). Structs, pointers, arrays and **named
  non-string types** (e.g. `type MyInt int`) print as
  `%!v(unsupported type)`; convert or print fields. `%T` knows predeclared
  and those composite types only. `errors.As` only fills `*error` targets
  (use `errors.AsType`).
- `node scripts/gen-go-out.ts --real` also runs every hand-written program
  without the overlay and reports differences (fmt parity check).

## Layout

- `*.go`: hand-written, one feature area each.
- `gotest/`: the in-scope `$GOROOT/test` `// run` programs (copied
  unchanged), with Go's own `.out` files kept as `name.golden` when
  present; `gotest/EXCLUDED.md` lists the excluded ones and why.
- `fuzz/`: failing fuzzer cases worth keeping (`scripts/fuzz-go.ts`).
