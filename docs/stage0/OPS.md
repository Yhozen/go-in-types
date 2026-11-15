# Stage 0: operation counts

How many Go SSA instructions does TypeScript 7.0.2 (typescript-go, tag
v7.0.2) execute to check `const x: number = 'hello';`?

Command line throughout: `--noLib --noEmit --skipLibCheck --singleThreaded
lib.<mini|es5>.d.ts main.ts`. Output in every run, native, interpreted and
wasm: `main.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.`

Tools and reproduction: `experiments/stage0/ops/` (README there; `run.sh`
regenerates `docs/stage0/ops/`, the raw reports this page quotes).

## Headline

|                                                                          |              SSA instructions |                        Lua route |             SSA / Lua |
| ------------------------------------------------------------------------ | ----------------------------: | -------------------------------: | --------------------: |
| **warm check, es5** (lib parsed+bound and reused, after a warm-up check) | **189,847** (187,799–192,356) | 125,934 Lua instrs (167k IR ops) | 1.51 (1.14 per IR op) |
| warm check, mini                                                         |     161,435 (161,375–161,615) |                                  |                       |
| fresh check, mini (options → print)                                      |                       334,066 |                          253,614 |                  1.32 |
| fresh check, es5                                                         |                    22,318,816 |                           14.27M |                  1.56 |
| process start (package initializers)                                     |                     1,077,976 |     1.62M (loading the compiler) |                  0.67 |

Ranges are over 10 runs: map iteration order is random (as in compiled Go)
and changes the work of checker creation and checking (sorts of symbols
taken from maps). Medians shown. 40% of the warm check is option parsing
(77,101); without it the warm es5 check is 112,746.

WebAssembly (wasmtime fuel, see below): the warm es5 check costs 2.9M wasm
operators, **~15× the SSA count**; the fresh es5 check 94.2M (4.2×); Go
runtime start alone 34.5M. The wasm route is settled: it costs an order of
magnitude more than SSA for the warm check.

## Method

**Exact counts, by interpreting the program's go/ssa form.** A copy of
`golang.org/x/tools/go/ssa/interp` (v0.47.0) counts every executed SSA
instruction, phis included, per phase, instruction kind and function
(SSA built with `ssa.InstantiateGenerics`). The program is a small
harness (`experiments/stage0/ops/harness`) compiled into the typescript-go
module that runs the compiler over an in-memory file system:

- `cli`: `execute.CommandLine(ctx, sys, args, nil)`, what `cmd/tsgo` runs
  after its `os` setup;
- `phased`: the same pipeline by hand (`tsoptions.ParseCommandLine`,
  `compiler.NewProgram`, `compiler.GetDiagnosticsOfAnyProgram`, emit, sort,
  report) with phase marks, then a **second program** whose compiler host
  returns the already parsed and bound lib `SourceFile` (the
  `watchCompilerHost` pattern) and parses `main.ts` again: the boot-image
  point. The two agree: `cli` 336,138 vs `phased` fresh 334,066 (mini).

The real `cmd/tsgo` cannot run under the interpreter (`os`, signals,
terminal); the harness replaces only its `sys` with an in-memory one.

What had to change for the boxed interpreter to run the real code (details
in the experiments README): package initializers of runtime/OS/sync/
reflect/internal std packages are skipped; `sync/atomic`, sync runtime
hooks, `maps.clone`, `slices.overlaps`, `bytealg.MakeNoZero`, `reflect`
type queries and `github.com/zeebo/xxh3` run as externals (counted as
calls, not instructions; xxh3 hashed 281 bytes in the warm check);
`strings.Builder`, `sync.Pool`, `sync.Map` are small std overlays;
`internal/bytealg` uses its portable Go code. Interpreter bugs fixed:
`strings.Replace` external with swapped arguments (removed, real code now
counted), missing `clear`, uninitialized spare capacity after `append`,
`StructField.PkgPath` for exported fields.

**Validation.** `validate/main.go` (loop, interface calls, map writes): the
counter gives 76/69/4/3 per phase, exactly the counts derived by hand from
its printed SSA (`docs/stage0/ops/validate*.txt`, table in the README).

The SSA count includes no runtime work: one `MapUpdate` or `Alloc` is one
instruction, whatever hashing, allocation and GC it costs natively.

## Split by phase (SSA instructions, medians)

