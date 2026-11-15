// State codec: a reference snapshot (src/ref/snapshot.ts) <-> the type-level
// machine state the emitter's code runs on (docs/EMIT.md).
import type { Program } from "../ir/types.ts";
import "./codec-map.ts";

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
