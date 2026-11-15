// The reference interpreter (docs/DESIGN.md): runs the IR with exact op
// counts, and with all state (frames, registers, defers, panics) as data, so
// it can pause after any op and resume from a snapshot (src/ref/snapshot.ts).
//
// Speed: each function is decoded on first call into a flat array of
// closures (one per instruction, the per-function instruction ordinal is
// the pc); constants are extra registers filled from a template, so every
// operand is a register read. Phis are resolved on the edge (the jump
// writes the target block's phi registers in parallel; the phi
// instructions themselves only count). Calls push frames on an explicit
// stack: no JS recursion, so any op is a valid pause point.
import type { Block, Callee, Const, Func as IRFunc, Instr, Operand, Program } from "../ir/types.ts";
import { GoMap, MapIter } from "./gomap.ts";
import { intrinsics, type Intrinsic } from "./intrinsics.ts";
import { Types } from "./types.ts";
import {
  add64s,
  add64u,
  and64,
  andNot64,
  bitsToF32,
  bitsToF64,
  canonS,
  canonU,
  Chan,
  convInt,
  decodeRune,
  div64s,
  div64u,
  encodeRune,
  Exit,
  Func,
  GoPanic,
  growCap,
  Iface,
  indexOOR,
  isSigned,
  type Kind,
  mul64s,
  mul64u,
  neg64s,
  neg64u,
  nilDeref,
  norm,
  not64s,
  not64u,
  num,
  type Obj,
  or64,
  plainError,
  printFloat,
  Ptr,
  rem64s,
  rem64u,
  roundupsize,
  rt,
  rtError,
  shiftCount,
  shl64,
  shr64,
  Slice,
  StrIter,
  sub64s,
  sub64u,
  Trap,
  WIDTH,
  xor64,
} from "./values.ts";

export const DM_NONE = 0;
export const DM_RUN = 1;
export const DM_PANIC = 2;

export interface PanicRec {
  v: any;
  link: PanicRec | null;
  recovered: boolean;
  repanicked: boolean;
  /** Stack index of the frame unwinding it. */
  depth: number;
  /** Printed form after preprintpanics (Error()/String() result). */
  s?: string;
}

/** A deferred call: a function (fn >= 0, or -1 for a nil func value) or a builtin (bpc >= 0). */
export interface Defer {
  fn: number;
  env: any[] | null;
  args: any[];
  bpc: number;
}

type Code = (f: Frame) => void;

export interface DFunc {
  id: number;
  f: IRFunc;
  nregs: number;
  template: any[];
  code: Code[];
  start: number[];
  base: number;
  /** Builtin implementations of `defer` instructions, by pc. */
  builtins: ((args: any[], f: Frame) => any)[];
  intrinsic?: Intrinsic;
}

export class Frame {
  pc = 0;
  defers: Defer[] | null = null;
  dmode = DM_NONE;
  panic: PanicRec | null = null;
  d: DFunc;
  regs: any[];
  /** Caller register for the result; -1: none; <= -2: panic print slot. */
  dst: number;
  isDefer: boolean;
  constructor(d: DFunc, regs: any[], dst: number, isDefer: boolean) {
    this.isDefer = isDefer;
    this.d = d;
    this.regs = regs;
    this.dst = dst;
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exit: number;
  ops: number;
}

export interface MachineOptions {
  args?: string[];
}

export class Machine {
  types: Types;
  dfuncs: (DFunc | undefined)[];
  base: number[];
  counts: Float64Array;
  globals: Obj[];
  stack: Frame[] = [];
  top: Frame | null = null;
  brk = false;
  ops = 0;
  out: string[] = [];
  err: string[] = [];
  exitCode: number | null = null;
  curPanic: PanicRec | null = null;
  dying: { list: PanicRec[]; i: number } | null = null;
  args: string[];

  prog: Program;
  constructor(prog: Program, opts: MachineOptions = {}) {
    this.prog = prog;
    this.types = new Types(prog);
    rt.errorString = this.types.byName.get("runtime.errorString") ?? -1;
    rt.plainError = this.types.byName.get("runtime.plainError") ?? rt.errorString;
    this.dfuncs = new Array(prog.funcs.length);
    this.base = [];
    let n = 0;
    for (const f of prog.funcs) {
      this.base.push(n);
      for (const b of f.blocks) n += b.instrs.length;
    }
    this.counts = new Float64Array(n);
    this.globals = prog.globals.map((g) => this.types.zslots(g.type).slice());
    this.args = opts.args ?? ["prog"];
  }

  /** Sets up the initial stack: init, then main. */
  boot(): void {
    if (this.prog.main !== null) this.pushFrame(this.prog.main, [], null, -1, false);
    this.pushFrame(this.prog.init, [], null, -1, false);
  }

  // -------------------------------------------------------------- run loop

  /** Runs until done or until `limit` total ops have run. */
  run(limit = Infinity): "done" | "paused" {
    let ops = this.ops;
    const counts = this.counts;
    for (;;) {
      const f = this.top;
      if (f === null) {
        this.ops = ops;
        if (this.finishStep()) continue;
        return "done";
      }
      if (ops >= limit) {
        this.ops = ops;
        return "paused";
      }
      try {
        if (f.dmode !== DM_NONE) {
          this.stepDefers(f);
          continue;
        }
        const code = f.d.code;
        const base = f.d.base;
        this.brk = false;
        do {
          const pc = f.pc++;
          counts[base + pc]++;
          ops++;
          code[pc]!(f);
        } while (!this.brk && ops < limit);
      } catch (e) {
        this.ops = ops;
        if (e instanceof GoPanic) this.startPanic(e.v);
        else if (e instanceof Exit) this.exit(e.code, e.msg);
        else if (e instanceof Trap) {
          const where = this.top ? this.top.d.f.name : "?";
          this.exit(2, `trap: ${e.what} (in ${where})\n`);
        } else if (e instanceof RangeError && /call stack|Invalid array length/.test(e.message)) {
          this.exit(2, `fatal error: ${e.message}\n`);
        } else throw e;
      }
    }
  }

  result(): RunResult {
    return {
      stdout: this.out.join(""),
      stderr: this.err.join(""),
      exit: this.exitCode ?? -1,
      ops: this.ops,
    };
  }

  exit(code: number, msg = ""): void {
    if (msg) this.err.push(msg);
    this.exitCode = code;
    this.stack.length = 0;
    this.top = null;
    this.brk = true;
  }

