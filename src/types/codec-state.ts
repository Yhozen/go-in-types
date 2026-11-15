// State codec: a reference snapshot (src/ref/snapshot.ts) <-> the type-level
// machine state the emitter's code runs on (docs/EMIT.md).
import type { Program } from "../ir/types.ts";
import type { Machine } from "../ref/interp.ts";
import { restore, snapshot } from "../ref/snapshot.ts";
import {
  decNat,
  Dec,
  encIter,
  encNat,
  encSnapValue,
  evalType,
  parseModule,
  snapshotToTypes,
  strLit,
  type TV,
  TypeInfo,
  typesToSnapshot,
  type TypesState,
} from "./codec-heap.ts";
import "./codec-map.ts";

// ---------------------------------------------------------------- entry layouts

/** An entry of the emitted module: its resume segment's parameters by argument source. */
export interface EntryLayout {
  key: string;
  /** register per `A` element (block entries: A[i]; call returns: Regs[i]) */
  regs: number[];
  /** the entry takes D (the frame's defer list) */
  hasD: boolean;
}

/**
 * Entry layouts of an emitted module (src/emit/emit.ts output), from its
 * `interface e<Key> extends EB { o: <Seg><this["h"], ..., args> }` lines and
 * the segments' parameter lists: block entries `b<fid>_<block>` pass
 * `this["a"][i]` for parameter i; call returns `c<fid>_<n>` pass
 * `this["a"][2]` (D), `this["a"][0]` (the result) and `this["a"][1][i]`
 * (saved register i).
 */
export function entryLayouts(emitted: string): Map<string, EntryLayout> {
  const params = new Map<string, string[]>();
  for (const m of emitted.matchAll(/^type ([bc]\d+_\d+)<H, K, X, F(?:, ([^>]*))?> =/gm))
    params.set(m[1]!, m[2] ? m[2].split(", ") : []);
  const out = new Map<string, EntryLayout>();
  for (const m of emitted.matchAll(
    /^interface e([bc]\d+_\d+) extends EB \{ o: ([bc]\d+_\d+)<this\["h"\], this\["k"\], this\["x"\], this\["f"\](.*)> \}$/gm,
  )) {
    const key = m[1]!;
    const ps = params.get(m[2]!);
    if (!ps) continue;
    const args = m[3] ? m[3].slice(2).split(", ") : [];
    const lay: EntryLayout = { key, regs: [], hasD: false };
    args.forEach((a, i) => {
      const p = ps[i]!;
      const reg = p === "D" ? -1 : Number(p.slice(1));
      const blk = /^this\["a"\]\[(\d+)\]$/.exec(a);
      const sav = /^this\["a"\]\[1\]\[(\d+)\]$/.exec(a);
      if (key[0] === "b" && blk) {
        if (reg < 0) lay.hasD = true;
        lay.regs[Number(blk[1])] = reg;
      } else if (key[0] === "c" && sav) lay.regs[Number(sav[1])] = reg;
      else if (key[0] === "c" && a === 'this["a"][2]') lay.hasD = true;
    });
    out.set(key, lay);
  }
  return out;
}

/**
 * Call sites of function fid in the emitter's numbering (`c<fid>_<n>`, in
 * block and instruction order): instruction index (flattened pc) -> n.
 * A call site is a call of an IR function (static, closure or method) or a
 * runDefers.
 */
export function callSites(prog: Program, fid: number): Map<number, number> {
  const f = prog.funcs[fid]!;
  const m = new Map<number, number>();
  let n = 0;
  let pc = 0;
  for (const b of f.blocks)
    for (const ins of b.instrs) {
      if (ins.op === "runDefers") m.set(pc, n++);
      else if (ins.op === "call") {
        const c = ins.callee as any;
        if ("static" in c) {
          if (prog.funcs[c.static]!.body === "ir") m.set(pc, n++);
        } else if ("value" in c || "invoke" in c) m.set(pc, n++);
      }
      pc++;
    }
  return m;
}

