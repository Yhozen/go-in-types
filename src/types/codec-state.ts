// State codec: a reference snapshot (src/ref/snapshot.ts) <-> the type-level
// machine state the emitter's code runs on (docs/EMIT.md).
//
// Range iterators (go/ssa's opaque rangeIter registers):
//   map    { mi: obj|null, q: seq of the last entry visited }
//          <-> ["m", Id | null, It]   It = q + 1 (map.ts: the next Seq to look at)
//   string { si: s, q: byte position } <-> ["s", S, Pos]
import { codecHooks, decNat, encNat, ID_WIDTH, idOf, strLit } from "./codec-heap.ts";
import "./codec-map.ts";
import type { Program } from "../ir/types.ts";

codecHooks.iter = {
  encSnap: (v) =>
    "mi" in v
      ? `["m", ${v.mi === null ? "null" : strLit(v.mi < 0 ? "0".repeat(ID_WIDTH) : idOf(v.mi))}, ${strLit(encNat(v.q + 1))}]`
      : `["s", ${strLit(v.si)}, ${strLit(encNat(v.q))}]`,
  dec: (v, _t, d) =>
    v[0] === "m"
      ? { mi: v[1] === null ? null : d.obj(v[1]), q: Number(decNat(v[2])) - 1 }
      : { si: v[1], q: Number(decNat(v[2])) },
};

export interface StartState {
  /** a `.d.ts` module exporting `Start`, the driver state (EMIT.md) */
  module: string;
  /** reference ops run before the state (the snapshot's, plus any run to a startable point) */
  ops: number;
}

/**
 * The type-level start state for reference snapshot `snap` (src/ref/snapshot.ts
 * format). `typesImp` / `emitImp`: import paths of src/types and src/emit
 * from where the module is written.
 */
export function startState(
  _prog: Program,
  _snap: any,
  _typesImp: string,
  _emitImp: string,
): StartState {
  throw new Error("codec-state: startState needs the emitter's entry table");
}