  /** Called with an empty stack: finishes the run (printing a fatal panic). */
  private finishStep(): boolean {
    if (this.exitCode !== null) return false;
    const p = this.curPanic;
    if (p === null) {
      this.exitCode = 0;
      return false;
    }
    if (this.dying === null) {
      const list: PanicRec[] = [];
      for (let q: PanicRec | null = p; q; q = q.link) list.push(q);
      this.dying = { list, i: 0 };
    }
    const dy = this.dying;
    while (dy.i < dy.list.length) {
      const k = dy.i++;
      const q = dy.list[k]!;
      const l = q.link;
      if (l && sameEface(l.v, q.v)) {
        l.repanicked = true;
        continue;
      }
      const v = q.v;
      if (v instanceof Iface) {
        const tab = this.types.methods(v.t);
        const m = tab["Error"] ?? tab["String"];
        if (m !== undefined) {
          this.pushFrame(m, [v.v], null, -2 - k, false);
          return true;
        }
      }
    }
    let s = "";
    const print = (q: PanicRec) => {
      if (q.link) {
        print(q.link);
        if (q.link.repanicked) return;
        s += "\t";
      }
      s += "panic: " + (q.s !== undefined ? indented(q.s) : this.panicVal(q.v));
      if (q.recovered && q.repanicked) s += " [recovered, repanicked]";
      else if (q.recovered) s += " [recovered]";
      s += "\n";
    };
    print(p);
    this.exit(2, s + "\ngoroutine 1 [running]:\n");
    return false;
  }

  private panicVal(v: any): string {
    if (v === null) return "panic called with nil argument (goexit=false)";
    const iv = v as Iface;
    const ti = this.types.info[iv.t]!;
    const named = ti.t.k === "named";
    let s: string | null = null;
    switch (ti.k) {
      case "bool":
        s = String(iv.v);
        break;
      case "int":
        s = String(iv.v);
        break;
      case "float":
        s = printFloat(ti.fbits === 32 ? bitsToF32(iv.v) : bitsToF64(iv.v));
        break;
      case "string":
        if (!named) return indented(iv.v);
        return `${this.types.name(iv.t)}("${indented(iv.v)}")`;
    }
    if (s !== null) return named ? `${this.types.name(iv.t)}(${s})` : s;
    return `(${this.types.name(iv.t)}) 0xc000010000`;
  }

  // -------------------------------------------------------------- calls

  dfunc(id: number): DFunc {
    return this.dfuncs[id] ?? (this.dfuncs[id] = this.decode(id));
  }

  pushFrame(id: number, args: any[], env: any[] | null, dst: number, isDefer: boolean): void {
    const d = this.dfunc(id);
    if (d.f.body !== "ir") {
      this.callNative(d, args, dst);
      return;
    }
    const regs = d.template.slice();
    for (let i = 0; i < args.length; i++) regs[i] = args[i];
    if (env) {
      const p = d.f.params;
      for (let j = 0; j < env.length; j++) regs[p + j] = env[j];
    }
    const fr = new Frame(d, regs, dst, isDefer);
    this.stack.push(fr);
    this.top = fr;
    this.brk = true;
  }

  private callNative(d: DFunc, args: any[], dst: number): void {
    if (d.f.body === "trap") throw new Trap(d.f.trap ?? "trap: " + d.f.name);
    const impl = d.intrinsic;
    if (!impl) throw new Trap(`unknown intrinsic ${d.f.intrinsic ?? d.f.name}`);
    const r = impl(this, args, d);
    if (dst >= 0) this.top!.regs[dst] = r;
  }

  ret(f: Frame, v: any): void {
    const st = this.stack;
    st.pop();
    const t = st.length > 0 ? st[st.length - 1]! : null;
    this.top = t;
    this.brk = true;
    const dst = f.dst;
    if (dst >= 0) t!.regs[dst] = v;
    else if (dst <= -2) this.dying!.list[-2 - dst]!.s = v;
  }

  // -------------------------------------------------------------- defer/panic

  startPanic(v: any): void {
    const f = this.top!;
    const p: PanicRec = {
      v,
      link: this.curPanic,
      recovered: false,
      repanicked: false,
      depth: this.stack.length - 1,
    };
    this.curPanic = p;
    f.dmode = DM_PANIC;
    f.panic = p;
  }

  private stepDefers(f: Frame): void {
    const ds = f.defers;
    if (ds !== null && ds.length > 0) {
      const d = ds.pop()!;
      if (d.bpc >= 0) f.d.builtins[d.bpc]!(d.args, f);
      else if (d.fn < 0) throw nilDeref();
      else this.pushFrame(d.fn, d.args, d.env, -1, true);
      return;
    }
    if (f.dmode === DM_RUN) {
      f.dmode = DM_NONE;
      return;
    }
    const p = f.panic!;
    const depth = this.stack.length - 1;
    if (p.recovered) {
      let c = this.curPanic;
      while (c !== null && c.depth >= depth) c = c.link;
      this.curPanic = c;
      f.dmode = DM_NONE;
      f.panic = null;
      const rb = f.d.f.recover;
      if (rb >= 0) f.pc = f.d.start[rb]!;
      else this.ret(f, this.zeroResults(f.d));
      return;
    }
    this.stack.pop();
    const t = this.stack.length > 0 ? this.stack[this.stack.length - 1]! : null;
    this.top = t;
    if (t) {
      t.dmode = DM_PANIC;
      t.panic = p;
      p.depth = depth - 1;
    }
  }

  private zeroResults(d: DFunc): any {
    const sig = this.prog.types[d.f.sig] as any;
    const rs: number[] = sig.results;
    if (rs.length === 0) return undefined;
    if (rs.length === 1) return this.types.zero(rs[0]!);
    return rs.map((r) => this.types.zero(r));
  }

  recover(): any {
    const g = this.top!;
    const st = this.stack;
    const f = st.length >= 2 ? st[st.length - 2]! : null;
    if (g.isDefer && f && f.dmode === DM_PANIC && f.panic && !f.panic.recovered) {
      f.panic.recovered = true;
      return f.panic.v;
    }
    return null;
  }

  // -------------------------------------------------------------- output

  write(fd: number, s: string): void {
    (fd === 2 ? this.err : this.out).push(s);
  }

  // -------------------------------------------------------------- memory

  /** A new object of n elements, each initialised from `z` (elem zero slots). */
  newArray(n: number, z: any[]): Obj {
    if (z.length === 1) return new Array(n).fill(z[0]);
    const o: Obj = new Array(n * z.length);
    let k = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < z.length; j++) o[k++] = z[j];
    return o;
  }

  // -------------------------------------------------------------- decoding

