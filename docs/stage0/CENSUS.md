# Stage 0.3: census of the TypeScript 7 compiler

What the engine must support to run

```
tsgo --noLib --noEmit --skipLibCheck --singleThreaded <lib.d.ts> main.ts
```

and how big that is. Source: `github.com/microsoft/typescript-go` at v7.0.2,
Go 1.27.4, darwin/arm64 unless noted, `CGO_ENABLED=0`. Tool, method and
raw data: `experiments/stage0/census/` (`census.sh` reproduces every number
here in about a minute; per-function data in
`out/harness-all.functions.json.gz`, tables in `out/*.report.md`).

The single-threaded flag is **`--singleThreaded`**
(`internal/tsoptions/declscompiler.go:233`). With it every `core.WorkGroup`
is a `singleThreadedWorkGroup` (a slice of closures run in a loop), files are
parsed and checked in sequence with one checker, and no `go` statement in
the compiler runs. Without it `parallelWorkGroup` uses `sync.WaitGroup.Go`.
Output with and without the flag is identical on the corpus (checked on the
one input that differs from the oracle, below).

## Configurations measured

| name        | entry                                                                                                                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| full        | unmodified `cmd/tsgo` (`--lsp`, `--api`, `-b`, `--watch` all reachable)                                                                                                                                                                                                               |
| cli         | `main` calls `performCompilation` in `internal/execute` directly; LSP/API files of `cmd/tsgo` stubbed                                                                                                                                                                                 |
| **harness** | `overlay/harness_main.go.txt`: read the named files once, then `check(files, args)` on an in-memory `vfstest` FS, output to a buffer. No `internal/execute`, no OS access inside `check`. **This is the configuration the engine should run; numbers below are for it unless noted.** |

The harness reproduces native output: 652 of the 656 runs (328 inputs × 2
lib modes) match `../ts-in-lua-in-types/oracle/expected` byte for byte, and
the same 4 differ for unmodified `tsgo` and for the native `tsc` 7.0.2
binary: `error-this-implicit.ts` and `extreme/template-cross-product.ts`
in both modes. Those expected files came from tslua, not from `tsc`; stage
3 should regenerate the oracle from the native binary.

## Sizes

