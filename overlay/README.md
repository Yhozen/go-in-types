# Go overlays

Real Go source swapped in with `go build -overlay` (and the same JSON for
the front end), so native runs and the engine execute the same Go code.
`node overlay/gen.ts` writes the machine-specific (absolute paths,
git-ignored) `overlay/tests.json` and `overlay/tsgo.json`.

| dir                     | replaces                                                                  | why                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `std/gointypes/rt`      | (new std package)                                                         | `Write(fd, b)`, `Exit(code)`: the program's only I/O; front-end intrinsics                                 |
| `std/fmt`               | `print.go`, `scan.go`                                                     | no reflect, no `sync.Pool`, no `os`; Print* write to fd 1 via rt                                           |
| `std/errors`            | `wrap.go`                                                                 | no `internal/reflectlite` (`Is` exact; `As` only `*error`)                                                 |
| `std/sync`              | all but `oncefunc.go`                                                     | single-threaded; blocking = panic "deadlock"; `sync.Map` is a slice                                        |
| `std/math`              | `*_asm.go`, `bits.go`                                                     | `haveArch* = false`: pure-Go floor/ceil/trunc/min/max/exp/exp2/hypot/log; `IsNaN`/`IsInf` as bit tests     |
| `tsgo/`                 | typescript-go files (paths relative to its module root)                   | tsgo config: harness main, no reflect/regexp/testing on the check path                                     |
| `tsgo/internal/ast`     | `ast_generated.go`, `utilities.go` (generated: `node overlay/gen-ast.ts`) | `ForEachChild` and kind predicates as tables indexed by `Kind`, not switches (comparison chains in SSA)    |
| `tsgo/internal/scanner` | `scanner.go`                                                              | `Scan` takes ASCII identifier starts straight to its default branch; `scanASCIIWhile` predicates as tables |
| `tsgo-std/`             | `syscall/rlimit.go`, `testing/iotest/logger.go`                           | tsgo config only: no prlimit in `syscall.init`; no `log` (and `os`)                                        |
| `xxh3/`                 | `github.com/zeebo/xxh3`                                                   | same API, no hashing: interns the bytes                                                                    |

The engine's tsgo program has no `os` and no `reflect.TypeFor` in package
initializers: the harness main is split by build tag (`main_os.go` native,
`main_engine.go` with `gointypes`; the host calls `check`, an `-entry`),
`internal/core` loses `ApplyDebugStackLimit` (moved to `main_os.go`),
`internal/json` keeps the jsontext types but its `Marshal*`/`Unmarshal*`
panic (dropping `encoding/json/v2`; `tsgo-parity.ts` proves no oracle check
uses them), and `internal/tsoptions` computes `optionsType` on use and tests
`*OrderedMap` with a type assertion.

Boot image entries (ts-in-types stage 3): besides `check`, the harness has
`boot(files, args)` (one full check that keeps the parsed command line and
every parsed and bound source file but `/p/main.ts`) and `checkWarm(main)`
(a check of a new `/p/main.ts` reusing both through a compiler host that
returns the kept `SourceFile`s, as the watch host does). A host snapshots
the machine after `boot` and calls `checkWarm` from the snapshot
(`Machine.callEntry`). `checkWarm` doesn't rebuild the in-memory FS: path-only
queries (`FileExists`, `DirectoryExists`, memoised at boot, so the warm-up's
answers are in the image) go to the boot FS, `ReadFile("/p/main.ts")` decodes
the new text as vfstest does, and anything else builds the full FS on first use. Natively, `GOINTYPES_WARM=<file>` makes the overlay
binary boot on `<file>` and `checkWarm` the real `main.ts`.

Files that must disappear map to the package's `empty.go` (go/packages'
in-memory overlays cannot delete). Configs: `tests` = `std/`; `tsgo` =
`std/` + `tsgo/` + `tsgo-std/` + `xxh3/`.

The module cache cannot be overlaid, so xxh3 is swapped by overlaying
typescript-go's `go.mod` with an added `replace` (go/packages honours it).
Build tags: native `-tags purego`; the front end `-tags purego,gointypes`
(selects the bodyless `gointypes/rt` intrinsics).

## Checks

- `node scripts/tsgo-parity.ts`: tsgo built with `tsgo.json` vs the
  unmodified native `tsc` 7.0.2 on the 328 oracle inputs x {mini, es5}
  (stdout + exit status). `--warm`: the same through `boot` (on the
  one-liner) and `checkWarm`.
- `node scripts/tsgo-reflect.ts`: coverage build; lists reflect /
  reflectlite / json / binary / regexp code that ran inside `check`
  (counters at check start subtracted), with `internal/scanner` as a
  positive control.
- Static: `census -dir <tsgo> -overlay overlay/tsgo.json -tags purego -from
  github.com/microsoft/typescript-go/cmd/tsgo.check` (stage 0 census tool,
  `-from` added) prints the reflection VTA-reachable from `check`.
- `node scripts/gen-go-out.ts --real`: hand-written test programs give the
  same output with and without the `tests` overlays.