| phase                                                    |  mini fresh |   mini warm |      es5 fresh |    es5 warm |
| -------------------------------------------------------- | ----------: | ----------: | -------------: | ----------: |
| process start (`init`)                                   |   1,077,976 |           — |      1,077,976 |           — |
| options (`ParseCommandLine`)                             |      77,101 |      77,101 |         77,101 |      77,101 |
| program setup (file loader, resolution)                  |      22,619 |      22,206 |         22,390 |      21,996 |
| parse `main.ts`                                          |      10,066 |      10,081 |         10,066 |      10,081 |
| parse lib                                                |     137,067 |  0 (reused) |     18,429,788 |  0 (reused) |
| bind (all files)                                         |      39,052 |       3,822 |      3,702,699 |       3,822 |
| checker creation (`GetGlobalDiagnostics`: globals merge) |      25,857 |      25,902 |         33,682 |      33,780 |
| check `main.ts`                                          |      11,929 |      11,929 |         32,673 |      32,500 |
| emit (`--noEmit`)                                        |       1,492 |       1,492 |          1,492 |       1,492 |
| sort + print diagnostic                                  |       7,579 |       7,598 |          7,579 |       7,598 |
| diagnostics glue                                         |       1,304 |       1,304 |          1,304 |       1,304 |
| **check total (options → print)**                        | **334,066** | **161,435** | **22,318,816** | **189,847** |

Parsing es5 costs 84 SSA instructions per byte of `lib.es5.d.ts`
(218,947 bytes).

## Where the warm es5 check goes

By package (`ssa-phased-es5.txt`, section "warm check"): `strings` 37.7%
(almost all `strings.ToLower`), `checker` 19.5%, `ast` 9.3%, `tspath`
4.5%, `internal/bytealg` 4.4%, `core` 3.8%, `slices` 3.0%, `compiler`
2.5%, `tsoptions` 2.2%, `binder` 2.0%, `collections` 2.0%.

Top functions (warm es5 check, one run):

| instrs |    % | function                                                               |
| -----: | ---: | ---------------------------------------------------------------------- |
| 55,642 | 29.1 | `strings.ToLower` (option-name maps built on every `ParseCommandLine`) |
|  5,791 |  3.0 | `(*strings.Builder).copyCheck`                                         |
|  5,655 |  3.0 | `ast.GetSourceFileOfNode`                                              |
|  5,634 |  2.9 | `bytealg.CountString`                                                  |
|  4,270 |  2.2 | `tspath.hasRelativePathSegment`                                        |
|  2,990 |  1.6 | `OrderedMap[string, *CommandLineOption].Set`                           |
|  2,640 |  1.3 | `(*strings.Builder).WriteString`                                       |
|  2,576 |  1.3 | `checker.compareSymbolsWorker`                                         |
|  2,255 |  1.2 | `(*strings.Builder).WriteByte`                                         |
|  2,175 |  1.1 | `checker.newType`                                                      |
|  2,063 |  1.1 | `(*ast.Node).ForEachChild`                                             |
|  1,872 |  1.0 | `checker.mergeGlobalSymbol`                                            |
|  1,856 |  1.0 | `(*strings.Builder).grow`                                              |
|  1,825 |  1.0 | `tsoptions.GetNameMapFromList`                                         |
|  1,740 |  0.9 | `(*strings.Builder).Grow`                                              |
|  1,678 |  0.9 | `checker.initializeChecker`                                            |
|  1,647 |  0.9 | `bytealg.IndexByteString`                                              |
|  1,310 |  0.7 | `checker.CompareTypes`                                                 |
|  1,288 |  0.7 | `checker.compareNodes`                                                 |
|  1,235 |  0.6 | `scanner.Scan`                                                         |
|  1,176 |  0.6 | `slices.insertionSortCmpFunc[*ast.Symbol]`                             |
|  1,164 |  0.6 | `binder.NameResolver.Resolve`                                          |
|  1,158 |  0.6 | `core.TextRange.Pos`                                                   |
|  1,126 |  0.6 | `checker.getMergedSymbol`                                              |
|  1,053 |  0.6 | `checker.addTypeToUnion`                                               |
|    952 |  0.5 | `binder.bind`                                                          |
|    926 |  0.5 | `tsoptions.parseCompilerOptions`                                       |
|    892 |  0.5 | `checker.NewChecker`                                                   |
|    882 |  0.5 | `checker.isDeclarationContainedBy`                                     |
|    882 |  0.5 | `bytealg.LastIndexByteString`                                          |

Checker creation + check alone (warm es5, ~66.7k): `checker` 55%, `ast`
20%, `slices` 7.6% (sorting merged symbols), `core` 7%.

Fresh es5 hot spots (parse + bind): `ForEachChild` 3.50M (15%),
`scanASCIIWhile` 2.48M, `Scanner.Scan` 2.00M, `stringutil.ContainsNonASCII`
1.53M, `bytealg.IndexByteString` 1.44M (a SIMD primitive natively; a byte
loop here), `Scan$3` 1.22M, `binder.bind` 0.88M. Process start: `unicode`,
`golang.org/x/text` tables, `regexp` compiles (about 0.4M), `crc32` table,
`diagnostics` tables, `stringutil` init.

Instruction mix (warm es5 check): BinOp 21%, If 18%, Phi 11%, Call 10%,
FieldAddr 9%, UnOp (loads) 8%, Jump 6%, Return 5%, Store 3%, Index 3%.
Phi + Jump are 16.6%.

## Events on the check path (warm es5: whole second check / checker creation + check)