SSA counts are `go/ssa` with instantiated generics: functions / basic
blocks / instructions. "code" excludes package initializers and the
packages the engine replaces with its own runtime (`runtime`, `runtime/*`,
`internal/runtime/*`). Executed = functions that ran in at least one run
(coverage, see the tool's README for the rules); "executed blocks" counts
only the blocks that ran (an upper bound).

| set                         |                         full |                          cli |                        harness |
| --------------------------- | ---------------------------: | ---------------------------: | -----------------------------: |
| RTA reachable               | 88,696 / 225,646 / 1,446,288 | 78,510 / 179,163 / 1,216,695 |   77,560 / 174,072 / 1,109,883 |
| VTA reachable               | 25,669 / 151,261 / 1,003,921 |   18,116 / 104,504 / 772,030 | **17,807 / 103,182 / 685,532** |
| ↳ code                      |   24,344 / 143,916 / 659,468 |    16,962 / 97,964 / 437,811 |  **16,697 / 96,827 / 431,008** |
| ↳ package initializers      |          192 / 576 / 310,821 |          168 / 504 / 304,995 |            147 / 441 / 225,976 |
| ↳ runtime packages          |       1,133 / 6,769 / 33,632 |         986 / 6,036 / 29,224 |           963 / 5,914 / 28,548 |
| executed code, corpus union |     8,670 / 47,517 / 201,602 |     8,496 / 46,845 / 198,682 |   **8,467 / 47,019 / 199,323** |
| ↳ executed blocks only      |               153,590 instrs |               151,269 instrs |             **151,924 instrs** |

Harness, executed code by input set:

| inputs              | functions | blocks | instructions | instrs in executed blocks |
| ------------------- | --------: | -----: | -----------: | ------------------------: |
| one-liner, mini lib |     3,930 | 18,120 |       77,339 |                    50,018 |
| one-liner, es5 lib  |     4,437 | 20,232 |       86,149 |                    58,311 |
| 328 inputs, mini    |     8,374 | 46,436 |      196,915 |                   149,023 |
| 328 inputs, es5     |     8,455 | 46,958 |      199,071 |                   151,014 |
| all 658 runs        |     8,467 | 47,019 |      199,323 |                   151,924 |

By kind (harness, VTA / executed, functions and instructions): source
functions 11,081 / 383,157 and 5,572 / 198,954; closures 1,006 / 25,417 and
402 / 11,124; generic instances 1,570 / 30,678 and 742 / 13,305;
range-over-func bodies 84 / 2,788 and 20 / 526; synthetic wrappers 3,742 /
17,516 and 2,724 / 12,847; functions without bodies 177 (below).

Reading the numbers:

- RTA is useless as a size: it keeps every method of every type converted to
  an interface (59,227 functions in `internal/ast` alone, mostly promoted
  method wrappers of the node types). Use VTA.
- **The emitted program is ~431k SSA instructions of code (static) or ~200k
  if only corpus-executed functions are emitted in full** and the rest become
  trapping stubs. 152k instructions sit in blocks that ran.
- Package initializers are a third of the static size (226k instructions)
  and almost all data tables: `unicode` 83,463, `stringutil` 45,297 (a
  2,928-entry `map[rune]specialCasingMapping`), `x/text/internal/language`
  31,961, `diagnostics` 21,717 (message table), `internal/strconv` 6,226,
  `tsoptions` 4,929. Run them once in the reference interpreter and ship
  the resulting heap as the boot image; do not emit or run them in types.
- Packages statically reachable but (nearly) never executed under
  `--noEmit`: `transformers/*` (estransforms 21,605 instructions, 36
  functions executed; declarations 9,291; tstransforms 7,732;
  moduletransforms 6,059), `encoding/json/v2` 11,270 (13 executed),
  `math/big` 5,809 (init only), `time` 5,927, `module` 5,743. `printer`
  (19,339) is used: types are printed for messages.
- One-liner: ~4k functions and 77–86k instructions of code run, ~2× less
  than the corpus union; the es5 lib adds ~500 functions (lib parsing and
  binding paths).
- wasip1/wasm changes little (VTA code 428,926 instead of 431,008) but has
  fewer bodyless functions (140 vs 177) and selects pure-Go `xxh3`.

### Top packages (harness, VTA instructions)

| package                          | VTA fns | VTA instrs | exec fns | exec instrs | exec-block instrs |
| -------------------------------- | ------: | ---------: | -------: | ----------: | ----------------: |
| ts/checker                       |   3,399 |    123,126 |    2,460 |      97,833 |            72,307 |
| unicode                          |      18 |     83,920 |        6 |      83,669 |            83,634 |
| ts/ast                           |   5,063 |     48,230 |    3,077 |      25,412 |            23,614 |
| ts/stringutil                    |      45 |     46,070 |       19 |      45,656 |            45,525 |
| x/text/internal/language         |      95 |     35,313 |       46 |      33,892 |            33,046 |
| runtime                          |     832 |     31,256 |      896 |      38,894 |            31,285 |
| ts/diagnostics                   |      30 |     30,572 |       14 |      21,883 |            21,831 |
| ts/transformers/estransforms     |     504 |     21,605 |       36 |         175 |               175 |
| ts/printer                       |     772 |     19,339 |      224 |       6,055 |             3,898 |
| slices                           |     561 |     16,031 |      248 |       5,812 |             5,398 |
| ts/parser                        |     646 |     15,353 |      490 |      10,775 |             8,707 |
| ts/tsoptions                     |     209 |     11,681 |       44 |       6,757 |             5,759 |
| encoding/json/v2                 |     188 |     11,270 |       13 |         743 |               481 |
| ts/compiler                      |     337 |     10,961 |      125 |       5,799 |             3,513 |
| internal/strconv                 |      76 |      9,729 |       30 |       7,680 |             7,080 |
| reflect                          |     270 |      9,569 |       71 |       1,442 |               851 |
| ts/transformers/declarations     |     221 |      9,291 |        8 |          36 |                36 |
| ts/scanner                       |     162 |      9,287 |      106 |       6,598 |             4,840 |
| ts/core                          |     474 |      7,918 |      319 |       5,804 |             5,694 |
| ts/transformers/tstransforms     |     150 |      7,732 |        6 |          24 |                24 |
| ts/binder                        |     210 |      6,442 |      171 |       5,503 |             4,688 |
| encoding/json/jsontext           |     189 |      6,316 |       24 |         474 |               397 |
| ts/transformers/moduletransforms |     138 |      6,059 |        8 |          29 |                29 |
| regexp/syntax                    |      99 |      6,002 |       73 |       4,963 |             3,482 |
| time                             |     129 |      5,927 |       12 |         442 |               338 |
| math/big                         |     135 |      5,809 |        1 |         143 |               143 |
| ts/module                        |     122 |      5,743 |        9 |         318 |               141 |
| github.com/zeebo/xxh3            |      42 |      5,339 |       17 |       1,803 |             1,560 |
| compress/flate                   |      50 |      4,464 |        1 |       2,551 |             2,551 |
| x/text/language                  |      27 |      4,388 |       20 |       3,698 |             3,637 |
| regexp                           |     100 |      4,228 |       48 |       2,678 |             2,199 |
| x/text/internal/language/compact |       8 |      3,946 |        8 |       3,946 |             3,809 |
| math/rand                        |       1 |      3,553 |        1 |       3,553 |             3,553 |
| strconv                          |      41 |      3,404 |        8 |       2,553 |             2,547 |
| ts/collections                   |     330 |      2,975 |       86 |         906 |               884 |
| fmt                              |      64 |      2,968 |       27 |       1,952 |               944 |
| ts/modulespecifiers              |      59 |      2,940 |        1 |          24 |                24 |
| ts/transformers/jsxtransforms    |      59 |      2,321 |        2 |         274 |               274 |
| strings                          |      87 |      2,249 |       48 |         891 |               572 |
| encoding/json/internal/jsonwire  |      44 |      2,168 |        2 |         334 |               304 |

(`ts/` = `github.com/microsoft/typescript-go/internal/`; per-package
instructions include the package's initializer. Groups, VTA: tsgo 13,566
functions / 403,711 instructions, std 4,046 / 232,595, third-party 194 /
49,222.)

## Feature census

Static = instructions in VTA-reachable functions; executed = instructions
in executed blocks of the corpus runs (both include package initializers;
harness configuration).

| feature                                               |           static instrs | static fns |        executed instrs | executed fns |
| ----------------------------------------------------- | ----------------------: | ---------: | ---------------------: | -----------: |
| `go`                                                  |                       4 |          4 |                      3 |            3 |
| `make(chan)` / send / recv / close                    |           2 / 1 / 1 / 1 |            |          2 / 1 / 1 / 1 |              |
| `select`                                              |                       0 |          0 |                      0 |            0 |
| `defer`                                               |                     242 |        221 |                     54 |           51 |
| `panic`                                               |                     926 |        778 |                    44* |           42 |
| `recover()`                                           |                      14 |         14 |                     12 |           12 |
| sync.Mutex / RWMutex calls                            |                144 / 30 |    72 / 12 |                32 / 14 |       17 / 5 |
| sync.Once / OnceValue / OnceFunc                      |             41 / 26 / 6 |            |            11 / 26 / 4 |              |
| sync.WaitGroup                                        |                       7 |          6 |                      0 |            0 |
| sync.Pool                                             |                      50 |         40 |                     25 |           21 |
| sync.Map                                              |                      97 |         76 |                     18 |           13 |
| sync/atomic calls                                     |                     200 |        131 |                    122 |           89 |
| reflect calls                                         |                   1,350 |        318 |                    140 |           68 |
| unsafe.Pointer conversions                            |                   1,401 |        480 |                    841 |          351 |
| unsafe.String / StringData / Slice / SliceData / Add  |      7 / 2 / 14 / 1 / 6 |            |      4 / 0 / 6 / 1 / 4 |              |
| calls to bodyless functions                           |                     730 |        459 |                    558 |          366 |
| closures (`MakeClosure`) / bound methods              |             1,234 / 336 |  862 / 216 |              579 / 163 |    428 / 110 |
| interface calls (`invoke`)                            |                   1,592 |        794 |                    254 |          151 |
| calls through func values                             |                   1,471 |        988 |                    488 |          357 |
| static calls                                          |                  70,252 |     14,264 |                 26,043 |        7,714 |
| `MakeInterface`                                       |                   4,167 |      1,952 |                  1,016 |          500 |
| type assertions to concrete / to interface (comma-ok) |          934 / 74 (285) |            |         385 / 14 (104) |              |
| map make / lookup / update / range                    |  359 / 518 / 4,503 / 95 |            | 206 / 240 / 4,228 / 38 |              |
| `delete` / `clear`                                    |                 18 / 48 |            |                 7 / 17 |              |
| `[][]T` allocations                                   |                      14 |         13 |                      9 |            8 |
| string↔[]byte / string↔[]rune / int→string            |           196 / 17 / 40 |            |             17 / 5 / 2 |              |
| `range` over string                                   |                      36 |         32 |                      8 |            8 |
| string index / slice / `+` / compare                  | 708 / 843 / 623 / 3,789 |            |   197 / 155 / 26 / 590 |              |
| float-typed instructions                              |                     700 |        199 |                    234 |           76 |
| int↔float conversions                                 |                     133 |         84 |                     76 |           39 |
| 64-bit integer binops (of which `* / %`)              |          23,803 (1,356) |      4,310 |            9,290 (594) |        2,054 |
| complex-typed instructions                            |                      16 |          9 |                      2 |            1 |
| time / os+syscall calls                               |               407 / 245 |  109 / 118 |               45 / 111 |      34 / 66 |
| fmt / strconv / math calls                            |         534 / 192 / 210 |            |           79 / 52 / 38 |              |
| sort / slices calls                                   |              52 / 1,051 |            |               22 / 423 |              |
| strings.Builder calls                                 |                     297 |         86 |                     75 |           27 |
| unicode table references                              |                   1,106 |         11 |                  1,082 |            3 |
| regexp calls                                          |                     142 |         54 |                     81 |           29 |
| unique / weak / iter.Pull / defer in loop             |                       0 |          0 |                      0 |            0 |
| runtime.SetFinalizer                                  |                       2 |          2 |                      2 |            2 |
| `print`/`println` builtins                            |                     221 |         96 |                      0 |            0 |

\* artifact: synthetic range-over-func panic blocks have no position and are
counted with their function. No panic was raised in any run: every
`recover()` that ran returned nil (the `if r != nil` bodies have zero
coverage) and every run exited normally with oracle-matching output.

Integer binops by width, executed: 64-bit 9,054, 32-bit 6,489, 16-bit 4,535
(`ast.Kind` is `int16`: 4,110 of these are `==`), 8-bit 1,018. Static:
23,358 / 9,953 / 7,381 / 2,698.

Map key types (make+lookup+update+range instructions, static / executed):
string 1,838 / 1,335, integer 3,077 / 3,014 (the `specialCasing` initializer
is 2,928 of them), pointer 301 / 179, struct 208 / 151 (cache keys:
`CacheHashKey` = 128-bit hash, `CachedTypeKey`, `ReverseMappedTypeKey`…),
array 30 / 30 (`map[[11]byte]int16` in x/text), interface 14 / 0, bool 4 /
0, float 3 / 3. 216 distinct map types reachable, 148 used.

Interfaces: 353 distinct interface methods invoked statically (131
executed), 562 concrete types converted to interfaces (308 executed). The
AST is a `Node` struct with a `nodeData` interface and `Kind` switches, so
dispatch is mostly integer compares, not `invoke`.

Generics: 1,570 instances of 283 generic functions reachable, 742 instances
of 172 executed. Most instantiated: `slices.Grow` 100, `core.Arena[T].New`
87, `core.IfElse` 68, `core.LinkStore.Get` 32, `core.Map` 27, pdqsort
helpers ~36 each (`slices.SortFunc`).

Range-over-func: 84 yield bodies reachable, 20 executed; SSA lowers them to
closures plus state checks, nothing extra for the engine. No `iter.Pull`
(which would need coroutines).

cgo: none (no package imports `C` with `CGO_ENABLED=0`; the compiler's
darwin FS-event code uses `syscall` and linkname, and is unreachable in the
harness).

### Where the hard features are

- **Goroutines.** The 4 reachable `go` statements are 3 in `runtime` (GC
  workers, finalizer and cleanup goroutines; these ran) and
  `sync.WaitGroup.Go` (the parallel work group; never runs with
  `--singleThreaded`). Unmodified `tsgo` adds `os/signal.NotifyContext`
  (a goroutine and a channel) and `osvfs`'s semaphores (buffered channels);
  the harness has neither.
- **Channels.** Harness: only `context`'s `closedchan` (`make` + `close` at
  init) and the runtime's GC worker channel. No `select` is reachable.