  constValue(c: Const, t: number): any {
    if (c === null || typeof c === "boolean" || typeof c === "string") return c;
    const ti = this.types.info[t]!;
    if ("i" in c) {
      if (ti.ik && WIDTH[ti.ik] < 64) return Number(c.i);
      if (ti.ik && !isSigned(ti.ik)) return canonU(BigInt(c.i));
      return canonS(BigInt(c.i));
    }
    const b = BigInt(c.fbits);
    return ti.fbits === 32 ? Number(b) : canonU(b);
  }

  private decode(id: number): DFunc {
    const f = this.prog.funcs[id]!;
    const d: DFunc = {
      id,
      f,
      nregs: f.regs,
      template: [],
      code: [],
      start: [],
      base: this.base[id]!,
      builtins: [],
    };
    if (f.body === "intrinsic") {
      const name = f.intrinsic ?? f.name;
      d.intrinsic = intrinsics[name];
      return d;
    }
    if (f.body !== "ir") return d;
    const consts: any[] = [];
    const ctx = new Ctx(this, d, consts);
    let pc = 0;
    for (const b of f.blocks) {
      d.start.push(pc);
      pc += b.instrs.length;
    }
    pc = 0;
    f.blocks.forEach((b, bi) => {
      for (const ins of b.instrs) {
        ctx.pc = pc++;
        ctx.block = bi;
        d.code.push(ctx.instr(ins, b));
      }
    });
    const tpl = new Array(f.regs + consts.length);
    for (let i = 0; i < f.regs; i++) tpl[i] = undefined;
    for (let i = 0; i < consts.length; i++) tpl[f.regs + i] = consts[i];
    d.template = tpl;
    return d;
  }

  // ------------------------------------------------------------ op counts

  /** Op counts per function and per instruction kind. */
  opStats(): { total: number; byFunc: Record<string, number>; byKind: Record<string, number> } {
    const byFunc: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    this.prog.funcs.forEach((f, id) => {
      let k = this.base[id]!;
      let fsum = 0;
      for (const b of f.blocks)
        for (const ins of b.instrs) {
          const c = this.counts[k++]!;
          if (c === 0) continue;
          fsum += c;
          const kind =
            ins.op === "binop" || ins.op === "unop"
              ? `${ins.op} ${ins.kind}`
              : ins.op === "call"
                ? "call " + Object.keys(ins.callee)[0]
                : ins.op;
          byKind[kind] = (byKind[kind] ?? 0) + c;
        }
      if (fsum > 0) byFunc[f.name] = fsum;
    });
    return { total: this.ops, byFunc, byKind };
  }
}

function sameEface(a: any, b: any): boolean {
  if (a === null || b === null) return a === b;
  return a.t === b.t && a.v === b.v;
}

function indented(s: string): string {
  return s.replaceAll("\n", "\n\t");
}

const DEADLOCK = "fatal error: all goroutines are asleep - deadlock!\n\ngoroutine 1 [chan receive]:\n";

/** Decoding context of one function. */
class Ctx {
  pc = 0;
  block = 0;
  types: Types;
  m: Machine;
  d: DFunc;
  consts: any[];
  constructor(m: Machine, d: DFunc, consts: any[]) {
    this.m = m;
    this.d = d;
    this.consts = consts;
    this.types = m.types;
  }

  /** Register holding the operand's value (constants get extra registers). */
  r(o: Operand): number {
    if ("r" in o) return o.r;
    let v: any;
    if ("c" in o) v = this.m.constValue(o.c, o.t);
    else if ("zero" in o) v = this.types.zero(o.zero);
    else if ("g" in o) v = new Ptr(this.m.globals[o.g]!, 0);
    else v = new Func(o.f, []);
    this.consts.push(v);
    return this.d.nregs + this.consts.length - 1;
  }

  /** Type of an operand, -1 if unknown (global address, func). */
  t(o: Operand): number {
    if ("r" in o) return this.d.f.regTypes[o.r]!;
    if ("c" in o) return o.t;
    if ("zero" in o) return o.zero;
    return -1;
  }

  /** Underlying type of an operand (a global's address is a pointer). */
  under(o: Operand): any {
    if ("g" in o) return { k: "pointer", elem: this.m.prog.globals[o.g]!.type };
    return this.types.info[this.t(o)]!.u;
  }

  /** Elem type of a pointer-typed operand. */
  ptrElem(o: Operand): number {
    if ("g" in o) return this.m.prog.globals[o.g]!.type;
    const u = this.types.info[this.t(o)]!.u;
    if (u.k !== "pointer") throw new Error(`not a pointer operand in ${this.d.f.name}`);
    return u.elem;
  }

  /** The phi moves for the edge from the current block to its succ k. */
  edge(b: Block, k: number): Code {
    const target = b.succs[k]!;
    const tb = this.d.f.blocks[target]!;
    let occ = 0;
    for (let j = 0; j < k; j++) if (b.succs[j] === target) occ++;
    let ei = -1;
    for (let j = 0; j < tb.preds.length; j++)
      if (tb.preds[j] === this.block && occ-- === 0) {
        ei = j;
        break;
      }
    const dsts: number[] = [];
    const srcs: number[] = [];
    for (const ins of tb.instrs) {
      if (ins.op !== "phi") break;
      dsts.push(ins.dst);
      srcs.push(this.r(ins.edges[ei]!));
    }
    const start = this.d.start[target]!;
    const n = dsts.length;
    if (n === 0)
      return (f) => {
        f.pc = start;
      };
    if (n === 1) {
      const d0 = dsts[0]!;
      const s0 = srcs[0]!;
      return (f) => {
        f.regs[d0] = f.regs[s0];
        f.pc = start;
      };
    }
    const tmp = new Array(n);
    return (f) => {
      const r = f.regs;
      for (let i = 0; i < n; i++) tmp[i] = r[srcs[i]!];
      for (let i = 0; i < n; i++) r[dsts[i]!] = tmp[i];
      f.pc = start;
    };
  }

