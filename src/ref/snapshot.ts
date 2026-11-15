// Snapshots of the reference interpreter (docs/DESIGN.md "Ops and
// snapshots"): the whole machine state as JSON, restorable in a fresh
// process. Taken between any two ops.
//
// Format `go-in-types/ref-snapshot@1`:
//   program  { path, funcs, types, digest }
//   objects  by id: { k: "o", s: [slot values] } memory object,
//            { k: "m", t, e: [[key, value, seq]...], n: nextSeq } map,
//            { k: "c", t, cap, closed, b: [values] } channel
//   globals  object id of each global
//   frames   bottom to top: { fn, pc, dst, d (isDefer), dm (defer mode),
//            p (panic index or -1), r (registers), df (defers) }
//   panics   [{ v, link, rec, rep, depth, s? }]
//   ops, counts (sparse [instruction index, count] pairs), stdout, stderr,
//   exit, cur (panic index), dying, args.
// Values: null, booleans, numbers (integers; 64-bit values beyond 2^53 as
// { n: decimal }), strings (byte strings), aggregates and tuples as JSON
// arrays, { p: obj, i } pointer, { s: obj, i, l, c } slice, { f, e } func,
// { t, v } interface, { m: obj } map, { c: obj } channel,
// { mi: obj|null, q: seq } map iterator, { si: string, q: pos } string
// iterator, { u: 1 } undefined (an unset register).
// Object ids are given in traversal order from the globals, then the
// frames; restoring and snapshotting again gives the same JSON.
import type { Program } from "../ir/types.ts";
import { GoMap, MapIter } from "./gomap.ts";
import { type Defer, Frame, Machine, type PanicRec } from "./interp.ts";
import { Chan, Func, Iface, Ptr, Slice, StrIter } from "./values.ts";

export const SNAPSHOT_FORMAT = "go-in-types/ref-snapshot@1";

function digest(p: Program): string {
  let h = 2166136261;
  for (const f of p.funcs) {
    for (let i = 0; i < f.name.length; i++) h = Math.imul(h ^ f.name.charCodeAt(i), 16777619);
    h = Math.imul(h ^ f.regs, 16777619);
  }
  return (h >>> 0).toString(16);
}