- **defer/panic/recover.** `defer` is common (242 sites; 54 ran: mutex
  unlocks, pool puts, `sync.Once`, tracing). The 12 `recover()` calls that
  ran are all "recover and re-panic / report error" wrappers:
  `sync.OnceValue/OnceFunc` (7), `fmt.(*pp).catchPanic`,
  `regexp/syntax.parse` (`ErrLarge`/`ErrNestingDepth`), x/text
  `language.Parse` (2), `bytes.growSlice`. **No recover-for-control-flow on
  the check path.**
- **Reflection** that ran, by caller: `fmt` (50 functions, printing
  diagnostics), `encoding/json/v2` (34; only for `jsnum.Number.String`,
  which formats a float64 with `json.Marshal`), `tsoptions` (3;
  `MergeCompilerOptions` copies struct fields with `reflect`), `core` (2;
  `CompilerOptions.Clone`), `reflect.TypeFor` in initializers
  (`encoding/json/v2`, `core`, `tsoptions`, `collections`, `packagejson`).
  Statically also `internal/fmtsort`, `encoding/binary`.
- **unsafe.** Pointer conversions are 607 in `runtime`, 381 `reflect`, 110
  `internal/abi`, 81 `xxh3` (reading `uint64`s out of strings), 58
  `syscall`, 40 `slices` (`overlaps`), 33 `internal/runtime/maps`, 28
  `sync`, 19 `sync/atomic`, `math.Float64bits`/`Float64frombits`. In
  compiler code only three `unsafe.String(&b[0], n)` sites:
  `tspath.ToFileNameLowerCase`, `vfs/internal.Common.ReadFile` (and
  `vfstest` in the harness); plus `strings.Builder.String`.