  instr(ins: Instr, b: Block): Code {
    const m = this.m;
    const T = this.types;
    switch (ins.op) {
      case "alloc": {
        const z = T.zslots(ins.elem);
        const dst = ins.dst;
        return (f) => {
          f.regs[dst] = new Ptr(z.slice(), 0);
        };
      }
      case "load": {
        const dst = ins.dst;
        const p = this.r(ins.ptr);
        const ti = T.info[ins.t]!;
        if (ti.agg) {
          const n = ti.slots;
          return (f) => {
            const q = f.regs[p] as Ptr | null;
            if (q === null) throw nilDeref();
            f.regs[dst] = q.o.slice(q.i, q.i + n);
          };
        }
        return (f) => {
          const q = f.regs[p] as Ptr | null;
          if (q === null) throw nilDeref();
          f.regs[dst] = q.o[q.i];
        };
      }
      case "store": {
        const p = this.r(ins.ptr);
        const v = this.r(ins.val);
        const et = this.ptrElem(ins.ptr);
        const ti = T.info[et]!;
        if (ti.agg) {
          const n = ti.slots;
          return (f) => {
            const q = f.regs[p] as Ptr | null;
            if (q === null) throw nilDeref();
            const x = f.regs[v] as any[];
            const o = q.o;
            for (let i = 0; i < n; i++) o[q.i + i] = x[i];
          };
        }
        return (f) => {
          const q = f.regs[p] as Ptr | null;
          if (q === null) throw nilDeref();
          q.o[q.i] = f.regs[v];
        };
      }
      case "fieldAddr": {
        const st = T.info[this.ptrElem(ins.x)]!.u as any;
        const off = st.fields[ins.field].offset as number;
        const x = this.r(ins.x);
        const dst = ins.dst;
        return (f) => {
          const q = f.regs[x] as Ptr | null;
          if (q === null) throw nilDeref();
          f.regs[dst] = new Ptr(q.o, q.i + off);
        };
      }
      case "field": {
        const st = T.info[this.t(ins.x)]!.u as any;
        const fd = st.fields[ins.field];
        const off = fd.offset as number;
        const fi = T.info[fd.type]!;
        const x = this.r(ins.x);
        const dst = ins.dst;
        if (fi.agg) {
          const n = fi.slots;
          return (f) => {
            f.regs[dst] = (f.regs[x] as any[]).slice(off, off + n);
          };
        }
        return (f) => {
          f.regs[dst] = f.regs[x][off];
        };
      }
      case "indexAddr": {
        const xt = this.under(ins.x);
        const x = this.r(ins.x);
        const ix = this.r(ins.index);
        const dst = ins.dst;
        if (xt.k === "slice") {
          const es = T.info[xt.elem]!.slots;
          return (f) => {
            const s = f.regs[x] as Slice | null;
            const i = num(f.regs[ix]);
            if (s === null) throw indexOOR(i, 0);
            if (i < 0 || i >= s.len) throw indexOOR(i, s.len);
            f.regs[dst] = new Ptr(s.o, s.i + i * es);
          };
        }
        if (xt.k !== "pointer") throw new Error("indexAddr on " + xt.k);
        const at = T.info[this.ptrElem(ins.x)]!.u as any;
        const es = T.info[at.elem]!.slots;
        const len = at.len as number;
        return (f) => {
          const q = f.regs[x] as Ptr | null;
          const i = num(f.regs[ix]);
          if (q === null) throw nilDeref();
          if (i < 0 || i >= len) throw indexOOR(i, len);
          f.regs[dst] = new Ptr(q.o, q.i + i * es);
        };
      }
      case "index": {
        const xt = T.info[this.t(ins.x)]!.u;
        const x = this.r(ins.x);
        const ix = this.r(ins.index);
        const dst = ins.dst;
        if (xt.k === "string")
          return (f) => {
            const s = f.regs[x] as string;
            const i = num(f.regs[ix]);
            if (i < 0 || i >= s.length) throw indexOOR(i, s.length);
            f.regs[dst] = s.charCodeAt(i);
          };
        if (xt.k !== "array") throw new Error("index on " + xt.k);
        const ei = T.info[xt.elem]!;
        const es = ei.slots;
        const len = xt.len;
        if (ei.agg)
          return (f) => {
            const i = num(f.regs[ix]);
            if (i < 0 || i >= len) throw indexOOR(i, len);
            f.regs[dst] = (f.regs[x] as any[]).slice(i * es, i * es + es);
          };
        return (f) => {
          const i = num(f.regs[ix]);
          if (i < 0 || i >= len) throw indexOOR(i, len);
          f.regs[dst] = f.regs[x][i];
        };
      }
      case "binop": {
        const cmp = /[=<>!]/.test(ins.kind) && ins.kind !== "<<" && ins.kind !== ">>";
        let ot = cmp ? this.t(ins.x) : ins.t;
        if (cmp && (ot < 0 || (("c" in ins.x || "zero" in ins.x) && "r" in ins.y))) {
          const yt = this.t(ins.y);
          if (yt >= 0) ot = yt;
        }
        const fn = this.binop(ins.kind, ot);
        const x = this.r(ins.x);
        const y = this.r(ins.y);
        const dst = ins.dst;
        return (f) => {
          f.regs[dst] = fn(f.regs[x], f.regs[y]);
        };
      }
      case "unop": {
        const ti = T.info[ins.t]!;
        const x = this.r(ins.x);
        const dst = ins.dst;
        let fn: (a: any) => any;
        if (ins.kind === "!") fn = (a) => !a;
        else if (!ti.ik) throw new Error(`unop ${ins.kind} on ${ti.k}`);
        else if (WIDTH[ti.ik] === 64) {
          const s = isSigned(ti.ik);
          fn = ins.kind === "-" ? (s ? neg64s : neg64u) : s ? not64s : not64u;
        } else {
          const n = norm(ti.ik);
          fn = ins.kind === "-" ? (a) => n(-a) : (a) => n(~a);
        }
        return (f) => {
          f.regs[dst] = fn(f.regs[x]);
        };
      }
      case "convert": {
        const fn = this.convert(this.t(ins.x), ins.t);
        const x = this.r(ins.x);
        const dst = ins.dst;
        return (f) => {
          f.regs[dst] = fn(f.regs[x]);
        };
      }
      case "changeType":
      case "changeInterface": {
        const x = this.r(ins.x);
        const dst = ins.dst;
        return (f) => {
          f.regs[dst] = f.regs[x];
        };
      }
      case "makeSlice": {
        const et = (T.info[ins.t]!.u as any).elem as number;
        const z = T.zslots(et);
        const l = this.r(ins.len);
        const c = this.r(ins.cap);
        const dst = ins.dst;
        return (f) => {
          const len = f.regs[l];
          const cap = f.regs[c];
          if (len < 0 || len > 2 ** 40) throw rtError("makeslice: len out of range");
          if (cap < len || cap > 2 ** 40) throw rtError("makeslice: cap out of range");
          const n = num(cap);
          f.regs[dst] = new Slice(m.newArray(n, z), 0, num(len), n);
        };
      }
      case "slice":
        return this.sliceOp(ins);
      case "sliceToArrayPtr": {
        const at = T.info[(T.info[ins.t]!.u as any).elem]!.u as any;
        const n = at.len as number;
        const x = this.r(ins.x);
        const dst = ins.dst;
        return (f) => {
          const s = f.regs[x] as Slice | null;
          const len = s === null ? 0 : s.len;
          if (len < n)
            throw rtError(
              `cannot convert slice with length ${len} to array or pointer to array with length ${n}`,
            );
          f.regs[dst] = s === null ? null : new Ptr(s.o, s.i);
        };
      }
      case "makeMap": {
        const t = ins.t;
        const kf = T.key((T.info[t]!.u as any).key);
        const dst = ins.dst;
        return (f) => {
          f.regs[dst] = new GoMap(t, kf);
        };
      }
      case "lookup": {
        const x = this.r(ins.x);
        const k = this.r(ins.index);
        const dst = ins.dst;
        const mt = T.info[this.t(ins.x)]!.u as any;
        const z = T.zero(mt.elem);
        if (ins.commaOk)
          return (f) => {
            const mp = f.regs[x] as GoMap | null;
            const e = mp === null ? undefined : mp.get(f.regs[k]);
            f.regs[dst] = e === undefined ? [z, false] : [e.v, true];
          };
        return (f) => {
          const mp = f.regs[x] as GoMap | null;
          const e = mp === null ? undefined : mp.get(f.regs[k]);
          f.regs[dst] = e === undefined ? z : e.v;
        };
      }
      case "mapUpdate": {
        const x = this.r(ins.map);
        const k = this.r(ins.key);
        const v = this.r(ins.val);
        return (f) => {
          const mp = f.regs[x] as GoMap | null;
          if (mp === null) throw plainError("assignment to entry in nil map");
          mp.set(f.regs[k], f.regs[v]);
        };
      }
      case "makeChan": {
        const t = ins.t;
        const s = this.r(ins.size);
        const dst = ins.dst;
        return (f) => {
          const n = num(f.regs[s]);
          if (n < 0) throw rtError("makechan: size out of range");
          f.regs[dst] = new Chan(t, n);
        };
      }
      case "send": {
        const c = this.r(ins.chan);
        const v = this.r(ins.val);
        return (f) => {
          const ch = f.regs[c] as Chan | null;
          if (ch === null) throw new Exit(2, DEADLOCK);
          if (ch.closed) throw plainError("send on closed channel");
          if (ch.buf.length >= ch.cap) throw new Exit(2, DEADLOCK);
          ch.buf.push(f.regs[v]);
        };
      }
      case "recv": {
        const c = this.r(ins.chan);
        const dst = ins.dst;
        const ok = ins.commaOk;
        const et = (T.info[this.t(ins.chan)]!.u as any).elem as number;
        const z = T.zero(et);
        return (f) => {
          const ch = f.regs[c] as Chan | null;
          if (ch === null) throw new Exit(2, DEADLOCK);
          let v: any;
          let got = true;
          if (ch.buf.length > 0) v = ch.buf.shift();
          else if (ch.closed) {
            v = z;
            got = false;
          } else throw new Exit(2, DEADLOCK);
          f.regs[dst] = ok ? [v, got] : v;
        };
      }
      case "makeInterface": {
        const x = this.r(ins.x);
        const xt = ins.xt;
        const dst = ins.dst;
        return (f) => {
          f.regs[dst] = new Iface(xt, f.regs[x]);
        };
      }
      case "typeAssert":
        return this.typeAssert(ins);
      case "makeClosure": {
        const fn = ins.fn;
        const bs = ins.bindings.map((o) => this.r(o));
        const dst = ins.dst;
        return (f) => {
          const env = new Array(bs.length);
          for (let i = 0; i < bs.length; i++) env[i] = f.regs[bs[i]!];
          f.regs[dst] = new Func(fn, env);
        };
      }
      case "call":
        return this.call(ins.callee, ins.args, ins.dst ?? -1);
      case "extract": {
        const x = this.r(ins.tuple);
        const i = ins.index;
        const dst = ins.dst;
        return (f) => {
          f.regs[dst] = f.regs[x][i];
        };
      }
      case "range": {
        const x = this.r(ins.x);
        const dst = ins.dst;
        if (T.info[this.t(ins.x)]!.k === "string")
          return (f) => {
            f.regs[dst] = new StrIter(f.regs[x], 0);
          };
        return (f) => {
          f.regs[dst] = new MapIter(f.regs[x]);
        };
      }
      case "next": {
        const it = this.r(ins.iter);
        const dst = ins.dst;
        if (ins.isString) {
          return (f) => {
            const s = f.regs[it] as StrIter;
            if (s.pos >= s.s.length) {
              f.regs[dst] = [false, 0, 0];
              return;
            }
            const [r, n] = decodeRune(s.s, s.pos);
            f.regs[dst] = [true, s.pos, r];
            s.pos += n;
          };
        }
        const el = (T.info[ins.t]!.u as any).elems as number[];
        const zk = T.zero(el[1]!);
        const zv = T.zero(el[2]!);
        return (f) => {
          const e = (f.regs[it] as MapIter).next();
          f.regs[dst] = e === null ? [false, zk, zv] : [true, e.k, e.v];
        };
      }
      case "phi":
        return () => {};
      case "jump":
        return this.edge(b, 0);
      case "if": {
        const c = this.r(ins.cond);
        const th = this.edge(b, 0);
        const el = this.edge(b, 1);
        return (f) => {
          if (f.regs[c]) th(f);
          else el(f);
        };
      }
      case "return": {
        const rs = ins.results.map((o) => this.r(o));
        if (rs.length === 0) return (f) => m.ret(f, undefined);
        if (rs.length === 1) {
          const r0 = rs[0]!;
          return (f) => m.ret(f, f.regs[r0]);
        }
        return (f) =>
          m.ret(
            f,
            rs.map((r) => f.regs[r]),
          );
      }
      case "panic": {
        const x = this.r(ins.x);
        return (f) => {
          throw new GoPanic(f.regs[x]);
        };
      }
      case "defer":
        return this.defer(ins.callee, ins.args);
      case "runDefers":
        return (f) => {
          if (f.defers !== null && f.defers.length > 0) {
            f.dmode = DM_RUN;
            m.brk = true;
          }
        };
      case "trap": {
        const w = ins.what;
        return () => {
          throw new Trap(w);
        };
      }
    }
    throw new Error("unknown instruction " + (ins as any).op);
  }

