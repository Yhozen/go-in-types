# Stage 0: operation counts

Counts the Go SSA instructions (golang.org/x/tools/go/ssa, the IR the
front end will emit) that the TypeScript 7.0.2 compiler executes to check
`const x: number = 'hello';`, and the wasm operators its wasip1 build
executes. Results and discussion: `docs/stage0/OPS.md`.

```sh
./run.sh <typescript-go dir> <dir with lib.mini.d.ts and lib.es5.d.ts>
# e.g. ./run.sh ../go-in-types/vendor/typescript/tsc /tmp/goops/lib
```

`run.sh` calls `build.sh` (native and wasip1 builds into `$OUT`, default
`/tmp/goops`), creates a Python venv with `wasmtime==50.0.1` if needed (uv),
and writes the reports to `docs/stage0/ops/`. It also writes `main.ts` into
the lib directory (the wasip1 `tsgo` runs there). About 2 minutes.

## Pieces

- `harness/` (its own module; compiled into the typescript-go module
  through a `go build -overlay` / `packages.Config.Overlay`, because it
  imports internal packages): runs the compiler on an in-memory file system.
  `cli` calls `execute.CommandLine` as `cmd/tsgo` does; `phased` runs the
  same pipeline by hand with phase marks (`Mark`), then a second, warm
  check whose host returns the already parsed and bound lib `SourceFile`
  (as `execute/watcher.go`'s `watchCompilerHost` does). Command line:
  `--noLib --noEmit --skipLibCheck --singleThreaded lib.<mini|es5>.d.ts main.ts`.
- `count/`: loads the harness with `go/packages`, builds SSA with
  `ssa.InstantiateGenerics` and runs it under `count/interp`, a copy of
  `golang.org/x/tools/go/ssa/interp` v0.47.0 with an instruction counter
  (`count.go`) and fixes listed below. Every executed instruction is counted
  once, phis included, per phase, op kind and function.
- `count/goroot/`: replacement std files (overlaid on `$GOROOT/src`) for
  code the boxed interpreter cannot run: `strings.Builder` without
  `unsafe` (2 lines), a single-goroutine `sync.Pool` (LIFO free list) and
  `sync.Map` (plain map). `internal/bytealg` uses its portable
  `*_generic.go` code (generated in `count/main.go`).
- `validate/`: a program whose counts are checked by hand below.
- `wasm/run.py`: runs a wasip1 module under wasmtime with fuel metering;
  the harness's `Mark` calls the host (`ops.mark`) so phases split there too.

## What the interpreter does not count

- Package initializers of `runtime`, `os`, `syscall`, `time`, `sync`,
  `sync/atomic`, `reflect`, `errors`, `unique`, `net/...`, `encoding/json/...`,
  `github.com/go-json-experiment/...`, `golang.org/x/sys/...` and every
  `internal/...` std package (list in each report). All other initializers
  (the typescript-go packages, `unicode`, `regexp`, `golang.org/x/text`, ...)
  are interpreted and counted in the `init` phase.
- Externals (counted as calls by name in each report, not as
  instructions): `sync/atomic` primitives, the `sync` runtime hooks,
  `maps.clone`, `bytealg.MakeNoZero`, `slices.overlaps`, `reflect.TypeOf`
  and the reflect `rtype`/`Value` emulation of the original interp, and
  `github.com/zeebo/xxh3` (pointer arithmetic over strings; computed
  natively, hashed bytes reported as `xxh3 bytes hashed`).
- Everything the Go runtime does for an instruction (allocation, GC, map
  hashing, write barriers): one `MapUpdate` is one instruction.

## Interpreter fixes (beyond counting)

- Removed the original interp's std externals that shadow real code (they
  are interpreted and counted now); one of them, `strings.Replace`, had
  `old` and `new` swapped.
- `clear` builtin; `append` zeroes the spare capacity of a new backing
  array (Go does; `slices.Grow` reslices into it); `StructField.PkgPath` is
  empty for exported fields; `reflect.TypeFor[T]`.
- Map iteration uses Go's random order, as compiled Go does, so the
  `global` and `check` phases vary between runs (`*-repeats.txt`).

## Validation

`validate/main.go` (report `docs/stage0/ops/validate.txt`, SSA in
`validate.ssa.txt`). From the SSA of `main` and `sq.area`:

| phase | hand count | counted |
| ----- | ---------- | ------- |
| loop  | jump 1 + 11 × (2 phi, `<`, if) + 10 × (2 `+`, jump) + `Mark` call = 1 + 44 + 30 + 1 = 76 | 76 |
| calls | 7 (local, field addr, store, load, make interface, `<`, if) + 4 × 7 (2 phi, invoke, 3 binop, if) + phi + `Mark` = 37, plus 4 × 8 in `area` = 69 | 69 |
| map   | make map + 2 map updates + `Mark` = 4 | 4 |
| end   | len, println, return = 3 | 3 |

The `Mark` call that switches phases counts in the phase it ends. The
harness also checks itself: its output must be the TS2322 line, in both
modes and lib modes (each report starts with the target's output).
