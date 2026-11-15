# Stage 5: the emitter

`src/emit/` turns a program (`src/ir/types.ts`) into a `.d.ts` module of
type aliases that tsrs runs; `src/emit/rt.ts` is the hand-written
type-level runtime the emitted code calls (driver, calls and returns,
defers and panics, output). Values use the stage 4 encodings (DESIGN.md
"Type-level encodings"; `src/types/{int,nat,heap,str,map}.ts`).

    node scripts/emit.ts prog.json -o out.d.ts [--keep file]

This file is the contract with the run agent (codec and driver): **the
machine state shape below is stable**; changes are announced here (section
"Changes") and in commit messages.

## Machine state

Everything is a type-level value built by constructor aliases (H4). The
heap, and every tuple that holds it, is only ever passed as an alias
argument and read by indexed access (H2); nothing below is ever taken apart
by a tuple pattern.

### The driver state `S`

Between chunks (and between trampoline steps inside a chunk) the machine is
one 7-tuple, built by `rt.ts` `St<Tag, Key, H, K, X, A, F>`:

| index | name | meaning                                                                    |
| ----: | ---- | -------------------------------------------------------------------------- |
|     0 | Tag  | what the driver does next (below)                                          |
|     1 | Key  | for `"j"`: the entry to resume (a key of the program's entry table)        |
|     2 | H    | the heap (`src/types/heap.ts`; globals are its first objects)              |
|     3 | K    | the call stack: `null` or `[Cont, K]` (top first)                          |
|     4 | X    | machine extras `[Out, Err, Pn]`: stdout so far, stderr so far, panic chain |
|     5 | A    | the tag's argument (below)                                                 |
|     6 | F    | fuel left in this chunk (a string of `x`; see "Fuel")                      |

Tags and their `A`:

- `"j"`: resume entry `Key` with `A` (entry-specific: the saved registers
  of a block entry, or `[value, Regs, D]` for a call's return point).
- `"c"`: call a function: `A = [Fid, Args, Env]` (Fid an int, Args the
  argument tuple, Env the closure's free variables, `[]` for none). The
  caller's continuation is already on K.
- `"r"`: return `A` (the result: one value, a tuple for several, `null` for
  none) to the continuation on top of K.
- `"p"`: panic with value `A[0]` (an interface value) in the running frame,
  whose frame is `A[1]` = `[Key, Regs, D, Fid]` (as a continuation's fields).
- `"x"`: the run is over; `A` is the exit status (a number literal type).
  Final.

### Continuations (frames)

A suspended frame is one continuation `Cont = [Kind, Key, Regs, D, Fid,
Mode]` (`rt.ts` `Ct<…>`):

- `Kind`: `"n"` (a call site waiting for its callee's result), `"d"` (a
  frame running its deferred calls), `"m"` (after init: call main), `"b"`
  (the bottom: a return here ends the run with exit 0), `"q"` (printing a
  fatal panic: waiting for an `Error()`/`String()` result).
- `Key`: the entry that resumes the frame (`"n"`: the call's return point;
  `"d"` in run mode: the point after `runDefers`).
- `Regs`: the frame's saved registers (a tuple; the entry knows the
  layout). For a function with a recover block, the recover block's
  live-in registers come first, in a fixed order, in every saved tuple of
  that function.
- `D`: the frame's defer list: `null` or `[Rec, D]`, newest first; a record
  is `[Fid, Args, Env]` (a builtin's record is `["b:<name>", Args, Info]`).
- `Fid`: the frame's function id (an int), for panics (zero results,
  recover block) and diagnostics.
- `Mode`: for `"d"`: `"r"` (running defers before a return) or the serial
  number (int) of the panic the frame is unwinding; for `"q"`: the index of
  the panic being printed; otherwise `""`.

The running frame is not on K: its registers are the type parameters of the
aliases that run it (below).

### Registers

SSA registers are alias parameters. Each basic block is one or more
segment aliases whose parameters are `H, K, X, F` and then the block's
live-in registers (liveness over the IR CFG; phis are lowered to edge
moves, so a jump passes the target's phi values in their parameter
positions). A function with defers has its defer list as a pseudo-register
`D`, live everywhere; a function with a recover block keeps that block's
live-in registers live everywhere. A register's value is its type-level
value (DESIGN.md); a multi-result call's register is the tuple of results;
a `range` iterator is `[M, Seq]` (map id, next sequence number) or
`[S, Pos]` (string, byte offset), and `next` rebinds it.

When a frame yields (fuel out, call, return, panic) its live registers are
packed into a tuple in the order of the entry it will resume at.

### Panics

`Pn` (in X) is the panic chain, newest first: `null` or `[Rec, Pn]` with
`Rec = [V, Recovered, Repanicked, Depth, Serial, Str]`, the reference's
`PanicRec` (src/ref/interp.ts) with `Depth` the stack depth (length of K)
of the frame unwinding it and `Str` the printed `Error()`/`String()` result
(or `null`). Runtime errors are interface values of `runtime.errorString`
/ `runtime.plainError` holding the message (DESIGN.md), as the reference.

### Output

`Out` and `Err` are byte strings (`gointypes/rt.Write` to fd 1 / 2,
`print`/`println`, fatal panic text). Exit status: `A` of the final `"x"`
state.

### Globals and the heap

Globals are heap objects 1..n in `Program.globals` order (heap.ts header);
a global's address is `[id, "0"]`, a constant in the emitted code. The
initial heap is `codec-heap.ts` `initialHeap`.

## The run protocol

The emitted module exports (names are prefixed, default prefix `G`):

- `GS0`: the start state (init, then main, from the zeroed initial heap):
  `St<"c", "", Heap0, [Ct<"m",…>, [Ct<"b",…>, null]], ["", "", null], [InitFid, [], []], "">`.
- `GChunk<S>`: one chunk: refuel `S` (`F` := the chunk fuel) and run
  trampoline steps until the fuel is spent or the run is over. A finished
  state is returned unchanged.
- `GOut<S>` / `GErr<S>` / `GExit<S>`: stdout, stderr, and the exit status
  (`-1` while still running); `GDone<S>`: `true` when final.
- `GExec<S, K0>`: for hovers: chunks back to back in one alias, drawing a
  fresh literal of the fuel pool (`src/emit/fuel.gen.ts`) before each
  chunk, starting at pool chunk `K0`, until done.

CLI form (a checked `.ts` entry next to the `.d.ts`; the counter is zeroed
per statement):

    import type { GS0, GChunk, GOut } from "./prog.d.ts";
    type S1 = GChunk<GS0>;
    type S2 = GChunk<S1>;
    ...

Starting from any state: build `S` with tag `"j"` at the entry of the
paused frame, or tag `"r"`/`"c"` at a call boundary; the codec (run agent)
converts a reference snapshot into such a state. Every block entry and
every call's return point is an entry, so a pause at any block boundary or
call is a valid start.

## Fuel

`F` is a string of `x` characters. A chunk starts with `FUEL` (900)
characters. Entering a block spends its weight, at least 1 character per
segment alias it runs, plus about one per 1,000 estimated instantiations
of its ops (per-op estimates from the stage 4 cost tables); each
trampoline step spends 1. A block whose weight is more than the fuel left
yields (`"j"` at its entry) and the chunk ends. So a chunk runs at most
~900 alias hops (under tsrs's ~1,000 tail-call limit) and, by the
estimates, ~1M instantiations.

## Changes

- (none yet)