  // ------------------------------------------------------------ binop

  binop(kind: string, ot: number): (a: any, b: any) => any {
    const T = this.types;
    const ti = T.info[ot]!;
    if (kind === "==" || kind === "!=") {
      const eq = T.eq(ot);
      const e = eq ?? ((a: any, b: any) => a === b);
      if (ti.k === "bool" || ti.k === "int" || ti.k === "string")
        return kind === "==" ? (a, b) => a === b : (a, b) => a !== b;
      return kind === "==" ? e : (a, b) => !e(a, b);
    }
    switch (kind) {
      case "<":
        return (a, b) => a < b;
      case "<=":
        return (a, b) => a <= b;
      case ">":
        return (a, b) => a > b;
      case ">=":
        return (a, b) => a >= b;
    }
    if (ti.k === "string") {
      if (kind === "+") return (a, b) => a + b;
      throw new Error("string binop " + kind);
    }
    const ik = ti.ik;
    if (!ik) throw new Error(`binop ${kind} on ${ti.k}`);
    const s = isSigned(ik);
    if (WIDTH[ik] === 64) {
      switch (kind) {
        case "+":
          return s ? add64s : add64u;
        case "-":
          return s ? sub64s : sub64u;
        case "*":
          return s ? mul64s : mul64u;
        case "/":
          return s ? div64s : div64u;
        case "%":
          return s ? rem64s : rem64u;
        case "&":
          return and64(s);
        case "|":
          return or64(s);
        case "^":
          return xor64(s);
        case "&^":
          return andNot64(s);
        case "<<":
          return shl64(s);
        case ">>":
          return shr64(s);
      }
      throw new Error("binop " + kind);
    }
    const n = norm(ik as Kind);
    const w = WIDTH[ik];
    switch (kind) {
      case "+":
        return (a, b) => n(a + b);
      case "-":
        return (a, b) => n(a - b);
      case "*":
        return w === 32 ? (a, b) => n(Math.imul(a, b)) : (a, b) => n(a * b);
      case "/":
        return (a, b) => {
          if (b === 0) throw rtError("integer divide by zero");
          return n(Math.trunc(a / b));
        };
      case "%":
        return (a, b) => {
          if (b === 0) throw rtError("integer divide by zero");
          return n(a % b);
        };
      case "&":
        return (a, b) => n(a & b);
      case "|":
        return (a, b) => n(a | b);
      case "^":
        return (a, b) => n(a ^ b);
      case "&^":
        return (a, b) => n(a & ~b);
      case "<<":
        return (a, b) => {
          const c = shiftCount(b);
          return c >= w ? 0 : n(a << c);
        };
      case ">>":
        return s
          ? (a, b) => {
              const c = shiftCount(b);
              return c >= w ? (a < 0 ? -1 : 0) : a >> c;
            }
          : (a, b) => {
              const c = shiftCount(b);
              return c >= w ? 0 : a >>> c;
            };
    }
    throw new Error("binop " + kind);
  }