export function snapshot(m: Machine, path: string): any {
  const ids = new Map<object, number>();
  const objs: any[] = [];
  const queue: object[] = [];
  const id = (o: object): number => {
    let i = ids.get(o);
    if (i === undefined) {
      i = objs.length;
      ids.set(o, i);
      objs.push(null);
      queue.push(o);
    }
    return i;
  };
  const panics: PanicRec[] = [];
  const pidx = (p: PanicRec | null): number => {
    if (p === null) return -1;
    let i = panics.indexOf(p);
    if (i < 0) {
      i = panics.length;
      panics.push(p);
      pidx(p.link);
    }
    return i;
  };
  const enc = (v: any): any => {
    if (v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string")
      return v;
    if (v === undefined) return { u: 1 };
    if (typeof v === "bigint") return { n: v.toString() };
    if (Array.isArray(v)) return v.map(enc);
    if (v instanceof Ptr) return { p: id(v.o), i: v.i };
    if (v instanceof Slice) return { s: id(v.o), i: v.i, l: v.len, c: v.cap };
    if (v instanceof Func) return { f: v.fn, e: v.env.map(enc) };
    if (v instanceof Iface) return { t: v.t, v: enc(v.v) };
    if (v instanceof GoMap) return { m: id(v) };
    if (v instanceof Chan) return { c: id(v) };
    if (v instanceof MapIter) return { mi: v.m === null ? null : id(v.m), q: v.seq };
    if (v instanceof StrIter) return { si: v.s, q: v.pos };
    throw new Error("snapshot: unknown value " + String(v?.constructor?.name));
  };
  const drain = () => {
    while (queue.length > 0) {
      const o = queue.shift()!;
      const i = ids.get(o)!;
      if (o instanceof GoMap) {
        const e: any[] = [];
        for (const x of o.es) if (x.alive) e.push([enc(x.k), enc(x.v), x.seq]);
        objs[i] = { k: "m", t: o.t, e, n: o.nextSeq };
      } else if (o instanceof Chan) {
        objs[i] = { k: "c", t: o.t, cap: o.cap, closed: o.closed, b: o.buf.map(enc) };
      } else objs[i] = { k: "o", s: (o as any[]).map(enc) };
    }
  };
  const globals = m.globals.map((g) => id(g));
  drain();
  const encDefer = (d: Defer) => ({
    fn: d.fn,
    env: d.env === null ? null : d.env.map(enc),
    a: d.args.map(enc),
    b: d.bpc,
  });
  const frames = m.stack.map((f) => {
    const r: any[] = [];
    for (let i = 0; i < f.d.nregs; i++) r.push(enc(f.regs[i]));
    const out = {
      fn: f.d.id,
      pc: f.pc,
      dst: f.dst,
      d: f.isDefer,
      dm: f.dmode,
      p: pidx(f.panic),
      r,
      df: f.defers === null ? null : f.defers.map(encDefer),
    };
    drain();
    return out;
  });
  const cur = pidx(m.curPanic);
  if (m.dying) for (const p of m.dying.list) pidx(p);
  const ps = panics.map((p) => ({
    v: enc(p.v),
    link: pidx(p.link),
    rec: p.recovered,
    rep: p.repanicked,
    depth: p.depth,
    s: p.s,
  }));
  drain();
  const counts: number[] = [];
  m.counts.forEach((c, i) => {
    if (c !== 0) counts.push(i, c);
  });
  return {
    format: SNAPSHOT_FORMAT,
    program: {
      path,
      funcs: m.prog.funcs.length,
      types: m.prog.types.length,
      digest: digest(m.prog),
    },
    objects: objs,
    globals,
    frames,
    panics: ps,
    cur,
    dying: m.dying ? { list: m.dying.list.map(pidx), i: m.dying.i } : null,
    ops: m.ops,
    counts,
    stdout: m.out.join(""),
    stderr: m.err.join(""),
    exit: m.exitCode,
    args: m.args,
  };
}

export function restore(prog: Program, s: any): Machine {
  if (s.format !== SNAPSHOT_FORMAT) throw new Error("not a snapshot: " + s.format);
  if (s.program.funcs !== prog.funcs.length || s.program.digest !== digest(prog))
    throw new Error("snapshot belongs to another program");
  const m = new Machine(prog, { args: s.args });
  const T = m.types;
  const shells: any[] = s.objects.map((o: any) => {
    if (o.k === "m") return new GoMap(o.t, T.key((T.info[o.t]!.u as any).key));
    if (o.k === "c") return new Chan(o.t, o.cap);
    return new Array(o.s.length);
  });
  const dec = (v: any): any => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(dec);
    if ("u" in v) return undefined;
    if ("n" in v) return BigInt(v.n);
    if ("p" in v) return new Ptr(shells[v.p], v.i);
    if ("s" in v) return new Slice(shells[v.s], v.i, v.l, v.c);
    if ("f" in v) return new Func(v.f, v.e.map(dec));
    if ("t" in v) return new Iface(v.t, dec(v.v));
    if ("m" in v) return shells[v.m];
    if ("c" in v) return shells[v.c];
    if ("mi" in v) return new MapIter(v.mi === null ? null : shells[v.mi], v.q);
    if ("si" in v) return new StrIter(v.si, v.q);
    throw new Error("restore: unknown value " + JSON.stringify(v));
  };
  s.objects.forEach((o: any, i: number) => {
    const sh = shells[i];
    if (o.k === "m") {
      for (const [k, v, seq] of o.e) (sh as GoMap).restore(dec(k), dec(v), seq);
      (sh as GoMap).nextSeq = o.n;
    } else if (o.k === "c") {
      (sh as Chan).closed = o.closed;
      (sh as Chan).buf = o.b.map(dec);
    } else for (let j = 0; j < o.s.length; j++) sh[j] = dec(o.s[j]);
  });
  m.globals = s.globals.map((g: number) => shells[g]);
  const panics: PanicRec[] = s.panics.map((p: any) => ({
    v: dec(p.v),
    link: null,
    recovered: p.rec,
    repanicked: p.rep,
    depth: p.depth,
    s: p.s,
  }));
  s.panics.forEach((p: any, i: number) => {
    panics[i]!.link = p.link < 0 ? null : panics[p.link]!;
  });
  const pan = (i: number) => (i < 0 ? null : panics[i]!);
  m.stack = s.frames.map((fr: any) => {
    const d = m.dfunc(fr.fn);
    const regs = d.template.slice();
    fr.r.forEach((v: any, i: number) => (regs[i] = dec(v)));
    const f = new Frame(d, regs, fr.dst, fr.d);
    f.pc = fr.pc;
    f.dmode = fr.dm;
    f.panic = pan(fr.p);
    f.defers =
      fr.df === null
        ? null
        : fr.df.map((x: any) => ({
            fn: x.fn,
            env: x.env === null ? null : x.env.map(dec),
            args: x.a.map(dec),
            bpc: x.b,
          }));
    return f;
  });
  m.top = m.stack.length > 0 ? m.stack[m.stack.length - 1]! : null;
  m.curPanic = pan(s.cur);
  m.dying = s.dying ? { list: s.dying.list.map(pan), i: s.dying.i } : null;
  m.ops = s.ops;
  for (let i = 0; i < s.counts.length; i += 2) m.counts[s.counts[i]] = s.counts[i + 1];
  m.out = s.stdout ? [s.stdout] : [];
  m.err = s.stderr ? [s.stderr] : [];
  m.exitCode = s.exit;
  return m;
}
