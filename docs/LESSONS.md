# Lessons from lua-in-types and ts-in-lua-in-types

Measured on tsrs 0.23.0-ts7.1.0-beta, run as `TSRS_FAST=1 tsrs --fast`.
Sources: `../lua-in-types/docs/AOT.md`, `../ts-in-lua-in-types/docs/PLAN.md`
and `docs/GATE.md`.

## Checker limits

- 5M instantiations per counter reset, then TS2589 (which also covers the
  depth limit ~100: always classify which one fired). The CLI resets the
  counter per statement and at the first resolution of a type node; a
  hover only at the first resolution of a literal type node. Long runs draw
  a fresh literal from a fuel pool before every chunk.
- ~1,000 tail-call hops per chain; tuples cap at 9,999 elements.
- The relation cache fills at ~16M entries (TS2859; hovers show `never`).
  It never empties within a checker. No `readonly` in tuple patterns.
- Nested `extends infer` in one alias is exponential: at most 4 bindings
  per alias.
- A `.ts` file checks every alias (167 s for the Lua image); a `.d.ts` with
  `skipLibCheck` loads lazily (2.3 s). Emit `.d.ts`.
- Property lookup on an object or interface type costs 0 instantiations:
  dispatch tables, `switch`es and constant sets are interface lookups.
- `--extendedDiagnostics` instantiation counts wrap at 2^32.
- tsrs has no profiler or trace output; diagnose with an instrumented build
  only, never ship on one.

## The heap cost problem (the central lesson)

Per-op cost grew with what the run had allocated: small benchmarks cost
60–260 instantiations per op, the full ts-in-lua-in-types gate's median was
5,143. Causes found:

1. Table shapes as object type literals: the checker treats those as
   possibly generic (couldContainTypeVariables) and walks young trie nodes.
   Fixed with interned interfaces.
2. Taking heap parts apart with tuple patterns computes a relation key that
   walks every tuple reachable from the source. Fixed by indexed access
   (`X["1" & keyof X]`) and forcing new nodes by a length test.
3. **Unsolved:** binding any value that holds the heap
   (`X extends infer h`, or a segment's `A extends [infer F, infer H, ...]`)
   still costs O(young), from the young tables' slot tuples (any tuple of
   15+ elements). Interface shapes, an interface box and a box with no alias
   arguments did not help.

A mid-run start at the same point was cheap (~28k instantiations per chunk
against ~550k in the full run), so staged snapshots (print state to a
`.d.ts`, resume in a fresh process) are the known fallback.

Rule: every runtime primitive gets a cost test at 0, 1k, 10k and 100k live
objects, and fails if cost grows.

## Costs to beat (Lua route)

~740 instantiations per call and return; 115 per near-empty block hop. The
tslua one-liner from its boot image: 167k IR ops, 243M instantiations,
12.9 s, 4.5 GB. Full gate: 409/656 (179 TS2589 count, 62 timeouts).

## Process

- Write the IR and value contracts first; measure exactly before planning.
- A reference interpreter with exact op counts, snapshots and mid-run pause
  from day one; mid-run snapshots gate the emitter.
- Slow paths (floats, formatting) written in the source language, not as
  type-level special cases.
- Boot image: run setup offline once, start every check from it.
- Tiered gates: a 2-minute smoke set per commit, 20 inputs per merge, the
  full gate on request.
- At most two heavy tsrs jobs at once (48 GB, 18 cores).
- Agent rounds bounded (~2 hours); stop and report after two failed
  hypotheses.