  // ------------------------------------------------------------ convert

  convert(from: number, to: number): (x: any) => any {
    const T = this.types;
    const fi = T.info[from]!;
    const ti = T.info[to]!;
    if (fi.ik && ti.ik) return convInt(fi.ik, ti.ik);
    if (fi.ik && ti.k === "string")
      return (x) => encodeRune(typeof x === "bigint" ? -1 : x);
    if (fi.k === "string" && ti.k === "slice") {
      const ek = T.info[(ti.u as any).elem]!.ik;
      if (ek === "uint8" || ek === "int8")
        return (s: string) => {
          const n = s.length;
          if (n === 0) return new Slice([], 0, 0, 0);
          const cap = roundupsize(n, true);
          const o = new Array(cap).fill(0);
          for (let i = 0; i < n; i++) o[i] = s.charCodeAt(i);
          return new Slice(o, 0, n, cap);
        };
      return (s: string) => {
        const rs: number[] = [];
        for (let i = 0; i < s.length; ) {
          const [r, w] = decodeRune(s, i);
          rs.push(r);
          i += w;
        }
        const n = rs.length;
        if (n === 0) return new Slice([], 0, 0, 0);
        const cap = Math.floor(roundupsize(n * 4, true) / 4);
        for (let i = n; i < cap; i++) rs.push(0);
        return new Slice(rs, 0, n, cap);
      };
    }
    if (fi.k === "slice" && ti.k === "string") {
      const ek = T.info[(fi.u as any).elem]!.ik;
      if (ek === "uint8" || ek === "int8")
        return (s: Slice | null) => {
          if (s === null || s.len === 0) return "";
          return bytesToString(s.o, s.i, s.len);
        };
      return (s: Slice | null) => {
        if (s === null) return "";
        let r = "";
        for (let i = 0; i < s.len; i++) r += encodeRune(s.o[s.i + i]);
        return r;
      };
    }
    if (fi.k === "slice" && ti.k === "array") {
      const n = (ti.u as any).len as number;
      const sl = ti.slots;
      return (s: Slice | null) => {
        const len = s === null ? 0 : s.len;
        if (len < n)
          throw rtError(
            `cannot convert slice with length ${len} to array or pointer to array with length ${n}`,
          );
        return s === null ? [] : s.o.slice(s.i, s.i + sl);
      };
    }
    return (x) => x;
  }

  // ------------------------------------------------------------ slice

  sliceOp(ins: Extract<Instr, { op: "slice" }>): Code {
    const T = this.types;
    const xu = this.under(ins.x);
    const x = this.r(ins.x);
    const lo = ins.low ? this.r(ins.low) : -1;
    const hi = ins.high ? this.r(ins.high) : -1;
    const mx = ins.max ? this.r(ins.max) : -1;
    const dst = ins.dst;
    if (xu.k === "string")
      return (f) => {
        const s = f.regs[x] as string;
        const n = s.length;
        const l = lo < 0 ? 0 : num(f.regs[lo]);
        const h = hi < 0 ? n : num(f.regs[hi]);
        if (h < 0) throw rtError(`slice bounds out of range [:${h}]`);
        if (h > n) throw rtError(`slice bounds out of range [:${h}] with length ${n}`);
        if (l < 0) throw rtError(`slice bounds out of range [${l}:]`);
        if (l > h) throw rtError(`slice bounds out of range [${l}:${h}]`);
        f.regs[dst] = s.substring(l, h);
      };
    let es: number;
    let isArr = false;
    let alen = 0;
    if (xu.k === "slice") es = T.info[xu.elem]!.slots;
    else if (xu.k === "pointer") {
      const at = T.info[this.ptrElem(ins.x)]!.u as any;
      es = T.info[at.elem]!.slots;
      isArr = true;
      alen = at.len;
    } else throw new Error("slice of " + xu.k);
    const what = isArr ? "length" : "capacity";
    return (f) => {
      let o: Obj;
      let base: number;
      let len: number;
      let cap: number;
      const v = f.regs[x];
      if (isArr) {
        if (v === null) throw nilDeref();
        o = (v as Ptr).o;
        base = (v as Ptr).i;
        len = cap = alen;
      } else if (v === null) {
        o = [];
        base = 0;
        len = cap = 0;
      } else {
        o = (v as Slice).o;
        base = (v as Slice).i;
        len = (v as Slice).len;
        cap = (v as Slice).cap;
      }
      const l = lo < 0 ? 0 : num(f.regs[lo]);
      if (mx >= 0) {
        const k = num(f.regs[mx]);
        if (k < 0) throw rtError(`slice bounds out of range [::${k}]`);
        if (k > cap) throw rtError(`slice bounds out of range [::${k}] with ${what} ${cap}`);
        const h = hi < 0 ? len : num(f.regs[hi]);
        if (h < 0) throw rtError(`slice bounds out of range [:${h}:]`);
        if (h > k) throw rtError(`slice bounds out of range [:${h}:${k}]`);
        if (l < 0) throw rtError(`slice bounds out of range [${l}::]`);
        if (l > h) throw rtError(`slice bounds out of range [${l}:${h}:]`);
        f.regs[dst] = v === null && k === 0 ? null : new Slice(o, base + l * es, h - l, k - l);
        return;
      }
      const h = hi < 0 ? len : num(f.regs[hi]);
      if (h < 0) throw rtError(`slice bounds out of range [:${h}]`);
      if (h > cap) throw rtError(`slice bounds out of range [:${h}] with ${what} ${cap}`);
      if (l < 0) throw rtError(`slice bounds out of range [${l}:]`);
      if (l > h) throw rtError(`slice bounds out of range [${l}:${h}]`);
      f.regs[dst] = v === null ? null : new Slice(o, base + l * es, h - l, cap - l);
    };
  }