- **Assembly / linkname / runtime-provided** functions called from executed
  blocks (harness, darwin/arm64): `internal/bytealg` (`Compare`,
  `CountString`, `IndexByte`, `IndexByteString`, `IndexString`,
  `MakeNoZero`, `cmpstring`), `sync/atomic` (15: Add/CAS/Load/Store/Swap of
  32/64/ptr), `xxh3.accumNEON`/`accumBlockNEON` (arm64 only; pure Go on
  wasm), `math.archMin` (darwin; `archCeil/Floor/Trunc` on wasm),
  `maps.clone`, `reflect` (`typedmemmove`, `unsafe_New`, `resolveNameOff`,
  `resolveTypeOff`, `getStaticuint64s`), `sync` (`runtime_procPin/Unpin`,
  `runtime_registerPoolCleanup`, `runtime_Semrelease`,
  `runtime_notifyListCheck`), `internal/godebug` (`setUpdate`,
  `setNewIncNonDefault`), `time.runtimeNano/runtimeNow`,
  `os.runtime_args/runtime_beforeExit`, `syscall` (`Exit`, `runtime_envs`,
  `syscalln`, `rawsyscalln`), `internal/runtime/maps` and
  `internal/runtime/atomic` (only from runtime code), `internal/abi.FuncPC*`,
  `chacha8rand.block`. 177 bodyless functions are VTA-reachable (140 on
  wasip1).
