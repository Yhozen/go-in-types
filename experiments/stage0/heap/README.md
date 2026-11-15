# Stage 0: heap cost experiments

Results and conclusions: `docs/stage0/HEAP.md`.

## Files

- `gen.ts`: writes one benchmark (a `.ts` file): a type-level heap with
  256 + N live objects, then a K-step interpreter loop that does one op per
  step (`none`, `read`, `write`, `alloc`) and passes the heap on by `arg`,
  `infer`, `inferc` (`infer H extends C`) or `tuple` (a state tuple taken
  apart by `[infer H, infer I, infer A]`). Options: `node` (trie nodes as
  `tuple`s or generic `iface`s), `obj` (`t16`, `t8`, `lua`, `i16`, `i8`) and
  `glit` (every object holds one value copied from a source-written object
  literal, the trigger of cost 3).
- `run.ts`: the driver. Each cell runs K and 2K steps on tsrs
  (`TSRS_FAST=1 tsrs --fast --singleThreaded --extendedDiagnostics`);
  cost per op is `(inst(2K) - inst(K)) / K`, which cancels building the
  heap and resolving every alias the first time. Every file asserts its
  result, and that the result is neither `any` nor `never`.
- `long.ts`: a long run (`node long.ts NODE OBJ N K ROUNDS [--diag BIN]`):
  ROUNDS chained statements of K writes each, distinct values per round;
  prints totals and, with `--diag`, the relation cache size.
- `lua_repro.py`, `lua_repro.sh`: cost 3 reproduced on the lua-in-types
  runtime (read-only import of `../lua-in-types/src/aot/types`).
- `tsrs-heapdiag.patch`: the diagnosis counters for tsrs v0.23.0.

## Running

    node experiments/stage0/heap/run.ts --k 100 --jobs 2 --out .run/main.json \
      node=tuple obj=t16,i8 bind=arg,infer,tuple,inferc op=read,write,alloc n=0,1024,10240,102400
    node experiments/stage0/heap/run.ts ... glit=1      # the cost-3 trigger
    node experiments/stage0/heap/run.ts ... --diag .run/target/release/tsrs
    sh experiments/stage0/heap/lua_repro.sh

`--diag` also runs the instrumented build and adds `rel/op` (new
relation-cache entries per op) and `walk/op` (instantiations under the
permissive and restrictive mappers per op). `--tsrs` picks another binary
(default `node_modules/.bin/tsrs`, the stock 0.23.0-ts7.1.0-beta). N must be a
multiple of 256. Keep `--jobs` at 2 or below (machine rule).

## Rebuilding the instrumented tsrs

    git clone --depth 1 --branch v0.23.0 https://github.com/oxc-project/tsrs.git .run/tsrs
    cd .run/tsrs && git apply ../../experiments/stage0/heap/tsrs-heapdiag.patch
    # cmake is needed by mimalloc's build script; a local one without touching the system:
    uv venv ../cmakeenv && VIRTUAL_ENV=../cmakeenv uv pip install cmake
    PATH=$PWD/../cmakeenv/bin:$PATH CARGO_TARGET_DIR=../target \
      CARGO_PROFILE_RELEASE_LTO=off CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 \
      CARGO_PROFILE_RELEASE_INCREMENTAL=true cargo build --release -p tsrs_cli

The tag is commit `fc38431` ("chore(release): prepare 0.23.0"); its
`--version` prints the same string as the npm package (`tsrs
0.23.0-ts7.1.0-beta, microsoft/TypeScript@3e9236361fa9`), and with
`--singleThreaded` the unpatched build and the npm binary report identical
instantiation and type counts. LTO is off to keep rebuilds at ~15 s; it does
not change counts.

Environment of the patched build (all off by default; output on stderr at
exit):

- `TSRS_HEAPDIAG=1`: counters (instantiations total / under the permissive
  mapper / under the restrictive mapper; permissive and restrictive calls
  and cache misses; `couldContainTypeVariables` computations; relation-key
  workers and their generic-argument visits; `inferFromTypes` steps;
  `isDeeplyNestedType`; relation calls; type references created and
  reused; deferred references created; conditional resolutions; largest
  relation size), then instantiations by alias (or type kind) and
  relation-cache misses by source and target kind (`REL a -> b`).
- `TSRS_HEAPDIAG_TOP=n`: rows of the by-label table (default 40).
- `TSRS_HEAPDIAG_TRACE=1`: one line per permissive-instantiation miss and
  per conditional with `infer` parameters (very verbose).

The upstream `site-counts` and `work-census` features
(`-p tsrs_checker --features tsrs_checker/site-counts`) also exist and were
not needed.