// ---------------------------------------------------------------- start states

export interface StartState {
  /** a `.d.ts` module exporting `Start`, the driver state (EMIT.md) */
  module: string;
  /** reference ops run before the state (the snapshot's, plus any run to a startable point) */
  ops: number;
  /** the snapshot the state encodes */
  snap: any;
}

export interface StartOptions {
  /** import path of the emitted program's runtime directory (src/emit/runtime.ts) from the module */
  rt: string;
  /** the emitted module's text (for its entry layouts) */
  emitted: string;
  /** give up after this many reference ops looking for a startable point */
  maxAdvance?: number;
}

const DM_NONE = 0;

/** Why machine state m cannot be a type-level start (null: it can). */
export function unstartable(m: Machine, lays: Map<string, EntryLayout>): string | null {
  if (m.curPanic !== null || m.dying !== null) return "panicking";
  const st = m.stack;
  if (st.length === 0) return null;
  const top = st[st.length - 1]!;
  if (top.dmode !== DM_NONE) return "top frame running defers";
  const bi = top.d.start.indexOf(top.pc);
  if (bi < 0) return "top frame inside a block";
  if (!lays.has(`b${top.d.id}_${bi}`)) return `no entry b${top.d.id}_${bi}`;
  for (let i = 0; i < st.length; i++) {
    const f = st[i]!;
    if (f.dst < -1) return "printing a panic";
    if (f.defers?.some((d) => d.bpc >= 0)) return "builtin defer";
    if (i === st.length - 1) break;
    if (i === 0 && f.d.id === m.prog.main && f.pc === 0) continue; // main, not started
    const n = callSites(m.prog, f.d.id).get(f.pc - 1);
    if (n === undefined) return `frame ${i} not at a call site`;
    if (!lays.has(`c${f.d.id}_${n}`)) return `no entry c${f.d.id}_${n}`;
    if (f.dmode !== DM_NONE && f.dmode !== 1) return `frame ${i} unwinding`;
  }
  return null;
}

/**
 * The type-level start state for reference snapshot `snap`
 * (src/ref/snapshot.ts format): the reference first runs on to the next
 * state the type level can start from (top frame at a block entry, every
 * other frame at a call site or running defers before a return, no panic in
 * flight), or to the end of the run.
 */
export function startState(prog: Program, snap0: any, o: StartOptions): StartState {
  const lays = entryLayouts(o.emitted);
  const m = restore(prog, snap0);
  const limit = m.ops + (o.maxAdvance ?? 1_000_000);
  let why: string | null;
  while ((why = unstartable(m, lays)) !== null) {
    if (m.ops >= limit)
      throw new Error(`no startable point within ${o.maxAdvance ?? 1e6} ops: ${why}`);
    if (m.run(m.ops + 1) === "done") break;
  }
  const snap = JSON.parse(JSON.stringify(snapshot(m, snap0.program.path)));
  return { module: stateModule(prog, snap, lays, o), ops: m.ops, snap };
}