| event                                             |              warm check |    creation + check |
| ------------------------------------------------- | ----------------------: | ------------------: |
| static calls                                      |                   9,568 |               4,954 |
| interface method calls                            |                     476 |                 269 |
| calls through func values / closures              |                372 / 27 |             249 / 0 |
| `len` / `append` / `cap` / `copy`                 | 7,501 / 890 / 382 / 126 |  989 / 138 / 85 / 7 |
| heap allocs (`Alloc` escaping)                    |                   1,532 |                 772 |
| local allocs                                      |                     452 |                 329 |
| MakeSlice / MakeMap / MakeClosure / MakeInterface |     67 / 89 / 276 / 261 |                   — |
| map lookups / updates / ranges (next)             |    566 / 349 / 20 (219) | 352 / 177 / 7 (198) |
| type asserts                                      |                     475 |                   — |
| defers                                            |                      87 |                  31 |
| `recover` calls                                   |                       1 |                   0 |
| goroutines (`go`)                                 |                   **0** |                   0 |
| channel make / send / recv / select               |                   **0** |                   0 |
| panics                                            |                   **0** |                   0 |

Whole runs (fresh, both modes): no `go`, `Select`, `Send`, `Panic`
instruction anywhere; one `MakeChan` in an initializer. `--singleThreaded`
gives a goroutine-free path (`core.singleThreadedWorkGroup`).

## Surprises

- **Option parsing is 40% of the warm check**: `ParseCommandLine` rebuilds
  lower-cased option-name maps every time (`strings.ToLower`, 55.6k). A boot
  image should keep the parsed command line or those maps (an overlay that
  memoizes `GetNameMapFromList` removes most of it).
- **Reflection on the path**: `core.CompilerOptions.Clone` and the
  `tsoptions` converters use `reflect` (`TypeFor`, `ValueOf`, `Field`,
  `Set`, `Kind`) during option parsing, and `reflect.TypeFor` runs in
  initializers. Needs Go overlays (as planned in stage 2).
- **xxh3 with pointer arithmetic** (`unsafe.Pointer` over string data)
  computes the checker's cache keys; needs a safe port or a primitive.
- **Results depend on map iteration order**: es5 `check` ranges from 31.7k
  to 35.7k instructions over 10 runs. The reference interpreter and the
  type-level runtime need a fixed iteration order to match each other.
- `strings.Builder.copyCheck` (3%) is pure overhead in a single-goroutine
  world; another cheap overlay.
- Package initialization (1.08M, plus the std ones not interpreted) is
  ~6× the warm check: it belongs in the boot image.

## WebAssembly route

wasmtime 50.0.1 (Python bindings) with fuel metering, read at the
harness's phase marks through a `go:wasmimport` host call
(`experiments/stage0/ops/wasm/run.py`). Fuel counts every executed wasm
operator except `nop`, `drop`, `block`, `loop`, `end`, `else`,
`unreachable` and `return` (wasmtime's fuel costs). Builds: `GOOS=wasip1
GOARCH=wasm` from the v7.0.2 source with Go 1.27.4. The npm package
`@typescript/typescript-wasip1-wasm` exists only as 7.1.0-dev builds (no
7.0.x); `7.1.0-dev.20261114.1` measured once for reference.

| run                                                        |                      wasm operators |            SSA instructions |  wasm / SSA |
| ---------------------------------------------------------- | ----------------------------------: | --------------------------: | ----------: |
| harness: Go runtime + package init                         |                          34.3–34.5M | 1.08M (+ skipped std inits) |         ~32 |
| harness `cli`, mini (fresh check)                          |                           3,151,138 |                     336,138 |         9.4 |
| harness `cli`, es5 (fresh check)                           |                          94,214,495 |                  22,320,402 |         4.2 |
| harness warm check, mini                                   |                           2,076,286 |                     161,435 |        12.9 |
| harness warm check, es5                                    | 2,940,862 (2.57M in an earlier run) |                     189,847 | 15.5 (13.5) |
| `tsgo.wasm --version`                                      |                          41,017,818 |                             |             |
| `tsgo.wasm`, mini, whole process                           |                          44,008,225 |                             |             |
| `tsgo.wasm`, es5, whole process                            |                         132,487,047 |                             |             |
| official 7.1.0-dev `tsc.wasm`, mini / es5 (absolute paths) |            44,745,309 / 117,994,257 |                             |             |

The warm wasm count varies with GC timing (`warm:global` 1.0M–1.4M). The
gap is runtime work SSA leaves out: allocation, GC, map hashing, write
barriers and the wasm calling convention (Go on wasm keeps its own stack in
linear memory).

## Feasibility in one line

At the Lua route's ~1,450 instantiations per IR op (243M / 167k), the
warm es5 check (190k SSA instructions) is ~275M instantiations, under the
500M gate. The per-op cost of a Go runtime in types is what the heap
measurements must settle; dropping per-check option parsing would bring
it to ~113k instructions.