- **Floats** that ran: `jsnum` (JS numbers are `float64`: literal parsing
  via `strconv.ParseFloat`, `math.Copysign`, `IsNaN`, `IsInf`, formatting),
  `checker` (numeric literal and enum types), `core.levenshteinWithMax` and
  `GetSpellingSuggestion` (`math.Floor/Min/Ceil` on distances), `evaluator`
  (constant folding), `scanner`, `internal/strconv`.
- **64-bit integers** everywhere (`int` is 64-bit; node and symbol ids are
  `uint64` atomics); 64×64→128 multiplication only in `xxh3` (cache-key
  hashing in `checker.keyBuilder`, `ast.SourceFile.Hash`).
- **Time/OS/syscall on the check path:** none in the harness except
  `vfstest`'s clock (`time.Now`) and `time.Time.Sub` in
  `EmitFilesAndReportErrors`. All `os`/`syscall` calls are the harness
  reading files before `check`, writing output after it, and package
  initializers (`os.init`, `syscall.init`).
- **regexp** at check time only in `diagnostics.Format` (every diagnostic
  with arguments, so the one-liner runs it: `{(\d+)}`); `regexp.MustCompile`
  runs in four initializers and `semver.TryParseVersion` at init.
- **unicode tables**: data in initializers; at check time `unicode.Is` only
  for non-ASCII identifiers and whitespace (`stringutil`, `jsnum`), and
  `unicode.ToLower` in spelling suggestions.
