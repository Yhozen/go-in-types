# go-in-types: plan

Goal: run real Go programs inside the TypeScript type checker (tsrs), so that
`ts-in-types` (a sibling repo, later) can run the real TypeScript 7 compiler,
whose source is Go (`vendor/typescript/tsc`, pinned at tag v7.0.2), and show
`tsc`'s output in a hover: `TS<"const x: number = 'hello';">` →
`main.ts(1,7): error TS2322: ...`.

This is the second engine of its kind. The first, lua-in-types v2 (sibling
checkout `../lua-in-types`, with `ts-in-lua-in-types` on top), works end to
end; its lessons are in `docs/LESSONS.md` and shape every stage here.

Each stage ends in a gate. Stage 0 can stop the project.

## Stage 0: measure before building

Three independent measurements, each written to `docs/stage0/*.md` with the
scripts that reproduce it under `experiments/stage0/`.

1. **Heap cost** (`docs/stage0/HEAP.md`). Build tsrs v0.23.0 from source
   with counters (instantiations per alias, relation-key and
   couldContainTypeVariables walks). Find a type-level heap representation
   whose read, write and _binding_ (passing the heap through `infer`, a
   tuple pattern or an alias argument) cost the same at 0, 1k, 10k and 100k
   live objects, measured on stock tsrs. If none exists, design staged
   snapshots (print the state to a `.d.ts`, resume in a fresh checker) as
   the standard way to run, and measure what a stage costs.
2. **Operation counts** (`docs/stage0/OPS.md`). Run the real compiler on the
   one-liner and count SSA instructions executed: total, after the lib is
   parsed and bound (the boot image point), and by package and function.
   Also count the official WebAssembly build (`typescript-wasip1-wasm`)
   once, to settle that route.
3. **Census** (`docs/stage0/CENSUS.md`). What the compiler's reachable code
   uses: goroutines, channels, `select`, sync primitives, `defer`/`panic`/
   `recover`, reflection, `unsafe`, generics, maps, closures, interfaces,
   standard-library packages; and its size in functions and SSA instructions
   after dead-code removal, for the `tsc` command on one file with
   `--singleThreaded`.

**Gate:** a flat-cost heap or a snapshot design we trust, and an operation
count that puts the one-liner (from a boot image) under ~500M
instantiations at the per-op cost the heap measurements give. Baseline to
beat: the Lua route runs the one-liner from its image in 167k IR ops and
243M instantiations. If the gate fails, stop and write up a hand-written
subset checker in types as the alternative.

**Result (2026-11-14): passed.** Heap: candidate A is flat from 0 to 100k
live objects (read 59, write 413, alloc ~360, pass-on 11–15
instantiations; HEAP.md). Ops: the warm es5 one-liner is 189,847 SSA
instructions (1.51× the Lua route's real-Lua count, 1.14× its IR ops), so
~275M instantiations at the Lua route's per-op cost (estimate); 40% of it
is option parsing (`strings.ToLower` over option-name maps), which the boot
image or an overlay should remove (OPS.md). WebAssembly is ~13–15× the SSA
count on the warm check: ruled out. Census: ~431k SSA instructions of
code, ~200k executed by the corpus; no goroutines run with
`--singleThreaded`; reflection is removable with overlays (CENSUS.md).

## Stage 1: the contract (planner)

`docs/DESIGN.md` and `src/ir/types.ts`: the IR as JSON close to Go's SSA
(functions, basic blocks, typed instructions, instantiated generics); the
value model (integers of every width, floats, strings, structs, arrays,
pointers, slices, maps, interfaces, closures, channels) in the reference
interpreter and in types; the rules every type-level file follows.

## Stage 2: front end and reference interpreter

1. **Front end** (`frontend/`, Go): source → `go/ssa` → reachable functions
   → IR JSON. The only non-TypeScript code; build time only.
2. **Reference interpreter** (`src/ref/`, TypeScript): runs the IR, with
   exact op counts, snapshots and mid-run pause from the start.
3. **Runtime** (`src/ref/runtime/` and Go overlays in `overlay/`): maps,
   slices, strings, interfaces, `defer`/`panic`/`recover`, a single-threaded
   goroutine scheduler with channels and sync; small replacements for
   reflection-heavy code (`fmt`, `encoding/json`, ...) as Go overlays.

**Gate:** a corpus of Go test programs and a fuzzer agree byte for byte
with native `go run`, and the reference's op counts match an independent
count (the stage 0 counter).

## Stage 3: TypeScript 7 on the reference (in `ts-in-types`)

Harness `check(files, args) → output`; oracle of the 328 inputs (from
`../ts-in-lua-in-types/oracle/inputs`) with expected output from the native
`tsc` 7.0.2 binary; boot image after libs are parsed and bound plus a
warm-up check; a profile of where a check's operations go.
**Gate:** 328/328 exact in both lib modes (es5, mini), fresh and from the
image.

## Stage 4: type-level runtime

Integers (8 to 64 bit, signed and unsigned, wraparound), floats (soft
float in Go source), heap, structs, pointers, slices, maps, interfaces on
the stage 0 heap; strings as bytes plus a UTF-8 encoder. Every primitive
has a fuzz test against the reference and a cost test at four heap sizes.
**Gate:** every primitive exact; cost flat.

## Stage 5: emitter

IR → `.d.ts` aliases; at most 4 `infer` bindings per alias; direct jumps
for static calls; pure leaf functions as nested aliases; interface method
calls and `switch` through emitted interface lookups (0 instantiations);
chunks ended by weighted work; start from any snapshot; shared bodies and
short names. **Gate:** all test programs and the fuzz set exact in types;
cost per op at any point of a long run matches small benchmarks.

## Stage 6: `TS<"…">` (in `ts-in-types`)

Image build, hover and CLI forms, a fuel pool seeded by a hash of the
source, tiered gates, demo files, README. **Gate:** the one-liner hovers
with the exact TS2322 line; ≥95% of the 656 checks pass, every failure
classified.

## Stage 7: extremes

Inner `Add<20, 22>`; staged runs through declaration emit; the boot image
produced by the type checker itself; a Rust census to decide on a tsrs
front end on the same runtime.

## Order

0 → 1 → 2 in sequence (stage 1 may start once the census is in); 3 in
parallel with 4; 5 needs 4; 6 needs 3 and 5.

## Targets (goals, not measurements)

One-liner hover under 5 s and 2 GB; emitted compiler under 60 MB; ~150
instantiations per call (Lua route: 740).
