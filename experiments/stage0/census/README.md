# Stage 0 census tool

Measures what `tsgo --noLib --noEmit --skipLibCheck --singleThreaded <lib> main.ts`
needs from the engine. Results and strategies: `docs/stage0/CENSUS.md`.

```sh
./census.sh ../../../../go-in-types/vendor/typescript/tsc ../../../../ts-in-lua-in-types
```

(any paths: the typescript-go module root at v7.0.2, and a ts-in-lua-in-types
checkout for the 328 oracle inputs and the two lib files). Takes about a
minute on an M-series Mac; needs Go 1.27, `rsync`, `perl` (for a timeout).

## Pieces

- `main.go`, `cover.go`, `features.go`, `report.go`: the `census` command.
  Loads a main package with `go/packages` (optionally with a
  `go build -overlay` JSON, `-goos`/`-goarch`/`-tags`, always
  `CGO_ENABLED=0`), builds SSA with `ssa.InstantiateGenerics`, computes
  reachability from `main.init` + `main.main` with RTA and then VTA (seeded
  with RTA's graph), and with `-cover` maps a Go coverage profile onto the
  SSA functions. Writes `out/<name>.summary.json` (totals, per package,
  generics, functions without bodies, feature tallies) and
  `out/<name>.report.md` (the same as tables), and with `-functions`
  `out/<name>.functions.json` (one record per VTA-reachable or executed
  function). `-why <substring>` prints a VTA call path from main to a
  function, for "why is this reachable".
- `run-dynamic.sh`: runs a coverage-instrumented tsgo
  (`go build -cover -coverpkg=all`) on the one-liner and the 328 oracle inputs
  in both lib modes, each in a fresh temp dir with `lib.*.d.ts` + `main.ts`,
  compares output with the oracle's expected files, and merges coverage into
  textfmt profiles per set (`oneliner-mini`, `oneliner-es5`, `corpus-mini`,
  `corpus-es5`, `all`).
- `overlay/`: the source swaps used by the configurations below (`.txt` so
  the census module does not compile them).
- `census.sh`: builds everything and writes `out/`.

## Configurations

| name | what |
|---|---|
| `full` | unmodified `cmd/tsgo` (LSP, API, build mode, watch all reachable) |
| `cli` | `cmd/tsgo/main.go` calls `execute.CensusCompile` (parse args, `performCompilation`); LSP/API files of `cmd/tsgo` stubbed |
| `harness` | `cmd/tsgo/main.go` = `overlay/harness_main.go.txt`: read the named files once, then `check(files, args)` on an in-memory `vfstest` FS with output to a buffer; no `internal/execute`, no OS access inside `check` |
| `harness-wasip1` | the harness, loaded for `GOOS=wasip1 GOARCH=wasm -tags purego` (static only) |

The `harness` coverage comes from a harness binary built from a copy of the
source (`go build -cover` mishandles `-overlay`); the `cli` configuration
reuses the `full` binary's coverage.

## How "executed" is decided

Coverage counts source blocks, not SSA. A function counts as executed when
one of its instructions lies in a covered coverage block **and** a VTA call
edge from an executed block of an executed caller reaches it (starting from
`main` and every package initializer, all of which run). The second rule
separates the instances of a generic function (coverage is shared by source
position) and decides synthetic wrappers (no positions). Covered functions
no executed edge reaches (called by the runtime or reflection only) are kept
and listed under "Covered but not reached". A basic block counts as executed
when one of its positioned instructions is in a covered block; a block with
no positioned instruction follows its function (so the per-block numbers are
an upper bound, e.g. synthetic range-over-func `panic` blocks count as
executed). Package initializers count as fully executed.