- **Others**: `golang.org/x/text/language` parses the locale on every run
  (`locale.Parse`; 44k instructions of tables and matcher code);
  `internal/bundled` imports `testing` (pulling in `testing`, `flag`,
  `math/rand`, `runtime/trace` initializers); `unique`/`weak` only via
  `net/netip`, which the harness no longer imports.

## Strategies

| area                 | strategy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| goroutines, `select` | Not on the check path. `go` traps ("goroutine not supported") in the engine; no scheduler for stage 3. A run-to-completion queue can come later if a program needs it.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| channels             | Buffered channels as a queue (send fails into a trap only if it would block); `close`, receive from closed. Enough for `context` and `osvfs` semaphores if they ever come back.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `defer`, `RunDefers` | Implement in the runtime (per-frame defer list, run on return).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `panic`, `recover`   | `panic` aborts the run with the message (like an unrecovered Go panic, which is what native `tsgo` does); `recover()` returns nil. Exact unwinding is not needed for any measured input; keep it as a later extension.                                                                                                                                                                                                                                                                                                                                                                                      |
| sync                 | **Overlay `sync`** with single-threaded versions: `mutex.go`, `rwmutex.go`, `waitgroup.go`, `once.go`, `oncefunc.go`, `pool.go` + `poolqueue.go` (Pool = a slice or always `New`), `map.go` (`sync.Map` on a plain map; the real one is `internal/sync.HashTrieMap`, which hashes keys with the runtime's type hashers through `unsafe`), `cond.go`, `runtime.go`.                                                                                                                                                                                                                                          |
| sync/atomic          | Engine intrinsics (plain loads/stores/adds/CAS); the `atomic.Bool/Int32/Uint64/Pointer` methods are Go and stay.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| reflect              | Make it dead on the check path with overlays (fmt, jsnum, tsoptions, core below). The reference interpreter needs `reflect.TypeFor` only while building the boot image (initializers); stub it to an opaque type value.                                                                                                                                                                                                                                                                                                                                                                                     |
| fmt                  | **Overlay `fmt`** with a small implementation of `Fprint(f/ln)`, `Sprint(f/ln)`, `Errorf`, `Fprintf`: verbs `%s %d %v %q %x %*s %*d %%` on basic types, `error`, `Stringer`. Call sites on the path: `diagnosticwriter` (`"%s(%d,%d): "`, `"%s TS%d: "`, padded `%*d`), `diagnostics.StringifyArgs`, `NodeBuilder.mapToTypeNodes`.                                                                                                                                                                                                                                                                          |
| encoding/json        | **Overlay `internal/jsnum/string.go`**: `Number.String` via `strconv.AppendFloat` plus the ES formatting rules `jsonwire.AppendFloat` applies, instead of `json.Marshal`. Then `encoding/json/v2` is off the check path (still needed for tsconfig/package.json, not exercised).                                                                                                                                                                                                                                                                                                                            |
| reflect field copies | **Overlay `internal/tsoptions/parsinghelpers.go`** (`MergeCompilerOptions`) and **`internal/core/compileroptions.go`** (`Clone`) with generated field-by-field code (generator script over the `CompilerOptions` struct).                                                                                                                                                                                                                                                                                                                                                                                   |
| unsafe.Pointer       | Dead on the check path once `runtime`, `reflect`, `internal/runtime/maps`, `sync`, `xxh3` are replaced. Remaining: `math.Float64bits/frombits` (and 32-bit) as front-end intrinsics (identity on the soft-float bit pattern); `slices.overlaps` as an intrinsic (aliasing test on slice values).                                                                                                                                                                                                                                                                                                            |
| unsafe.String & co   | Front-end replacement by name of the four sites: `strings.(*Builder).String` → `string(b.buf)`; `tspath.ToFileNameLowerCase`, `vfs/internal.(*Common).ReadFile`, `vfstest` → `string(b)`. Overlays of `strings/builder.go` work too.                                                                                                                                                                                                                                                                                                                                                                        |
| assembly             | `internal/bytealg` as engine intrinsics (`IndexByte`, `IndexByteString`, `IndexString`, `Compare`/`cmpstring`, `Count`, `MakeNoZero`): they back `strings.Index`, `==`/`<` on strings, and are hot. `math`: **overlay `floor_asm.go`, `dim_asm.go`, `exp_asm.go`, `exp2_asm.go`, `hypot_asm.go`, `log_asm.go`** with the pure-Go variants (`haveArch* = false`), so the `.s` stubs are never called. `xxh3`: see hashing. `internal/godebug`, `chacha8rand`, `time.runtimeNano/Now`, `os.runtime_args`, `syscall.runtime_envs`: intrinsics returning constants (nil env, fixed time 0, deterministic seed). |
| hashing (xxh3)       | **Overlay `github.com/zeebo/xxh3`** with a small pure-Go package of the same API (`Hasher`, `Uint128`, `HashString128`, `Hash128`): e.g. two-lane FNV-1a or a simple multiply-xorshift over bytes. The checker uses the hashes only as map keys (`CacheHashKey`), `ast.SourceFile.Hash` as an identity; verify on the corpus that output is unchanged. Removes NEON/AVX assembly, unsafe reads and 64×64→128 multiplies from the hottest path.                                                                                                                                                              |
| maps                 | Runtime maps keyed by string, integers (all widths), pointers, structs and fixed arrays (structural equality + hash in the engine); interface keys never executed (support later). Iteration order: insertion order is a legal Go order and deterministic.                                                                                                                                                                                                                                                                                                                                                  |
| strings              | Bytes plus UTF-8 decode for `range` and `[]rune`; 26 executed `+` sites, 17 `[]byte`↔string conversions: cheap enough as copies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| floats               | Soft float in Go source: the front end lowers float arithmetic, comparisons and conversions to calls of Go's own `runtime/softfloat64.go` functions (`fadd64`, `fmul64`, `fdiv64`, `fcmp64`, `f64toint64`, `fint64to64`, …) compiled like any other Go code; a float is its `uint64` bit pattern in the value model. `strconv`'s float parsing and formatting is pure Go on `uint64`.                                                                                                                                                                                                                       |
| complex              | Trap (only `fmt`/`reflect` type switches, gone with the `fmt` overlay).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 64-bit ints          | Native in the value model, all widths 8–64 signed/unsigned with wraparound; 16-bit compares (`ast.Kind`) are the most frequent integer op.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| time, os, syscall    | The harness keeps them out of `check`; `vfstest.FromMapWithClock` with a fixed clock instead of `FromMap`. Initializers of `os`/`syscall`/`time` run in the boot-image build with intrinsics above.                                                                                                                                                                                                                                                                                                                                                                                                         |
| regexp               | **Overlay `internal/diagnostics/diagnostics.go`**: `Format` replaces `{N}` with a byte scan. Initializer `MustCompile`s stay (boot image).                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| locale (x/text)      | Optional **overlay `internal/locale`** to a fixed English locale without `golang.org/x/text/language` (removes ~44k instructions and the language matcher from every run).                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `testing` import     | **Overlay `internal/bundled/bundled.go`** without `testing.Testing()` (drops `testing`, `flag`, `math/rand`, `runtime/trace` initializers).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| compress/gzip        | Only for localized message tables (`diagnostics`, non-English); initializer cost only. Optional overlay of the localized-messages file to English only.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| package initializers | Run offline in the reference interpreter; the boot image is the initialized heap (226k instructions of init, mostly tables).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| runtime              | Replaced by the engine runtime (SSA-level map/slice/string/interface ops never call it). Explicit runtime calls from std on the path are the intrinsics above plus `SetFinalizer` (no-op), `KeepAlive` (no-op).                                                                                                                                                                                                                                                                                                                                                                                             |
| entry point          | **Overlay `cmd/tsgo/main.go`** (harness `check(files, args) → output`), stub `sys.go`, `lsp.go`, `api.go`, `isprocessalive_*.go`. Removes `internal/execute`, LSP, API, watch, build mode, `osvfs`, `os/signal`, `golang.org/x/term`.                                                                                                                                                                                                                                                                                                                                                                       |

### Overlays needed (go build -overlay)

1. `cmd/tsgo/main.go` (harness; `experiments/stage0/census/overlay/harness_main.go.txt`
   is a working version), and empty `cmd/tsgo/{sys,lsp,api,isprocessalive_unix,isprocessalive_other}.go`.
2. `sync/{mutex,rwmutex,waitgroup,once,oncefunc,pool,poolqueue,map,cond,runtime}.go`:
   single-threaded `sync`.
3. `fmt` (small replacement package files).
4. `internal/jsnum/string.go`: `Number.String` without `encoding/json`.
5. `internal/tsoptions/parsinghelpers.go` and `internal/core/compileroptions.go`:
   generated field copies instead of `reflect`.
6. `internal/diagnostics/diagnostics.go`: `Format` without `regexp`.
7. `github.com/zeebo/xxh3` (module files in the module cache): pure-Go hash
   with the same API.
8. `math/{floor,dim,exp,exp2,hypot,log}_asm.go` → pure-Go variants (or
   build for a GOARCH where they are pure Go and keep the list short).
9. `internal/bundled/bundled.go`: drop the `testing` import.
10. Optional: `internal/locale` (fixed English), the localized-messages file
    in `internal/diagnostics` (no gzip), `strings/builder.go` (no unsafe).

Front-end replacements by name instead of file overlays (single functions in
large files): `slices.overlaps`, `math.Float64bits/Float64frombits/Float32bits/Float32frombits`,
`strings.(*Builder).String`, `tspath.ToFileNameLowerCase`,
`vfs/internal.(*Common).ReadFile`, `internal/bytealg.*`, `sync/atomic.*`.

Build configuration: `CGO_ENABLED=0 -tags purego`, `--singleThreaded`.
darwin/arm64 and wasip1/wasm give nearly the same reachable set; wasip1
needs fewer intrinsics (pure-Go `xxh3`, no `internal/poll`/`os/signal`
bodyless functions) but has its own syscall stubs; prefer whichever the
front end and reference interpreter find simpler, the overlays above are
the same.

## Method and caveats

- Reachability: `go/packages` + `ssautil.AllPackages(…, ssa.InstantiateGenerics)`,
  RTA from `main.init` and `main.main`, then `vta.CallGraph` seeded with
  RTA's graph and a reachability walk over it. 6 compiler closures ran but
  have no executed VTA edge (closures passed through generic helpers:
  `getExpandedParameters$1/$2`, `mapToTypeNodes$1$1`,
  `verifyCompilerOptions$5/$12/$13`): VTA is not quite sound for them; the
  front end should keep every closure created in a reachable function.
- Dynamic: `go build -cover -coverpkg=all` (Go 1.27 instruments `runtime`
  too). Coverage is per source block; the tool's README gives the rules
  that turn it into executed functions and blocks. Function counts are
  exact up to those rules; "executed blocks" is an upper bound (blocks with
  no source position count with their function).
- Counts are of SSA instructions in the code, not executed operations (that
  is OPS.md). Instance counts are after instantiation; the front end may
  share bodies of instances with the same shape.
- Coverage-writing code that runs at exit (`encoding/binary`, `os.Create`,
  `bufio`) shows up in the full and cli binaries' executed sets
  (a few hundred instructions), and in the harness's (`encoding/binary`
  is also statically reachable there).