  // ------------------------------------------------------------ typeAssert

  typeAssert(ins: Extract<Instr, { op: "typeAssert" }>): Code {
    const T = this.types;
    const x = this.r(ins.x);
    const dst = ins.dst;
    const at = ins.assert;
    const st = this.t(ins.x);
    const ok = ins.commaOk;
    const isIface = T.info[at]!.k === "interface";
    const z = isIface ? null : T.zero(at);
    const fail = (v: Iface | null) => {
      const sn = T.name(st);
      if (v === null) return plainError(`interface conversion: interface is nil, not ${T.name(at)}`);
      if (isIface) {
        const mm = T.missing(v.t, at)!;
        return plainError(
          `interface conversion: ${T.name(v.t)} is not ${T.name(at)}: missing method ${mm.slice(mm.lastIndexOf(".") + 1)}`,
        );
      }
      return plainError(`interface conversion: ${sn} is ${T.name(v.t)}, not ${T.name(at)}`);
    };
    if (isIface)
      return (f) => {
        const v = f.regs[x] as Iface | null;
        const good = v !== null && T.implements(v.t, at);
        if (ok) f.regs[dst] = [good ? v : null, good];
        else if (good) f.regs[dst] = v;
        else throw fail(v);
      };
    return (f) => {
      const v = f.regs[x] as Iface | null;
      const good = v !== null && v.t === at;
      if (ok) f.regs[dst] = good ? [v.v, true] : [z, false];
      else if (good) f.regs[dst] = v.v;
      else throw fail(v);
    };
  }

  // ------------------------------------------------------------ calls

  call(c: Callee, argOps: Operand[], dst: number): Code {
    const m = this.m;
    const args = argOps.map((o) => this.r(o));
    const na = args.length;
    if ("static" in c) {
      const fid = c.static;
      const fn = m.prog.funcs[fid]!;
      if (fn.body === "ir") {
        let d: DFunc | undefined;
        return (f) => {
          d ??= m.dfunc(fid);
          const regs = d.template.slice();
          const r = f.regs;
          for (let i = 0; i < na; i++) regs[i] = r[args[i]!];
          const fr = new Frame(d, regs, dst, false);
          m.stack.push(fr);
          m.top = fr;
          m.brk = true;
        };
      }
      return (f) => {
        const a = new Array(na);
        for (let i = 0; i < na; i++) a[i] = f.regs[args[i]!];
        m.pushFrame(fid, a, null, dst, false);
      };
    }
    if ("value" in c) {
      const fv = this.r(c.value);
      return (f) => {
        const v = f.regs[fv] as Func | null;
        if (v === null) throw nilDeref();
        const a = new Array(na);
        for (let i = 0; i < na; i++) a[i] = f.regs[args[i]!];
        m.pushFrame(v.fn, a, v.env, dst, false);
      };
    }
    if ("invoke" in c) {
      const rv = this.r(c.invoke);
      const meth = c.method;
      const T = this.types;
      return (f) => {
        const v = f.regs[rv] as Iface | null;
        if (v === null) throw nilDeref();
        const fid = T.methods(v.t)[meth];
        if (fid === undefined) throw new Trap(`no method ${meth} on ${T.name(v.t)}`);
        const a = new Array(na + 1);
        a[0] = v.v;
        for (let i = 0; i < na; i++) a[i + 1] = f.regs[args[i]!];
        m.pushFrame(fid, a, null, dst, false);
      };
    }
    const bf = this.builtin(c.builtin, argOps);
    return (f) => {
      const a = new Array(na);
      for (let i = 0; i < na; i++) a[i] = f.regs[args[i]!];
      const r = bf(a, f);
      if (dst >= 0) f.regs[dst] = r;
    };
  }

  defer(c: Callee, argOps: Operand[]): Code {
    const args = argOps.map((o) => this.r(o));
    const na = args.length;
    const T = this.types;
    const ev = (f: Frame) => {
      const a = new Array(na);
      for (let i = 0; i < na; i++) a[i] = f.regs[args[i]!];
      return a;
    };
    const push = (f: Frame, d: Defer) => {
      (f.defers ??= []).push(d);
    };
    if ("static" in c) {
      const fid = c.static;
      return (f) => push(f, { fn: fid, env: null, args: ev(f), bpc: -1 });
    }
    if ("value" in c) {
      const fv = this.r(c.value);
      return (f) => {
        const v = f.regs[fv] as Func | null;
        push(f, { fn: v === null ? -1 : v.fn, env: v === null ? null : v.env, args: ev(f), bpc: -1 });
      };
    }
    if ("invoke" in c) {
      const rv = this.r(c.invoke);
      const meth = c.method;
      return (f) => {
        const v = f.regs[rv] as Iface | null;
        if (v === null) throw nilDeref();
        const fid = T.methods(v.t)[meth];
        if (fid === undefined) throw new Trap(`no method ${meth} on ${T.name(v.t)}`);
        push(f, { fn: fid, env: null, args: [v.v, ...ev(f)], bpc: -1 });
      };
    }
    const pc = this.pc;
    this.d.builtins[pc] = this.builtin(c.builtin, argOps);
    return (f) => push(f, { fn: -1, env: null, args: ev(f), bpc: pc });
  }

  // ------------------------------------------------------------ builtins

