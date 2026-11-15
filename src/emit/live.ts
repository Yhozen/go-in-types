// Register liveness over a function's blocks (docs/EMIT.md "Registers").
// Phis are lowered to edge moves: a phi's destination is defined at the
// start of its block, and its edge operand is used at the end of the
// predecessor on that edge.
import type { Callee, Func, Instr, Operand } from "../ir/types.ts";

/** Registers an operand reads. */
export function opRegs(o: Operand | undefined, out: number[]): void {
  if (o && "r" in o) out.push(o.r);
}

function calleeRegs(c: Callee, out: number[]): void {
  if ("value" in c) opRegs(c.value, out);
  else if ("invoke" in c) opRegs(c.invoke, out);
}

/** Registers an instruction reads (phi edges excluded). */
export function uses(ins: Instr): number[] {
  const u: number[] = [];
  const o = (x: Operand | undefined) => opRegs(x, u);
  switch (ins.op) {
    case "alloc":
    case "jump":
    case "runDefers":
    case "trap":
    case "makeMap":
      if (ins.op === "makeMap") o(ins.reserve);
      break;
    case "load":
      o(ins.ptr);
      break;
    case "store":
      o(ins.ptr);
      o(ins.val);
      break;
    case "fieldAddr":
    case "field":
    case "unop":
    case "convert":
    case "changeType":
    case "changeInterface":
    case "sliceToArrayPtr":
    case "makeInterface":
    case "typeAssert":
    case "range":
      o(ins.x);
      break;
    case "indexAddr":
    case "index":
    case "lookup":
      o(ins.x);
      o(ins.index);
      break;
    case "binop":
      o(ins.x);
      o(ins.y);
      break;
    case "makeSlice":
      o(ins.len);
      o(ins.cap);
      break;
    case "slice":
      o(ins.x);
      o(ins.low);
      o(ins.high);
      o(ins.max);
      break;
    case "mapUpdate":
      o(ins.map);
      o(ins.key);
      o(ins.val);
      break;
    case "makeChan":
      o(ins.size);
      break;
    case "send":
      o(ins.chan);
      o(ins.val);
      break;
    case "recv":
      o(ins.chan);
      break;
    case "makeClosure":
      ins.bindings.forEach(o);
      break;
    case "call":
      calleeRegs(ins.callee, u);
      ins.args.forEach(o);
      break;
    case "defer":
      calleeRegs(ins.callee, u);
      ins.args.forEach(o);
      o(ins.stack);
      break;
    case "extract":
      o(ins.tuple);
      break;
    case "next":
      o(ins.iter);
      break;
    case "phi":
      break;
    case "if":
      o(ins.cond);
      break;
    case "return":
      ins.results.forEach(o);
      break;
    case "panic":
      o(ins.x);
      break;
  }
  return u;
}

/** The register an instruction defines, or -1. */
export function def(ins: Instr): number {
  return "dst" in ins && typeof ins.dst === "number" ? ins.dst : -1;
}

/** The phi edge index of the edge from block `from` (its k-th successor) into `to`. */
export function edgeIndex(f: Func, from: number, k: number): number {
  const b = f.blocks[from]!;
  const to = b.succs[k]!;
  let occ = 0;
  for (let j = 0; j < k; j++) if (b.succs[j] === to) occ++;
  const tb = f.blocks[to]!;
  for (let j = 0; j < tb.preds.length; j++) if (tb.preds[j] === from && occ-- === 0) return j;
  throw new Error(`no edge ${from}->${to} in ${f.name}`);
}

export interface Liveness {
  liveIn: Set<number>[];
  liveOut: Set<number>[];
}

/**
 * Live-in and live-out sets per block. `always` registers are added to
 * every block's live-in and live-out once defined (recover-block inputs).
 */
export function liveness(f: Func, always: number[] = []): Liveness {
  const n = f.blocks.length;
  const gen: Set<number>[] = [];
  const kill: Set<number>[] = [];
  // phi uses per edge: phiUse[b][k] = regs used on b's k-th successor edge
  const phiUse: number[][][] = [];
  for (let b = 0; b < n; b++) {
    const g = new Set<number>();
    const k = new Set<number>();
    for (const ins of f.blocks[b]!.instrs) {
      if (ins.op !== "phi") for (const r of uses(ins)) if (!k.has(r)) g.add(r);
      const d = def(ins);
      if (d >= 0) k.add(d);
    }
    gen.push(g);
    kill.push(k);
    const blk = f.blocks[b]!;
    phiUse.push(
      blk.succs.map((to, si) => {
        const ei = edgeIndex(f, b, si);
        const rs: number[] = [];
        for (const ins of f.blocks[to]!.instrs) {
          if (ins.op !== "phi") break;
          opRegs(ins.edges[ei], rs);
        }
        return rs;
      }),
    );
  }
  const liveIn: Set<number>[] = Array.from({ length: n }, () => new Set());
  const liveOut: Set<number>[] = Array.from({ length: n }, () => new Set());
  const phiDefs = f.blocks.map((b) => {
    const s = new Set<number>();
    for (const ins of b.instrs) if (ins.op === "phi") s.add(ins.dst);
    return s;
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (let b = n - 1; b >= 0; b--) {
      const blk = f.blocks[b]!;
      const out = new Set<number>();
      blk.succs.forEach((to, si) => {
        for (const r of liveIn[to]!) if (!phiDefs[to]!.has(r)) out.add(r);
        for (const r of phiUse[b]![si]!) out.add(r);
      });
      const inn = new Set<number>(gen[b]);
      for (const r of out) if (!kill[b]!.has(r)) inn.add(r);
      // phi destinations are live-in (they arrive as parameters)
      for (const r of phiDefs[b]!) if (out.has(r) || usedInBlock(blk.instrs, r)) inn.add(r);
      if (!sameSet(out, liveOut[b]!) || !sameSet(inn, liveIn[b]!)) {
        liveOut[b] = out;
        liveIn[b] = inn;
        changed = true;
      }
    }
  }
  if (always.length > 0) {
    const defIn = new Set<number>(); // defined in the entry block
    for (const ins of f.blocks[0]?.instrs ?? []) {
      const d = def(ins);
      if (d >= 0) defIn.add(d);
    }
    for (let b = 0; b < n; b++)
      for (const r of always) {
        if (b !== 0 || !defIn.has(r)) liveIn[b]!.add(r);
        liveOut[b]!.add(r);
      }
  }
  return { liveIn, liveOut };
}

function usedInBlock(instrs: Instr[], r: number): boolean {
  for (const ins of instrs) if (ins.op !== "phi" && uses(ins).includes(r)) return true;
  return false;
}

function sameSet(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
