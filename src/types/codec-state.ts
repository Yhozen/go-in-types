// State codec: a reference snapshot (src/ref/snapshot.ts) <-> the type-level
// machine state the emitter's code runs on (docs/EMIT.md).
//
// Range iterators (go/ssa's opaque rangeIter registers):
//   map    { mi: obj|null, q: seq of the last entry visited }
//          <-> ["m", Id | null, It]   It = q + 1 (map.ts: the next Seq to look at)
//   string { si: s, q: byte position } <-> ["s", S, Pos]
import { codecHooks, decNat, encNat, ID_WIDTH, idOf, strLit } from "./codec-heap.ts";
import "./codec-map.ts";

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