/** The state module of a startable snapshot. */
export function stateModule(
  prog: Program,
  snap: any,
  lays: Map<string, EntryLayout>,
  o: StartOptions,
): string {
  const ti = new TypeInfo(prog);
  const heapMod = snapshotToTypes(prog, snap, `${o.rt}/heap.gen.d.ts`).heap.replace(
    /^export type Heap/m,
    "type Heap",
  );
  const n2 = (v: number) => strLit(encNat(v));
  const reg = (fr: any, r: number): string => {
    const v = fr.r[r];
    if (v !== null && typeof v === "object" && ("mi" in v || "si" in v)) return encIter(v);
    return encSnapValue(ti, v, prog.funcs[fr.fn]!.regTypes[r]!);
  };
  const deferList = (fr: any): string => {
    let t = "null";
    for (const d of fr.df ?? []) {
      const sig = prog.types[prog.funcs[d.fn]!.sig] as any;
      const args = (d.a as any[]).map((x, i) => encSnapValue(ti, x, sig.params[i]));
      const et = ti.envTypes(d.fn);
      const env = d.env ? (d.env as any[]).map((x, i) => encSnapValue(ti, x, et[i]!)) : [];
      t = `R.Cons<[${n2(d.fn)}, [${args.join(", ")}], [${env.join(", ")}]], ${t}>`;
    }
    return t;
  };
  const lines = [
    "// Generated by src/types/codec-state.ts (a reference snapshot as a start state); do not edit.",
    `import type * as R from "${o.rt}/rt.d.ts";`,
    heapMod,
  ];
  // panic serial numbers (Ns) only need to differ from in-flight panics: none here
  const X = `R.Xt<${strLit(snap.stdout)}, ${strLit(snap.stderr)}, null, "s">`;
  const frames = snap.frames as any[];
  if (frames.length === 0) {
    lines.push(`export type Start = R.St<"x", "", Heap, null, ${X}, ${snap.exit ?? 0}, "">;`);
    return lines.join("\n") + "\n";
  }
  // the bottom: "m" (call main) while init runs, "b" (end the run) under main
  const mainWaits = frames.length > 1 && frames[0].fn === prog.main && frames[0].pc === 0;
  let K = mainWaits ? "null" : `R.Cons<R.Ct<"b", "", [], null, "0", "">, null>`;
  for (let i = 0; i < frames.length - 1; i++) {
    const fr = frames[i];
    if (i === 0 && mainWaits) {
      K = `R.Cons<R.Ct<"m", "", [], null, ${n2(fr.fn)}, "">, ${K}>`;
      continue;
    }
    const n = callSites(prog, fr.fn).get(fr.pc - 1)!;
    const lay = lays.get(`c${fr.fn}_${n}`)!;
    const regs = `[${lay.regs.map((r) => reg(fr, r)).join(", ")}]`;
    const D = lay.hasD ? deferList(fr) : "null";
    const kind = fr.dm === DM_NONE ? "n" : "d";
    const mode = fr.dm === DM_NONE ? '""' : '"r"';
    K = `R.Cons<R.Ct<"${kind}", "c${fr.fn}_${n}", ${regs}, ${D}, ${n2(fr.fn)}, ${mode}>, ${K}>`;
  }
  const top = frames[frames.length - 1];
  const starts: number[] = [];
  let pc = 0;
  for (const b of prog.funcs[top.fn]!.blocks) {
    starts.push(pc);
    pc += b.instrs.length;
  }
  const bi = starts.indexOf(top.pc);
  const key = `b${top.fn}_${bi}`;
  const lay = lays.get(key)!;
  const A = `[${lay.regs.map((r) => (r < 0 ? deferList(top) : reg(top, r))).join(", ")}]`;
  lines.push(`type K0 = ${K};`);
  lines.push(`export type Start = R.St<"j", "${key}", Heap, K0, ${X}, ${A}, "">;`);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------- decoding

/**
 * A state module (stateModule's output, or any module declaring `Start` and
 * `Heap` the same way) back to snapshot form: objects, frames (fn, pc, dm,
 * df, and the registers the entries keep; the others are { u: 1 }), stdout,
 * stderr. Fields the type level does not hold (counts, panics) come from
 * `base`.
 */
export function decodeStart(prog: Program, module: string, emitted: string, base: any): any {
  const lays = entryLayouts(emitted);
  const decls = parseModule(module);
  const S = decls.get("Start") as any;
  const args = (t: TV): TV[] => {
    if (t && typeof t === "object" && !Array.isArray(t)) {
      if (t.args.length === 0) return args(decls.get(t.ref)!);
      return t.args;
    }
    if (Array.isArray(t)) return t;
    throw new Error("decodeStart: not a constructor: " + JSON.stringify(t));
  };
  const str = (t: TV) => evalType(t, decls) as string;
  const [tag, key, , K, X, A] = args(S);
  const x = args(X!);
  const ti = new TypeInfo(prog);
  const callPc = (fid: number, n: number) => {
    for (const [pc, k] of callSites(prog, fid)) if (k === n) return pc;
    throw new Error(`decodeStart: no call site c${fid}_${n}`);
  };
  const deferRecs = (D: TV): any[] | null => {
    const out: any[] = [];
    for (let d = D; d !== null && d !== undefined;) {
      const [rec, rest] = args(d);
      out.push(rec);
      d = rest!;
    }
    return out.length === 0 ? null : out.reverse();
  };
  // frames, top first; registers as parsed types
  const frames: { fn: number; pc: number; dm: number; regs: (TV | undefined)[]; D: TV | null }[] =
    [];
  if (str(tag!) !== "x") {
    const k0 = str(key!);
    const [, fid, bi] = /^b(\d+)_(\d+)$/.exec(k0)!;
    const f = prog.funcs[Number(fid)]!;
    let pc = 0;
    for (let b = 0; b < Number(bi); b++) pc += f.blocks[b]!.instrs.length;
    const lay = lays.get(k0)!;
    const a = args(A!);
    const regs: (TV | undefined)[] = [];
    let D: TV | null = null;
    lay.regs.forEach((r, i) => (r < 0 ? (D = a[i]!) : (regs[r] = a[i])));
    frames.push({ fn: Number(fid), pc, dm: 0, regs, D });
    for (let k: TV = K!; k !== null && k !== undefined;) {
      const [ct, rest] = args(k);
      const [kind, ckey, cregs, cD, cfid] = args(ct!);
      const kd = str(kind!);
      const fn = Number(decNat(str(cfid!)));
      k = rest!;
      if (kd === "b") continue;
      if (kd === "m") {
        frames.push({ fn, pc: 0, dm: 0, regs: [], D: null });
        continue;
      }
      const ck = str(ckey!);
      const n = Number(/_(\d+)$/.exec(ck)![1]);
      const l = lays.get(ck)!;
      const rs = args(cregs!);
      const regs2: (TV | undefined)[] = [];
      l.regs.forEach((r, i) => (regs2[r] = rs[i]));
      frames.push({ fn, pc: callPc(fn, n) + 1, dm: kd === "d" ? 1 : 0, regs: regs2, D: cD! });
    }
    frames.reverse();
  }
  const st: TypesState = {
    heap: module,
    frames: frames.map((fr) =>
      Array.from({ length: prog.funcs[fr.fn]!.regs }, (_, i) =>
        i in fr.regs ? { tv: fr.regs[i]! } : undefined,
      ),
    ),
  };
  const d = new Dec(ti);
  const dfs = frames.map(
    (fr) =>
      deferRecs(fr.D)?.map((rec) => {
        const [fid, as, env] = evalType(rec, decls) as any[];
        const fn = Number(decNat(fid));
        const sig = prog.types[prog.funcs[fn]!.sig] as any;
        const et = ti.envTypes(fn);
        return {
          fn,
          env: et.length === 0 ? null : (env as any[]).map((v, j) => d.value(v, et[j]!)),
          a: (as as any[]).map((v, j) => d.value(v, sig.params[j])),
        };
      }) ?? null,
  );
  const shellFrames = frames.map((fr, i) => ({ fn: fr.fn, r: [] as any[], df: dfs[i] }));
  const dec = typesToSnapshot(prog, st, { ...base, frames: shellFrames });
  dec.frames = frames.map((fr, i) => ({
    fn: fr.fn,
    pc: fr.pc,
    dm: fr.dm,
    r: dec.frames[i].r,
    df: dfs[i],
  }));
  dec.stdout = str(x[0]!);
  dec.stderr = str(x[1]!);
  if (str(tag!) === "x") dec.exit = evalType(A!, decls);
  return dec;
}