  builtin(name: string, argOps: Operand[]): (a: any[], f: Frame) => any {
    const m = this.m;
    const T = this.types;
    const at = argOps.map((o) => this.t(o));
    const u0 = at[0] !== undefined && at[0] >= 0 ? T.info[at[0]]!.u : null;
    switch (name) {
      case "len":
        switch (u0?.k) {
          case "string":
            return (a) => a[0].length;
          case "slice":
            return (a) => (a[0] === null ? 0 : a[0].len);
          case "map":
            return (a) => (a[0] === null ? 0 : a[0].size);
          case "chan":
            return (a) => (a[0] === null ? 0 : a[0].buf.length);
          case "array": {
            const n = u0.len;
            return () => n;
          }
          case "pointer": {
            const n = (T.info[u0.elem]!.u as any).len;
            return () => n;
          }
        }
        throw new Error("len of " + u0?.k);
      case "cap":
        switch (u0?.k) {
          case "slice":
            return (a) => (a[0] === null ? 0 : a[0].cap);
          case "chan":
            return (a) => (a[0] === null ? 0 : a[0].cap);
          case "array": {
            const n = u0.len;
            return () => n;
          }
          case "pointer": {
            const n = (T.info[u0.elem]!.u as any).len;
            return () => n;
          }
        }
        throw new Error("cap of " + u0?.k);
      case "append": {
        const et = (u0 as any).elem as number;
        const es = T.info[et]!.slots;
        const z = T.zslots(et);
        const [size] = T.size(et);
        const noscan = !T.ptrs(et);
        const fromString = T.info[at[1]!]!.k === "string";
        return (a) => {
          const s = a[0] as Slice | null;
          const y = a[1];
          let src: any[];
          let si: number;
          let n: number;
          if (fromString) {
            const str = y as string;
            n = str.length;
            src = [];
            for (let i = 0; i < n; i++) src.push(str.charCodeAt(i));
            si = 0;
          } else {
            const ys = y as Slice | null;
            n = ys === null ? 0 : ys.len;
            src = ys === null ? [] : ys.o;
            si = ys === null ? 0 : ys.i;
          }
          if (n === 0) return s;
          const len = s === null ? 0 : s.len;
          const cap = s === null ? 0 : s.cap;
          const newLen = len + n;
          const cnt = n * es;
          if (newLen <= cap) {
            const o = s!.o;
            const di = s!.i + len * es;
            if (src === o) {
              const tmp = src.slice(si, si + cnt);
              for (let i = 0; i < cnt; i++) o[di + i] = tmp[i];
            } else for (let i = 0; i < cnt; i++) o[di + i] = src[si + i];
            return new Slice(o, s!.i, newLen, cap);
          }
          const nc = growCap(newLen, cap, size, noscan);
          const o = m.newArray(nc, z);
          if (s !== null) for (let i = 0; i < len * es; i++) o[i] = s.o[s.i + i];
          const di = len * es;
          for (let i = 0; i < cnt; i++) o[di + i] = src[si + i];
          return new Slice(o, 0, newLen, nc);
        };
      }
      case "copy": {
        const et = (u0 as any).elem as number;
        const es = T.info[et]!.slots;
        const fromString = T.info[at[1]!]!.k === "string";
        return (a) => {
          const d = a[0] as Slice | null;
          if (d === null) return 0;
          if (fromString) {
            const s = a[1] as string;
            const n = Math.min(d.len, s.length);
            for (let i = 0; i < n; i++) d.o[d.i + i] = s.charCodeAt(i);
            return n;
          }
          const s = a[1] as Slice | null;
          if (s === null) return 0;
          const n = Math.min(d.len, s.len);
          const cnt = n * es;
          if (s.o === d.o && s.i < d.i) for (let i = cnt - 1; i >= 0; i--) d.o[d.i + i] = s.o[s.i + i];
          else for (let i = 0; i < cnt; i++) d.o[d.i + i] = s.o[s.i + i];
          return n;
        };
      }
      case "delete":
        return (a) => {
          if (a[0] !== null) (a[0] as GoMap).delete(a[1]);
        };
      case "clear":
        if (u0?.k === "map")
          return (a) => {
            if (a[0] !== null) (a[0] as GoMap).clear();
          };
        {
          const et = (u0 as any).elem as number;
          const z = T.zslots(et);
          return (a) => {
            const s = a[0] as Slice | null;
            if (s === null) return;
            for (let i = 0; i < s.len; i++)
              for (let j = 0; j < z.length; j++) s.o[s.i + i * z.length + j] = z[j];
          };
        }
      case "min":
        return (a) => a.reduce((x, y) => (y < x ? y : x));
      case "max":
        return (a) => a.reduce((x, y) => (y > x ? y : x));
      case "print":
      case "println": {
        const fs = at.map((t) => this.printer(t));
        const ln = name === "println";
        return (a) => {
          const parts = a.map((v, i) => fs[i]!(v));
          m.write(2, ln ? parts.join(" ") + "\n" : parts.join(""));
        };
      }
      case "recover":
        return () => m.recover();
      case "close":
        return (a) => {
          const c = a[0] as Chan | null;
          if (c === null) throw plainError("close of nil channel");
          if (c.closed) throw plainError("close of closed channel");
          c.closed = true;
        };
      case "wrapnilchk":
        return (a) => {
          if (a[0] === null) {
            const typ = String(a[1]);
            const dot = typ.lastIndexOf(".");
            throw plainError(
              `value method ${typ}.${a[2]} called using nil *${dot >= 0 ? typ.slice(dot + 1) : typ} pointer`,
            );
          }
          return a[0];
        };
    }
    throw new Error("unknown builtin " + name);
  }

  printer(t: number): (v: any) => string {
    const T = this.types;
    const ti = t >= 0 ? T.info[t]! : null;
    switch (ti?.k) {
      case "bool":
      case "int":
        return (v) => String(v);
      case "string":
        return (v) => v;
      case "float":
        return ti.fbits === 32 ? (v) => printFloat(bitsToF32(v)) : (v) => printFloat(bitsToF64(v));
      case "slice":
        return (v: Slice | null) => (v === null ? "[0/0]0x0" : `[${v.len}/${v.cap}]0xc000010000`);
      case "interface":
        return (v) => (v === null ? "(0x0,0x0)" : "(0x10000,0xc000010000)");
    }
    return (v) => (v === null ? "0x0" : "0xc000010000");
  }
}

export function bytesToString(o: any[], i: number, n: number): string {
  let r = "";
  for (let k = 0; k < n; k += 8192)
    r += String.fromCharCode.apply(null, o.slice(i + k, i + Math.min(n, k + 8192)));
  return r;
}
