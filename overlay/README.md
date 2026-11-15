# Go overlays

Real Go source swapped in with `go build -overlay` (and the same JSON for
the front end), so native runs and the engine execute the same Go code.
`node overlay/gen.ts` writes the machine-specific (absolute paths,
git-ignored) `overlay/tests.json` and `overlay/tsgo.json`.

| dir                | replaces                                                | why                                                                        |
| ------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| `std/gointypes/rt` | (new std package)                                       | `Write(fd, b)`, `Exit(code)`: the program's only I/O; front-end intrinsics |
| `std/fmt`          | `print.go`, `scan.go`                                   | no reflect, no `sync.Pool`, no `os`; Print* write to fd 1 via rt           |
| `std/errors`       | `wrap.go`                                               | no `internal/reflectlite` (`Is` exact; `As` only `*error`)                 |
| `std/sync`         | all but `oncefunc.go`                                   | single-threaded; blocking = panic "deadlock"; `sync.Map` is a slice        |
| `std/math`         | `*_asm.go`                                              | `haveArch* = false`: pure-Go floor/ceil/trunc/min/max/exp/exp2/hypot/log   |
| `tsgo/`            | typescript-go files (paths relative to its module root) | tsgo config: harness main, no reflect/regexp/testing on the check path     |
| `xxh3/`            | `github.com/zeebo/xxh3`                                 | pure-Go, same API, no assembly/unsafe                                      |

Files that must disappear map to the package's `empty.go` (go/packages'
in-memory overlays cannot delete). Configs: `tests` = `std/`; `tsgo` =
`std/` + `tsgo/` + `xxh3/`.

The module cache cannot be overlaid, so xxh3 is swapped by overlaying
typescript-go's `go.mod` with an added `replace` (go/packages honours it).
Build tags: native `-tags purego`; the front end `-tags purego,gointypes`
(selects the bodyless `gointypes/rt` intrinsics).

## Checks

- `node scripts/tsgo-parity.ts`: tsgo built with `tsgo.json` vs the
  unmodified native `tsc` 7.0.2 on the 328 oracle inputs x {mini, es5}
  (stdout + exit status).
- `node scripts/tsgo-reflect.ts`: coverage build; lists reflect /
  reflectlite / json / binary / regexp code that ran inside `check`
  (counters at check start subtracted), with `internal/scanner` as a
  positive control.
- Static: `census -dir <tsgo> -overlay overlay/tsgo.json -tags purego -from
  github.com/microsoft/typescript-go/cmd/tsgo.check` (stage 0 census tool,
  `-from` added) prints the reflection VTA-reachable from `check`.
- `node scripts/gen-go-out.ts --real`: hand-written test programs give the
  same output with and without the `tests` overlays.
