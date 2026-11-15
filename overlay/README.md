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
