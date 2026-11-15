// The emitter (docs/EMIT.md): IR -> a `.d.ts` module of type aliases run by
// tsrs with the stage 4 primitives (src/types) and the runtime src/emit/rt.ts.
//
// Every block is one or more segment aliases `name<H, K, X, F, D?, regs...>`
// (H heap, K stack, X extras, F fuel, D the defer list of functions with
// defers, then the live registers). A segment body is a nest of
// conditionals: `extends infer v` bindings (at most 4 per alias), panic
// checks (`Ck extends true ? ... : panic`), ending in a tail call: the next
// segment, a block entry (jump/if), a callee's entry (static call), or a
// yield to the driver (return, dynamic call, panic, fuel out).
import type { Block, Func, Instr, Operand, Program, Type } from "../ir/types.ts";
import { Types } from "../ref/types.ts";
import { decNat, encNat, globalIds, initialHeap, progTables, strLit } from "../types/codec-heap.ts";
import { def, edgeIndex, liveness, uses } from "./live.ts";

export interface EmitOptions {
  /** Prefix of exported names (default "G"). */
  prefix?: string;
  /** Import path of the runtime directory (src/emit/runtime.ts writeRuntime) from the output file (no trailing slash). */
  rt: string;
  /** Fuel units per chunk (default rt.ts FUEL, 900). */
  fuel?: number;
  /** Only these functions (by name) get bodies; others trap (size mode). */
  keep?: Set<string>;
}

/**
 * One entry of the emitted module (the sidecar entry table, EMIT.md
 * "Entries"): where it resumes and how its argument `A` maps to registers.
 */
export interface EntryInfo {
  key: string;
  fid: number;
  /**
   * "block": a block's start; "mid": inside a block (a fuel point); "call":
   * a call's return point; "recover": the recover block; "switch": a case of
   * a switch dispatch (`s<fid>_<blk>`: as if at the case block's compare,
   * which then holds; A also holds values dead there; not a start point)
   */
  kind: "block" | "mid" | "call" | "recover" | "switch";
  /** block index (block, mid, recover) or the call's block */
  block: number;
  /** flattened instruction index: the next instruction to run (block, mid, recover) or the call / runDefers instruction (call) */
  pc: number;
  /** block / mid: register of A[i] (-1 = D); call: register of Regs[i] (A = [result, Regs, D]); recover: register of Regs[i] */
  regs: number[];
  /** the entry takes D (A[k] = D for block/mid, A[2] for call) */
  hasD: boolean;
  /** call: the result register (-1: none or unused) */
  dst?: number;
}

export interface EmitStats {
  funcs: number;
  blocks: number;
  segments: number;
  entries: number;
  bytes: number;
}

const D_REG = -1;
const UNIT = 1000; // estimated instantiations per fuel unit
const MAX_W = 880;
/** Estimated instantiations and segments per fuel group (a group starts with a fuel check). */
const GROUP_COST = 40000;
const GROUP_SEGS = 40;
const MAX_HEAP_NEST = 4;

const W_OF: Record<string, string> = {
  int8: "i8",
  int16: "i16",
  int32: "i32",
  int64: "i64",
  uint8: "u8",
  uint16: "u16",
  uint32: "u32",
  uint64: "u64",
};

const CMP_OP = { "<": "Lt", "<=": "Le", ">": "Gt", ">=": "Ge" };
const ARITH_OP = {
  "+": "Add",
  "-": "Sub",
  "*": "Mul",
  "&": "And",
  "|": "Or",
  "^": "Xor",
  "&^": "AndNot",
};
const n2 = (v: number | bigint) => strLit(encNat(v));

/** Emits the program; returns the module text. */
export function emit(
  prog: Program,
  opts: EmitOptions,
  stats?: EmitStats,
  entries?: EntryInfo[],
): string {
  const em = new Emitter(prog, opts);
  const out = em.run(stats);
  if (entries) for (const x of em.entryTable) entries.push(x);
  return out;
}

interface Seg {
  name: string;
  params: string[];
  body: string;
}

class Emitter {
  prog: Program;
  T: Types;
  o: EmitOptions;
  px: string;
  out: string[] = [];
  entries: string[] = []; // `key: iface;`
  entryTable: EntryInfo[] = [];
  zeroAliases = new Map<number, string>();
  zeroObjAliases = new Map<number, string>();
  methodTabs = new Map<string, Map<number, number>>();
  gids: string[];
  dynFuncs = new Set<number>();
  segCount = 0;
  blockCount = 0;
  ES: string; // runtime.errorString type id (int text)
  PE: string; // runtime.plainError
  PNE: string; // *runtime.PanicNilError or ""

  constructor(prog: Program, o: EmitOptions) {
    this.prog = prog;
    this.o = o;
    this.px = o.prefix ?? "G";
    this.T = new Types(prog);
    this.gids = globalIds(prog);
    const es = this.T.byName.get("runtime.errorString") ?? -1;
    const pe = this.T.byName.get("runtime.plainError") ?? es;
    this.ES = n2(es);
    this.PE = n2(pe);
    const pne = this.T.byName.get("runtime.PanicNilError");
    const pnp = prog.types.findIndex((t) => t.k === "pointer" && t.elem === pne);
    this.PNE = pnp >= 0 ? n2(pnp) : "";
  }

  run(stats?: EmitStats): string {
    const p = this.prog;
    const px = this.px;
    // functions reachable by a dynamic call
    this.dynFuncs.add(p.init);
    if (p.main !== null) this.dynFuncs.add(p.main);
    for (const fid of Object.values(p.entries)) this.dynFuncs.add(fid);
    p.types.forEach((_t, id) => {
      const ms = this.T.methods(id);
      for (const [m, fid] of Object.entries(ms)) {
        let tab = this.methodTabs.get(m);
        if (!tab) this.methodTabs.set(m, (tab = new Map()));
        tab.set(id, fid);
        this.dynFuncs.add(fid);
      }
    });
    for (const f of p.funcs)
      for (const b of f.blocks)
        for (const ins of b.instrs) {
          const scan = (o: Operand | undefined) => {
            if (o && "f" in o) this.dynFuncs.add(o.f);
          };
          for (const k of Object.keys(ins)) {
            const v = (ins as any)[k];
            if (v && typeof v === "object") {
              if (Array.isArray(v)) v.forEach((x) => x && typeof x === "object" && scan(x));
              else scan(v);
            }
          }
          if (ins.op === "makeClosure") this.dynFuncs.add(ins.fn);
          if (ins.op === "defer" && "static" in ins.callee) this.dynFuncs.add(ins.callee.static);
          if (ins.op === "call" && "value" in ins.callee) scan(ins.callee.value);
          if (ins.op === "defer" && "value" in ins.callee) scan(ins.callee.value);
        }

    const head: string[] = [];
    head.push(`// Generated by scripts/emit.ts (src/emit/emit.ts). Do not edit.`);
    const rt = this.o.rt;
    head.push(`import type * as R from "${rt}/rt.d.ts";`);
    head.push(`import type * as I from "${rt}/int.d.ts";`);
    head.push(`import type * as N from "${rt}/nat.d.ts";`);
    head.push(`import type * as Hp from "${rt}/heap.d.ts";`);
    head.push(`import type * as Sr from "${rt}/str.d.ts";`);
    head.push(`import type * as Mp from "${rt}/map.d.ts";`);
    head.push(`import type * as Ch from "${rt}/chacha.d.ts";`);
    head.push(`import type { EB } from "${rt}/rt.d.ts";`);

    p.funcs.forEach((f, fid) => this.func(f, fid));

    // function entries for dynamic calls
    p.funcs.forEach((f, fid) => {
      if (/^gointypes\/softfloat\.PrintFloat(32|64)$/.test(f.name)) this.dynFuncs.add(fid);
    });
    for (const fid of [...this.dynFuncs].sort((a, b) => a - b)) this.funcEntry(fid);

    // method tables
    const mt: string[] = [];
    for (const [m, tab] of [...this.methodTabs].sort()) {
      const body = [...tab].map(([t, fid]) => `${n2(t)}: ${n2(fid)};`).join(" ");
      mt.push(`interface Mt_${mname(m)} { ${body} }`);
    }
    // program tables (assertions, names, equality kinds)
    const dyn: number[] = [];
    const ifaces: number[] = [];
    const seenDyn = new Set<number>();
    for (const f of p.funcs)
      for (const b of f.blocks)
        for (const ins of b.instrs) {
          if (ins.op === "makeInterface" && !seenDyn.has(ins.xt)) {
            seenDyn.add(ins.xt);
            dyn.push(ins.xt);
          }
          if (ins.op === "typeAssert" && this.T.info[ins.assert]!.k === "interface")
            if (!ifaces.includes(ins.assert)) ifaces.push(ins.assert);
        }
    for (const n of ["runtime.errorString", "runtime.plainError"]) {
      const t = this.T.byName.get(n);
      if (t !== undefined && !seenDyn.has(t)) (dyn.push(t), seenDyn.add(t));
    }
    if (this.PNE) {
      const t = Number(decNatInt(JSON.parse(this.PNE)));
      if (!seenDyn.has(t)) dyn.push(t);
    }
    const tables = progTables(p, dyn, ifaces, "P");
    // float panic values print through softfloat.PrintFloat64/32 (Go code)
    const flt: string[] = [];
    for (const t of dyn) {
      const ti = this.info(t);
      if (ti.k !== "float") continue;
      const fid = p.funcs.findIndex((f) => f.name === `gointypes/softfloat.PrintFloat${ti.fbits}`);
      if (fid >= 0) flt.push(`${n2(t)}: ${n2(fid)};`);
    }
    if (flt.length) mt.push(`interface Mt_Flt { ${flt.join(" ")} }`);
    // per-type panic print kinds, zero results, recover entries
    const pk: string[] = [];
    for (const t of dyn) pk.push(`${n2(t)}: ${this.printKind(t)};`);
    const zr: string[] = [];
    const rc: string[] = [];
    p.funcs.forEach((f, fid) => {
      const sig = p.types[f.sig] as Extract<Type, { k: "func" }>;
      zr.push(`${n2(fid)}: ${this.resultsZero(sig.results)};`);
      if (f.body === "ir" && f.recover >= 0) rc.push(`${n2(fid)}: "r${fid}";`);
    });

    // initial heap
    const heap = initialHeap(p, `${rt}/heap.gen.d.ts`, "H0")
      .replace(
        /^import .*$/m,
        `import type { E0, E1, E2, E3, E4, E5, E6, Mk16, Mk19 } from "${rt}/heap.gen.d.ts";`,
      )
      .replace(/^export type H0/m, "type H0");

    const tail: string[] = [];
    tail.push(tables);
    tail.push(`interface PK { ${pk.join(" ")} }`);
    tail.push(`interface ZR { ${zr.join(" ")} }`);
    tail.push(`interface RC { ${rc.join(" ")} }`);
    // panic tails of frames without recover registers (SegB.pnH)
    tail.push(
      `type PH<H, K, X, F, C, D, Fid> = R.Pc<H, K, X, F, R.HPanicV<C, ${this.ES}, ${this.PE}>, ["", [], D, Fid]>;`,
    );
    tail.push(
      `type PN<H, K, X, F, D, Fid> = R.Pc<H, K, X, F, [${this.ES}, "invalid memory address or nil pointer dereference"], ["", [], D, Fid]>;`,
    );
    tail.push(
      `interface Prog { e: E; pk: PK; zr: ZR; rc: RC; p: P; mErr: ${this.methodTabs.has("Error") ? "Mt_Error" : "{}"}; mStr: ${this.methodTabs.has("String") ? "Mt_String" : "{}"}; mFlt: ${flt.length ? "Mt_Flt" : "{}"}; es: ${this.ES}; fuel: ${this.o.fuel ? '"' + "x".repeat(this.o.fuel) + '"' : "R.FUEL"}; }`,
    );
    tail.push(`interface E { ${this.entries.join(" ")} }`);
    const mainCont =
      p.main === null
        ? `R.Ct<"b", "", [], null, "0", "">`
        : `R.Ct<"m", "", [], null, ${n2(p.main)}, "">`;
    tail.push(
      `export type ${px}S0 = R.St<"c", "", H0, R.Cons<${mainCont}, null>, R.Xt<"", "", null, "s">, [${n2(p.init)}, [], []], "">;`,
    );
    tail.push(`export type ${px}Chunk<S> = R.Chunk<Prog, S>;`);
    tail.push(`export type ${px}Out<S> = R.Out<S>;`);
    tail.push(`export type ${px}Err<S> = R.Err<S>;`);
    tail.push(`export type ${px}Exit<S> = R.Exit<S>;`);
    tail.push(`export type ${px}Done<S> = R.Done<S>;`);
    tail.push(`export type ${px}Exec<S, K0 extends string = "0"> = R.Exec<Prog, S, K0>;`);

    const zs: string[] = [];
    for (const [t, nm] of this.zeroAliases) zs.push(`type ${nm} = ${this.zeroText(t)};`);
    for (const [t, nm] of this.zeroObjAliases) zs.push(`type ${nm} = ${this.zeroObjText(t)};`);

    const text = [...head, heap, ...zs, ...mt, ...this.out, ...tail].join("\n") + "\n";
    if (stats) {
      stats.funcs = p.funcs.length;
      stats.blocks = this.blockCount;
      stats.segments = this.segCount;
      stats.entries = this.entries.length;
      stats.bytes = text.length;
    }
    return text;
  }

  // ------------------------------------------------------------ type facts

  info(t: number) {
    return this.T.info[t]!;
  }
  kindW(t: number): string {
    const ik = this.info(t).ik;
    if (ik) return W_OF[ik]!;
    const fb = this.info(t).fbits;
    if (fb) return fb === 32 ? "u32" : "u64";
    throw new Error(`not an integer type ${t}`);
  }
  isUnsigned(t: number): boolean {
    return this.kindW(t)[0] === "u";
  }
  slots(t: number): number {
    return this.prog.types[t]!.slots;
  }

  /** Text of a scalar zero value. */
  scalarZero(t: number): string {
    const k = this.info(t).k;
    switch (k) {
      case "bool":
        return "false";
      case "int":
      case "float":
        return '"0"';
      case "string":
        return '""';
      case "tuple":
        return `[${((this.info(t).u as any).elems as number[]).map((e) => this.zero(e)).join(", ")}]`;
      default:
        return "null";
    }
  }
  /** Zero value of a type in register form (aggregates: an alias). */
  zero(t: number): string {
    if (!this.info(t).agg) return this.scalarZero(t);
    let nm = this.zeroAliases.get(t);
    if (!nm) this.zeroAliases.set(t, (nm = `Z${t}`));
    return nm;
  }
  zeroText(t: number): string {
    // too big to hold in types (only reached through nil pointers)
    if (this.info(t).slots > BIG_SLOTS) return "never";
    return `[${this.T.slotTypes(t)
      .map((s) => this.scalarZero(s))
      .join(", ")}]`;
  }
  /** Zero slots tuple (for LoadK / lazy zero patterns), even for scalars. */
  zslots(t: number): string {
    if (this.info(t).agg) return this.zero(t);
    return `[${this.scalarZero(t)}]`;
  }
  /** The shortest periodic zero pattern of a type's slots (arrays repeat their element's). */
  zpat(t: number): string {
    const u = this.info(t).u as any;
    if (u.k === "array" && u.len > 0) return this.zpat(u.elem);
    return this.zslots(t);
  }
  zeroObj(t: number): string {
    let nm = this.zeroObjAliases.get(t);
    if (!nm) this.zeroObjAliases.set(t, (nm = `ZO${t}`));
    return nm;
  }
  zeroObjText(t: number): string {
    if (this.info(t).slots > BIG_SLOTS) return "never";
    const z = this.T.slotTypes(t).map((s) => this.scalarZero(s));
    return `Hp.Flat<${z.join(", ")}>`;
  }
  resultsZero(rs: number[]): string {
    if (rs.length === 0) return "null";
    if (rs.length === 1) return this.zeroInline(rs[0]!);
    return `[${rs.map((r) => this.zeroInline(r)).join(", ")}]`;
  }
  zeroInline(t: number): string {
    return this.info(t).agg ? this.zeroText(t) : this.scalarZero(t);
  }
  printKind(t: number): string {
    const ti = this.info(t);
    const named = ti.t.k === "named";
    const name = strLit(this.T.name(t));
    let k: string;
    switch (ti.k) {
      case "bool":
        k = '"b"';
        break;
      case "int":
        k = `"${this.kindW(t)}"`;
        break;
      case "float":
        k = `"f${ti.fbits}"`;
        break;
      case "string":
        k = '"s"';
        break;
      default:
        k = '"o"';
    }
    return `[${k}, ${named}, ${name}]`;
  }

  /** Map key mode and canonical-key text of key value v (an atom) of type t. */
  keyMode(t: number): string {
    return this.info(t).k === "int" ? '"i"' : '"s"';
  }
  /**
   * Canonical key of v; `nan` is the key text of a NaN (unique per insert:
   * `n<seq>`; "n" for lookups, which never match). null: unsupported.
   */
  canon(v: string, t: number, nan: string): string | null {
    const ti = this.info(t);
    switch (ti.k) {
      case "int":
      case "string":
        return v;
      case "float":
        return `R.KeyFloat<${v}, "${ti.fbits}", ${nan}>`;
      case "interface":
        return `R.IKey<P, ${v}, ${nan}>`;
      case "bool":
        return `Mp.KeyBool<${v}>`;
      case "pointer":
      case "chan":
        return `Mp.KeyPtr<${v}>`;
      case "struct":
      case "array": {
        const st = this.T.slotTypes(t);
        const parts = st.map((s, i) => {
          const k = this.info(s).k;
          const x = `${v}[${i}]`;
          if (k === "string") return `\${Mp.KeyStr<${x}>}`;
          if (k === "bool") return `\${Mp.KeyBool<${x}>}`;
          if (k === "pointer" || k === "chan") return `\${Mp.KeyPtr<${x}>}`;
          if (k === "int") return `\${${x} & string}`;
          if (k === "interface") return `\${R.IKey<P, ${x}, ${nan}> & string}`;
          if (k === "float")
            return `\${R.KeyFloat<${x}, "${this.info(s).fbits}", ${nan}> & string}`;
          return null;
        });
        if (parts.includes(null)) return null;
        return "`" + parts.join(",") + "`";
      }
      default:
        return null;
    }
  }

  // ------------------------------------------------------------ functions

  func(f: Func, fid: number): void {
    if (f.body !== "ir") return;
    if (this.o.keep && !this.o.keep.has(f.name)) return;
    cachedFE(this, f, fid).run();
  }

  funcEntry(fid: number): void {
    const f = this.prog.funcs[fid]!;
    const key = `f${encNat(fid)}`;
    const h = `this["h"], this["k"], this["x"], this["f"]`;
    let o: string;
    const trapped =
      f.body === "trap" || (f.body === "ir" && this.o.keep && !this.o.keep.has(f.name));
    if (trapped) {
      o = `R.Trap<this["h"], this["k"], this["x"], ${strLit(`trap: ${f.trap ?? "not kept (--keep)"} (in ${f.name})\n`)}>`;
    } else if (f.body === "intrinsic") {
      // dynamic call of an intrinsic: run it inline and return
      const args = Array.from({ length: f.params }, (_, i) => `this["a"][1][${i}]`);
      const ie = new FuncEmitter(this, f, fid);
      o = ie.intrinsicEntry(args);
    } else {
      const fe = cachedFE(this, f, fid);
      const ps = fe.blockParams(0);
      const args = ps.map((r) =>
        r === D_REG
          ? "null"
          : r < f.params
            ? `this["a"][1][${r}]`
            : r < f.params + f.freeVars
              ? `this["a"][2][${r - f.params}]`
              : "null",
      );
      o = `b${fid}_0<${[h, ...args].join(", ")}>`;
    }
    this.out.push(`interface e${key} extends EB { o: ${o} }`);
    this.entries.push(`${key}: e${key};`);
  }
}

function mname(m: string): string {
  return m.replace(/[^A-Za-z0-9_]/g, (c) => "$" + c.charCodeAt(0).toString(16));
}

function decNatInt(s: string): bigint {
  const HEX = "0123456789abcdef";
  let b = 0n;
  for (let i = s.length - 1; i >= 0; i--) b = (b << 4n) | BigInt(HEX.indexOf(s[i]!));
  return BigInt.asIntN(64, BigInt.asIntN(s.length * 4, b));
}

// ================================================================ functions

/** A value expression in a segment: text, and whether it is an atom (a name or literal). */
interface Val {
  t: string;
  atom: boolean;
}

class FuncEmitter {
  e: Emitter;
  f: Func;
  fid: number;
  hasD: boolean;
  rregs: number[];
  live: ReturnType<typeof liveness>;
  useCount: Map<number, number>;
  segs: Seg[] = [];
  callSite = 0;
  /** flattened instruction index of each block's first instruction */
  blockStart: number[] = [];

  constructor(e: Emitter, f: Func, fid: number) {
    this.e = e;
    this.f = f;
    this.fid = fid;
    this.hasD = f.blocks.some((b) =>
      b.instrs.some(
        (i) =>
          i.op === "defer" ||
          i.op === "runDefers" ||
          (i.op === "call" && "builtin" in i.callee && i.callee.builtin === "deferstack"),
      ),
    );
    this.rregs = [];
    if (f.body === "ir" && f.recover >= 0) {
      const l0 = liveness(f);
      this.rregs = [...l0.liveIn[f.recover]!].sort((a, b) => a - b);
    }
    this.live = f.body === "ir" ? liveness(f, this.rregs) : { liveIn: [], liveOut: [] };
    this.useCount = new Map();
    let pc = 0;
    for (const b of f.blocks) {
      this.blockStart.push(pc);
      pc += b.instrs.length;
    }
    for (const b of f.blocks)
      for (const ins of b.instrs) {
        if (ins.op === "phi") {
          for (const o of ins.edges) if ("r" in o) this.bump(o.r);
        } else for (const r of uses(ins)) this.bump(r);
      }
  }
  bump(r: number) {
    this.useCount.set(r, (this.useCount.get(r) ?? 0) + 1);
  }

  /**
   * A switch chain starting at block bi: bi and the blocks its "else"
   * edges reach each end in `v = x == const; if v` on the same register x
   * (the later ones hold nothing else and have one predecessor). Emitted as
   * one table dispatch (SegB.switchOp). null below SWITCH_MIN cases.
   */
  switchAt(bi: number): SwitchChain | null {
    const f = this.f;
    const tail = (b: number, whole: boolean): { x: number; key: Operand } | null => {
      const ins = f.blocks[b]!.instrs;
      if (ins.length < 2 || (whole && ins.length !== 2)) return null;
      const c = ins[ins.length - 2]!;
      const t = ins[ins.length - 1]!;
      if (c.op !== "binop" || c.kind !== "==" || t.op !== "if") return null;
      if (!("r" in t.cond) || t.cond.r !== c.dst || this.useCount.get(c.dst) !== 1) return null;
      const [rx, k] =
        "r" in c.x && "c" in c.y
          ? [c.x.r, c.y]
          : "r" in c.y && "c" in c.x
            ? [c.y.r, c.x]
            : [-1, null];
      if (rx < 0 || !k) return null;
      const ti = this.e.info(f.regTypes[rx]!);
      if (ti.k !== "int" && ti.k !== "string") return null;
      return { x: rx, key: k };
    };
    const h = tail(bi, false);
    if (!h) return null;
    // not a head when the chain reaches bi from its predecessor
    const pb = f.blocks[bi]!.preds;
    if (pb.length === 1 && f.blocks[pb[0]!]!.succs[1] === bi && f.blocks[bi]!.instrs.length === 2) {
      const pt = tail(pb[0]!, false);
      if (pt && pt.x === h.x) return null;
    }
    const cases: { key: string; blk: number }[] = [];
    const seen = new Set<string>();
    let b = bi;
    let cur: { x: number; key: Operand } | null = h;
    const sb0 = { constText: (c: any, t: number) => constTextOf(this.e, c, t) };
    while (cur && cur.x === h.x) {
      const key = sb0.constText((cur.key as any).c, (cur.key as any).t);
      if (!seen.has(key)) cases.push({ key, blk: b });
      seen.add(key);
      const nx = f.blocks[b]!.succs[1]!;
      if (nx === bi || f.blocks[nx]!.preds.length !== 1 || cases.length > 4096) break;
      const t2 = tail(nx, true);
      if (!t2 || t2.x !== h.x) break;
      b = nx;
      cur = t2;
    }
    if (cases.length < SWITCH_MIN) return null;
    return { x: h.x, cases, last: b };
  }

  /** Ordered parameters (registers) of a set: D, recover registers, then the rest ascending. */
  order(s: Iterable<number>): number[] {
    const set = new Set(s);
    const r: number[] = [];
    if (this.hasD) r.push(D_REG);
    for (const x of this.rregs) r.push(x);
    const rest = [...set]
      .filter((x) => x !== D_REG && !this.rregs.includes(x))
      .sort((a, b) => a - b);
    return [...r, ...rest];
  }
  blockParams(b: number): number[] {
    return this.order(this.live.liveIn[b]!);
  }

  run(): void {
    const f = this.f;
    f.blocks.forEach((b, bi) => this.block(b, bi));
    if (f.recover >= 0) {
      // recover entry: a = [null, Regs, null]; Regs starts with the recover registers
      const ps = this.blockParams(f.recover);
      const args = ps.map((r) => {
        if (r === D_REG) return "null";
        const i = this.rregs.indexOf(r);
        return i >= 0 ? `this["a"][1][${i}]` : "null";
      });
      this.entry(`r${this.fid}`, `b${this.fid}_${f.recover}`, args, {
        kind: "recover",
        block: f.recover,
        pc: this.blockStart[f.recover]!,
        regs: this.rregs,
        hasD: false,
      });
    }
    for (const s of this.segs)
      this.e.out.push(
        `type ${s.name}<${["H", "K", "X", "F", ...s.params].join(", ")}> = ${s.body};`,
      );
  }

  entry(
    key: string,
    target: string,
    args: string[],
    info: Omit<EntryInfo, "key" | "fid" | "hasD"> & { hasD?: boolean },
  ): void {
    this.e.entryTable.push({
      key,
      fid: this.fid,
      ...info,
      hasD: info.hasD ?? info.regs.includes(D_REG),
    });
    const h = `this["h"], this["k"], this["x"], this["f"]`;
    this.e.out.push(`interface e${key} extends EB { o: ${target}<${[h, ...args].join(", ")}> }`);
    this.e.entries.push(`${key}: e${key};`);
  }

  regName(r: number): string {
    return r === D_REG ? "D" : `r${r}`;
  }

  // ------------------------------------------------------------ blocks

  block(b: Block, bi: number): void {
    this.e.blockCount++;
    const name = `b${this.fid}_${bi}`;
    const params = this.blockParams(bi);
    const sb = new SegB(
      this,
      name,
      params.map((r) => this.regName(r)),
    );
    for (const r of params) sb.env.set(r, { t: this.regName(r), atom: true });
    // per-instruction liveness: live after instruction i
    const liveAfter: Set<number>[] = new Array(b.instrs.length);
    let cur = new Set<number>(this.live.liveOut[bi]);
    // phi edge uses at the end
    b.succs.forEach((to, si) => {
      const ei = edgeIndex(this.f, bi, si);
      for (const ins of this.f.blocks[to]!.instrs) {
        if (ins.op !== "phi") break;
        const o = ins.edges[ei]!;
        if ("r" in o) cur.add(o.r);
      }
    });
    const liveBefore: Set<number>[] = new Array(b.instrs.length);
    for (let i = b.instrs.length - 1; i >= 0; i--) {
      liveAfter[i] = new Set(cur);
      const ins = b.instrs[i]!;
      const d = def(ins);
      if (d >= 0) cur.delete(d);
      if (ins.op !== "phi") for (const r of uses(ins)) cur.add(r);
      liveBefore[i] = new Set(cur);
    }
    sb.liveAfter = liveAfter;
    sb.liveBefore = liveBefore;
    sb.Fv = "F2";
    sb.fuelPt = {
      name,
      yieldA: `[${params.map((r) => this.regName(r)).join(", ")}]`,
      entryArgs: params.map((_, i) => `this["a"][${i}]`),
      info: { kind: "block", block: bi, pc: this.blockStart[bi]!, regs: params },
    };
    for (let i = 0; i < b.instrs.length; i++) {
      const ins = b.instrs[i]!;
      sb.idx = i;
      sb.bi = bi;
      if (ins.op === "phi") continue;
      sb.instr(ins, b, bi);
      if (sb.done) break;
      if (sb.skipNext) {
        sb.skipNext = false;
        i++;
      }
    }
    if (!sb.done) throw new Error(`block without terminator in ${this.f.name}`);
  }

  // ------------------------------------------------------------ intrinsics as entries

  /** The `o` of a dynamic entry of an intrinsic: run inline then return. */
  intrinsicEntry(args: string[]): string {
    const sb = new SegB(this, "", []);
    sb.H = `this["h"]`;
    sb.K = `this["k"]`;
    sb.X = `this["x"]`;
    sb.Fv = `this["f"]`;
    sb.entryMode = true;
    const vals = args.map((a) => ({ t: a, atom: true }));
    const r = sb.intrinsic(this.f.intrinsic ?? this.f.name, vals, this.f);
    if (r === null) return sb.wrapAll(sb.tailRet("null"));
    return sb.wrapAll(sb.tailRet(r));
  }
}

/**
 * A tuple literal. tsrs defers a tuple literal in an alias when an element
 * names a type alias (H4): its elements are resolved only when read, under
 * the mapper of the segment that built it. Values that outlive a step (call
 * arguments, saved registers, defer records, results) must not be such
 * tuples, so those are built with `R.TPush` (a constructor) instead.
 */
export function tup(els: string[]): string {
  if (els.every((e) => !ALIAS_REF.test(e))) return `[${els.join(", ")}]`;
  return els.reduce((acc, e) => `R.TPush<${acc}, ${e}>`, "[]");
}
/** Text that may name a type alias: a generic reference or a zero-value alias. */
const ALIAS_REF = /[A-Za-z_$][\w$]*\s*<|\bZO?\d+\b/;

/** Aggregates with more slots have no zero value in types. */
const BIG_SLOTS = 1 << 16;
const BARE = "F extends string ? ";

/** Builds one block's segments. */
class SegB {
  fe: FuncEmitter;
  e: Emitter;
  name: string;
  params: string[];
  pre: string[] = [];
  post: string[] = [];
  binds = 0;
  heapNest = 0;
  env = new Map<number, Val>();
  H = "H";
  K = "K";
  X = "X";
  Fv = "F";
  tmp = 0;
  done = false;
  idx = 0;
  liveAfter: Set<number>[] = [];
  liveBefore: Set<number>[] = [];
  entryMode = false;
  /** First segment of the block (its body gets the fuel check). */
  first: { name: string; params: string[] } | null = null;
  segIndex = 0;

  constructor(fe: FuncEmitter, name: string, params: string[]) {
    this.fe = fe;
    this.e = fe.e;
    this.name = name;
    this.params = params;
  }

  /** The "hash of unhashable type" checks of a key holding interfaces. */
  keyCk(k: string, t: number): void {
    const ti = this.e.info(t);
    const ck = (x: string) => this.check(`R.KeyOk<R.IKey<P, ${x}, "n">>`, (r) => this.pnH(r));
    if (ti.k === "interface") ck(k);
    else if (ti.k === "struct" || ti.k === "array")
      this.e.T.slotTypes(t).forEach((s, i) => {
        if (this.e.info(s).k === "interface") ck(`${k}[${i}]`);
      });
  }

  keyTrap(t: number): void {
    this.end(
      `R.Trap<${this.H}, ${this.K}, ${this.X}, ${strLit(`trap: map keys of kind ${this.e.info(t).k} are not supported in types (in ${this.fe.f.name})\n`)}>`,
    );
  }

  /**
   * Extra weight of ops that build or walk aggregate values: about
   * n (40 + 4 n) for n < 32 slots (heap.ts LoadK/StoreK slot by slot), and
   * 70 n past that (the bulk paths: whole leaves and subtrees).
   */
  aggCost(ins: Instr): number {
    const sl = (t: number) => (t >= 0 && this.e.info(t).agg ? this.e.info(t).slots : 0);
    const w = (n: number) => (n < 32 ? n * (40 + 4 * n) : 300 + 70 * n);
    switch (ins.op) {
      case "load":
      case "lookup":
        return w(sl(this.fe.f.regTypes[ins.dst]!));
      case "store":
        return w(sl(this.typeOf(ins.val)));
      case "mapUpdate":
        return w(sl(this.typeOf(ins.val))) + w(sl(this.typeOf(ins.key)));
      case "makeInterface":
        return w(sl(this.typeOf(ins.x)));
      default:
        return 0;
    }
  }

  isChacha(ins: Instr): boolean {
    if (ins.op !== "call" || !("static" in ins.callee)) return false;
    const g = this.e.prog.funcs[ins.callee.static]!;
    return g.body === "intrinsic" && (g.intrinsic ?? g.name) === "internal/chacha8rand.block";
  }

  /** Names (and pointer expressions) known non-nil: checked, or fresh / derived addresses. */
  nonNil = new Set<string>();
  /** Whether a check is known to pass (and records what a passing check proves). */
  statically(ck: string): boolean {
    const nil = /^Hp\.NilCk<(.*)>$/.exec(ck);
    if (nil) {
      const x = nil[1]!;
      if (this.nonNil.has(x) || NONNIL.test(x)) return true;
      // only names: an expression's text (H, ...) means another value in a later segment
      if (/^[A-Za-z_]\w*$/.test(x)) this.nonNil.add(x);
      return false;
    }
    const ix = /^Hp\.IndexCk<"([0-9a-f]+)", "([0-9a-f]+)">$/.exec(ck);
    if (ix) {
      const i = decNat(ix[1]!);
      return i >= 0n && i < decNat(ix[2]!);
    }
    return false;
  }

  fresh(): string {
    return `v${this.tmp++}`;
  }

  // ---- values

  val(o: Operand): Val {
    if ("r" in o) {
      const v = this.env.get(o.r);
      if (!v) throw new Error(`r${o.r} undefined in ${this.fe.f.name} (${this.name})`);
      return v;
    }
    if ("c" in o) return { t: this.constText(o.c, o.t), atom: true };
    if ("zero" in o) return { t: this.e.zero(o.zero), atom: true };
    if ("g" in o) return { t: `[${strLit(this.e.gids[o.g]!)}, "0"]`, atom: true };
    return { t: `[${n2(o.f)}, []]`, atom: true };
  }
  constText(c: any, t: number): string {
    return constTextOf(this.e, c, t);
  }
  /**
   * A switch chain as one dispatch: look up x's value in a table of case
   * entries (each an interface whose `o` jumps to its case with the edge
   * moves), with the live values passed as `a`; the default jumps on.
   */
  switchOp(sw: SwitchChain): void {
    const fe = this.fe;
    const x = this.atom({ r: sw.x });
    // every value a target may need, as A
    const live = this.liveBefore[this.idx] ?? new Set<number>();
    const regs = [...this.env.keys()].filter((r) => r === D_REG || live.has(r));
    const avals = regs.map((r) => this.forceAtomText(this.env.get(r)!));
    const saved = { env: this.env, H: this.H, K: this.K, X: this.X, F: this.Fv };
    const def = this.jumpTo(sw.last, 1);
    this.env = new Map(regs.map((r, i) => [r, { t: `this["a"][${i}]`, atom: true }]));
    this.H = 'this["h"]';
    this.K = 'this["k"]';
    this.X = 'this["x"]';
    this.Fv = 'this["f"]';
    const tab = `SW${fe.fid}_${sw.cases[0]!.blk}`;
    const props: string[] = [];
    // each case is an entry `s<fid>_<blk>` (the dispatch goes through the
    // trampoline: an entry evaluated in a segment's tail would nest, not loop)
    const fpc = fe.blockStart;
    sw.cases.forEach((c) => {
      const key = `s${fe.fid}_${c.blk}`;
      const n = fe.f.blocks[c.blk]!.instrs.length;
      this.e.entryTable.push({
        key,
        fid: fe.fid,
        kind: "switch",
        block: c.blk,
        pc: fpc[c.blk]! + n - 2,
        regs,
        hasD: regs.includes(D_REG),
      });
      this.e.out.push(`interface e${key} extends EB { o: ${this.jumpTo(c.blk, 0)} }`);
      this.e.entries.push(`${key}: e${key};`);
      props.push(`${c.key}: "${key}";`);
    });
    this.env = saved.env;
    this.H = saved.H;
    this.K = saved.K;
    this.X = saved.X;
    this.Fv = saved.F;
    this.e.out.push(`interface ${tab} { ${props.join(" ")} }`);
    this.end(
      `${x} extends keyof ${tab} ? R.Y<${tab}[${x}], ${this.H}, ${this.K}, ${this.X}, ${tup(avals)}, ${this.Fv}> : ${def}`,
    );
  }
  /** An operand as an atom (binding its expression if needed). */
  atom(o: Operand): string {
    const v = this.val(o);
    if (v.atom) return v.t;
    const nm = this.bind(v.t);
    if ("r" in o) this.env.set(o.r, { t: nm, atom: true });
    return nm;
  }
  /** Binds an expression to a fresh name (cuts first when out of bindings). */
  bind(expr: string): string {
    const nm = this.fresh();
    if (NONNIL.test(expr)) this.nonNil.add(nm);
    this.pre.push(`${ckParen(expr)} extends infer ${nm} ? `);
    this.post.push(` : never`);
    this.binds++;
    return nm;
  }
  /** Defines register r as an expression (inlined at its single use, else bound). */
  setReg(r: number, expr: string, opts: { atom?: boolean; mustBind?: boolean } = {}) {
    if (opts.atom) {
      this.env.set(r, { t: expr, atom: true });
      return;
    }
    const uses = this.fe.useCount.get(r) ?? 0;
    if (uses === 0) return; // dead value (pure)
    if (uses === 1 && !opts.mustBind) {
      this.env.set(r, { t: expr, atom: false });
      return;
    }
    this.env.set(r, { t: this.bind(expr), atom: true });
  }
  /** H as an atom-ish expression usable by a reader: cut if it is a pending write chain. */
  heapRead(): string {
    if (this.heapNest > 0)
      throw new Error(`heap read after a write in one segment (${this.fe.f.name})`);
    return this.H;
  }
  heapWrite(f: (h: string) => string) {
    this.H = f(this.H);
    this.heapNest++;
  }
  /** A runtime check: `Ck extends true ? <rest> : <panic from Ck>`. */
  check(ck: string, panic: (r: string) => string) {
    if (this.statically(ck)) return;
    this.pre.push(`${ckParen(ck)} extends true ? `);
    this.post.push(` : ${panic(ck)}`);
  }

  // ---- panics

  /** Frame info of the running frame for a panic: [Key, Regs, D, Fid]. */
  frame(): string {
    const fe = this.fe;
    const regs = fe.rregs.map((r) => {
      const v = this.env.get(r);
      return v ? this.forceAtomText(v) : "null";
    });
    const d = fe.hasD ? this.dText() : "null";
    return tup(['""', tup(regs), d, n2(fe.fid)]);
  }
  dText(): string {
    const v = this.env.get(D_REG);
    return v ? v.t : "null";
  }
  forceAtomText(v: Val): string {
    return v.t;
  }
  /** The state of a panic with interface value text V. */
  panicState(v: string): string {
    return `R.Pc<${this.H}, ${this.K}, ${this.X}, ${this.Fv}, ${v}, ${this.frame()}>`;
  }
  /** Panic from an int.ts/str.ts `["panic", M]` (runtime.errorString). */
  pnI(r: string): string {
    return this.panicState(`[${this.e.ES}, ${r}[1]]`);
  }
  pnIPlain(r: string): string {
    return this.panicState(`[${this.e.PE}, ${r}[1]]`);
  }
  /** Panic from a heap.ts `Panic<K, M>`. */
  pnH(r: string): string {
    // short forms (size): the frame has no recover registers
    if (this.fe.rregs.length === 0) {
      const d = this.fe.hasD ? this.dText() : "null";
      const tail = `${this.H}, ${this.K}, ${this.X}, ${this.Fv}`;
      if (r.startsWith("Hp.NilCk<")) return `PN<${tail}, ${d}, ${n2(this.fe.fid)}>`;
      return `PH<${tail}, ${r}, ${d}, ${n2(this.fe.fid)}>`;
    }
    return this.panicState(`R.HPanicV<${r}, ${this.e.ES}, ${this.e.PE}>`);
  }
  rtErr(msg: string): string {
    return this.panicState(`[${this.e.ES}, ${strLit(msg)}]`);
  }

  // ---- segment management

  /** Wraps the tail expression with the pending conditionals. */
  wrapAll(tail: string): string {
    return this.pre.join("") + tail + [...this.post].reverse().join("");
  }

  /** Registers live after the current instruction, in order. */
  liveNow(extra: number[] = [], before = false): number[] {
    const s = new Set((before ? this.liveBefore : this.liveAfter)[this.idx] ?? []);
    for (const x of extra) s.add(x);
    if (this.fe.hasD) s.add(D_REG);
    for (const r of this.fe.rregs) s.add(r);
    // only registers already defined (in env)
    return this.fe.order([...s].filter((r) => this.env.has(r) || r === D_REG));
  }

  /** Ends the current segment with a hop to a new one carrying the live values. */
  cut(): void {
    const regs = this.liveNow([], true).filter((r) => this.env.has(r));
    const nm = `${this.name}_${++this.segIndex}`;
    const args = regs.map((r) => this.env.get(r)!.t);
    const tail = `${nm}<${[this.H, this.K, this.X, this.Fv, ...args].join(", ")}>`;
    this.finishSeg(tail);
    // start the next segment
    this.curName = nm;
    this.params = regs.map((r) => this.fe.regName(r));
    this.resetSeg();
    this.env = new Map();
    for (const r of regs) this.env.set(r, { t: this.fe.regName(r), atom: true });
    if (this.gCost >= GROUP_COST || this.gSegs >= GROUP_SEGS) {
      // a fuel point inside the block: also a resumable entry
      this.patchGroup();
      this.fuelPt = {
        name: nm,
        yieldA: `[${this.params.join(", ")}]`,
        entryArgs: this.params.map((_, i) => `this["a"][${i}]`),
        info: {
          kind: "mid",
          block: this.bi,
          pc: this.fe.blockStart[this.bi]! + this.idx,
          regs: regs,
        },
      };
      this.Fv = "F2";
    } else this.gSegs++;
  }
  curName: string | undefined;
  skipNext = false;
  /** The fuel point of the current group (its first segment checks fuel for the group). */
  fuelPt: {
    name: string;
    yieldA: string;
    entryArgs: string[] | null;
    info?: Omit<EntryInfo, "key" | "fid" | "hasD">;
  } | null = null;
  bi = 0;
  gCost = 0;
  gSegs = 1;

  resetSeg(): void {
    this.pre = [];
    this.post = [];
    this.binds = 0;
    this.heapNest = 0;
    this.H = "H";
    this.K = "K";
    this.X = "X";
    this.Fv = "F";
  }

  /** Records the current segment with the given tail. */
  finishSeg(tail: string): void {
    const nm = this.curName ?? this.name;
    // A bare alias reference is not a tail call (only conditionals loop):
    // make it one, or a chain of such segments nests 100 deep.
    const body = this.pre.length === 0 ? `${BARE}${tail} : never` : this.wrapAll(tail);
    this.fe.segs.push({ name: nm, params: this.params, body });
    this.e.segCount++;
  }

  /** Puts the fuel check (the group's weight) into the group's first segment. */
  patchGroup(): void {
    const fp = this.fuelPt;
    if (!fp) return;
    const w = Math.min(MAX_W, Math.max(this.gSegs, Math.ceil(this.gCost / UNIT)));
    const seg = this.fe.segs.find((s) => s.name === fp.name)!;
    if (seg.body.startsWith(BARE)) seg.body = seg.body.slice(BARE.length, -" : never".length);
    seg.body = `F extends \`${"x".repeat(w)}\${infer F2}\` ? ${seg.body} : R.Y<"${fp.name}", H, K, X, ${fp.yieldA}, "">`;
    if (fp.entryArgs) this.fe.entry(fp.name, fp.name, fp.entryArgs, fp.info!);
    this.fuelPt = null;
    this.gCost = 0;
    this.gSegs = 1;
  }

  /** Ends the block with a tail; patches the fuel check of the last group. */
  end(tail: string): void {
    this.finishSeg(tail);
    this.done = true;
    this.patchGroup();
  }

  // ---- terminators

  /** A jump to block `to` along successor edge si of block bi. */
  jumpTo(bi: number, si: number): string {
    const fe = this.fe;
    const to = fe.f.blocks[bi]!.succs[si]!;
    const ei = edgeIndex(fe.f, bi, si);
    const phis = new Map<number, Operand>();
    for (const ins of fe.f.blocks[to]!.instrs) {
      if (ins.op !== "phi") break;
      phis.set(ins.dst, ins.edges[ei]!);
    }
    const ps = fe.blockParams(to);
    const args = ps.map((r) => {
      if (r === D_REG) return this.dText();
      const ph = phis.get(r);
      if (ph) return this.val(ph).t;
      const v = this.env.get(r);
      if (!v) throw new Error(`jump: r${r} not available in ${fe.f.name} b${bi}->b${to}`);
      return v.t;
    });
    return `b${fe.fid}_${to}<${[this.H, this.K, this.X, this.Fv, ...args].join(", ")}>`;
  }

  tailRet(v: string): string {
    return `R.Rt<${this.H}, ${this.K}, ${this.X}, ${this.Fv}, ${v}>`;
  }

  /** Continuation text for a call at the current point; the resume segment is started. */
  callCont(
    dst: number | undefined,
    extraLive: number[] = [],
  ): { cont: string; resume: string; live: number[] } {
    const fe = this.fe;
    const key = `c${fe.fid}_${fe.callSite++}`;
    const live = this.liveNow(extraLive).filter((r) => r !== dst && r !== D_REG && this.env.has(r));
    const regsT = tup(live.map((r) => this.env.get(r)!.t));
    const cont = `R.Ct<"n", "${key}", ${regsT}, ${fe.hasD ? this.dText() : "null"}, ${n2(fe.fid)}, "">`;
    return { cont, resume: key, live };
  }

  /** Starts the resume segment after a call (name = key): params D?, dst?, live regs. */
  startResume(key: string, dst: number | undefined, live: number[]): void {
    const fe = this.fe;
    const params: string[] = [];
    const args: string[] = [];
    this.env = new Map();
    if (fe.hasD) {
      params.push("D");
      args.push(`this["a"][2]`);
      this.env.set(D_REG, { t: "D", atom: true });
    }
    const dn = dst !== undefined && (fe.useCount.get(dst) ?? 0) > 0;
    if (dn) {
      params.push(fe.regName(dst!));
      args.push(`this["a"][0]`);
      this.env.set(dst!, { t: fe.regName(dst!), atom: true });
    } else {
      // the result slot is still passed (ignored)
    }
    live.forEach((r, i) => {
      params.push(fe.regName(r));
      args.push(`this["a"][1][${i}]`);
      this.env.set(r, { t: fe.regName(r), atom: true });
    });
    fe.entry(key, key, args, {
      kind: "call",
      block: this.bi,
      pc: fe.blockStart[this.bi]! + this.idx,
      regs: live,
      hasD: fe.hasD,
      dst: dn ? dst! : -1,
    });
    this.patchGroup();
    this.curName = key;
    this.params = params;
    this.resetSeg();
    const dv = dn ? fe.regName(dst!) : "null";
    const lv = live.map((r) => fe.regName(r));
    this.fuelPt = {
      name: key,
      yieldA: `[${dv}, [${lv.join(", ")}], ${fe.hasD ? "D" : "null"}]`,
      entryArgs: null,
    };
    this.Fv = "F2";
  }

  // ---- instructions

  instr(ins: Instr, b: Block, bi: number): void {
    const e = this.e;
    const T = e.T;
    this.gCost += opCost(ins) + (this.isChacha(ins) ? CHACHA_COST : 0) + this.aggCost(ins);
    if (
      this.binds >= 2 ||
      this.heapNest >= MAX_HEAP_NEST ||
      (this.heapNest > 0 && readsHeap(ins, e))
    )
      this.cut();
    switch (ins.op) {
      case "jump":
        return this.end(this.jumpTo(bi, 0));
      case "if": {
        const c = this.atom(ins.cond);
        const th = this.jumpTo(bi, 0);
        const el = this.jumpTo(bi, 1);
        return this.end(`${ckParen(c)} extends true ? ${th} : ${el}`);
      }
      case "return": {
        const rs = ins.results.map((o) => this.val(o).t);
        const v = rs.length === 0 ? "null" : rs.length === 1 ? rs[0]! : tup(rs);
        return this.end(this.tailRet(v));
      }
      case "panic": {
        const v = this.val(ins.x).t;
        if (e.PNE) {
          const a = this.atomV(v);
          return this.end(
            `${a} extends null ? ${this.panicState(`[${e.PNE}, ["00000", "0"]]`)} : ${this.panicState(a)}`,
          );
        }
        return this.end(this.panicState(v));
      }
      case "trap":
        return this.end(
          `R.Trap<${this.H}, ${this.K}, ${this.X}, ${strLit(`trap: ${ins.what} (in ${this.fe.f.name})\n`)}>`,
        );
      case "alloc": {
        const n = this.e.slots(ins.elem);
        if (n === 0) return this.setReg(ins.dst, `["00000", "0"]`, { atom: true });
        const h = this.heapRead();
        this.setReg(ins.dst, `Hp.PtrMk<Hp.NextId<${h}>, "0">`, { mustBind: true });
        if (n <= 16) this.heapWrite((h) => `Hp.Alloc<${h}, ${this.e.zeroObj(ins.elem)}>`);
        else this.heapWrite((h) => `Hp.AllocLazy<${h}, ${n2(n)}, ${this.e.zpat(ins.elem)}>`);
        return;
      }
      case "load": {
        const nx = b.instrs[this.idx + 1];
        const n = this.e.slots(ins.t);
        if (
          n > 16 &&
          nx?.op === "store" &&
          "r" in nx.val &&
          nx.val.r === ins.dst &&
          (this.fe.useCount.get(ins.dst) ?? 0) === 1
        ) {
          // *q = *p for a big aggregate: heap to heap, not through a register
          const src = this.ptrAtom(ins.ptr);
          const dstp = this.ptrAtom(nx.ptr);
          this.heapWrite(
            (h) => `R.CopyAgg<${h}, ${dstp}, ${src}, ${n2(n)}, ${this.e.zpat(ins.t)}>`,
          );
          this.skipNext = true;
          return;
        }
        const p = this.ptrAtom(ins.ptr);
        const h = this.heapRead();
        const t = ins.t;
        if (this.e.info(t).agg) this.setReg(ins.dst, `Hp.LoadK<${h}, ${p}, ${this.e.zero(t)}>`);
        else if (this.e.slots(t) === 1)
          this.setReg(ins.dst, `Hp.Load1<${h}, ${p}, ${this.e.scalarZero(t)}>`);
        else this.setReg(ins.dst, `[]`, { atom: true });
        return;
      }
      case "store": {
        const et = this.ptrElem(ins.ptr);
        const p = this.ptrAtom(ins.ptr);
        if (this.e.slots(et) === 0) return;
        const v = this.val(ins.val).t;
        if (this.e.info(et).agg) this.heapWrite((h) => `Hp.StoreK<${h}, ${p}, ${v}>`);
        else this.heapWrite((h) => `Hp.Store1<${h}, ${p}, ${v}>`);
        return;
      }
      case "fieldAddr": {
        const st = T.info[this.ptrElem(ins.x)]!.u as any;
        const off = st.fields[ins.field].offset as number;
        const p = this.ptrAtom(ins.x);
        if (off === 0) return this.setReg(ins.dst, p, { atom: true });
        this.setReg(ins.dst, `Hp.FieldAddr<${p}, ${n2(off)}>`);
        return;
      }
      case "field": {
        const st = T.info[this.typeOf(ins.x)]!.u as any;
        const fd = st.fields[ins.field];
        const off = fd.offset as number;
        const x = this.atom(ins.x);
        const n = this.e.slots(fd.type);
        if (this.e.info(fd.type).agg) {
          const els = Array.from({ length: n }, (_, i) => `${x}[${off + i}]`);
          this.setReg(ins.dst, `[${els.join(", ")}]`);
        } else this.setReg(ins.dst, `${x}[${off}]`);
        return;
      }
      case "indexAddr": {
        const xt = this.under(ins.x);
        const i = this.indexAtom(ins.index);
        if (xt.k === "slice") {
          const s = this.atom(ins.x);
          const es = this.e.slots(xt.elem);
          this.check(`Hp.IndexCk<${i}, Hp.Len<${s}>>`, (r) => this.pnH(r));
          this.setReg(ins.dst, `Hp.SliceIndexAddr<${s}, ${i}, ${n2(es)}>`);
          return;
        }
        const at = T.info[this.ptrElem(ins.x)]!.u as any;
        const es = this.e.slots(at.elem);
        const p = this.ptrAtom(ins.x);
        this.check(`Hp.IndexCk<${i}, ${n2(at.len)}>`, (r) => this.pnH(r));
        if (es === 0) return this.setReg(ins.dst, p, { atom: true });
        this.setReg(ins.dst, `Hp.ArrayIndexAddr<${p}, ${i}, ${n2(es)}>`);
        return;
      }
      case "index": {
        const xt = T.info[this.typeOf(ins.x)]!.u as any;
        if (xt.k === "string") {
          const s = this.atom(ins.x);
          const it = this.typeOf(ins.index);
          const i = this.atom(ins.index);
          const r = this.bind(`Sr.Index<${s}, ${i}, "${this.e.kindW(it)}">`);
          this.check(`R.NotP<${r}>`, () => this.pnI(r));
          this.setReg(ins.dst, r, { atom: true });
          return;
        }
        const i = this.indexAtom(ins.index);
        const a = this.atom(ins.x);
        const es = this.e.slots(xt.elem);
        this.check(`Hp.IndexCk<${i}, ${n2(xt.len)}>`, (r) => this.pnH(r));
        if (this.e.info(xt.elem).agg)
          this.setReg(ins.dst, `Hp.AggIndexK<${a}, ${i}, ${n2(es)}, ${this.e.zero(xt.elem)}>`);
        else this.setReg(ins.dst, `Hp.AggIndex1<${a}, ${i}>`);
        return;
      }
      case "binop":
        if (this.idx === b.instrs.length - 2) {
          const sw = this.fe.switchAt(bi);
          if (sw) return this.switchOp(sw);
        }
        return this.binop(ins);
      case "unop": {
        const x = this.val(ins.x).t;
        if (ins.kind === "!") return this.setReg(ins.dst, `R.Not<${x}>`);
        const w = this.e.kindW(ins.t);
        if (ins.kind === "-") return this.setReg(ins.dst, `I.Neg<"${w}", ${x}>`);
        return this.setReg(ins.dst, `I.Not<"${w}", ${x}>`);
      }
      case "convert":
        return this.convert(ins);
      case "changeType":
      case "changeInterface": {
        const v = this.val(ins.x);
        if (v.atom) return this.setReg(ins.dst, v.t, { atom: true });
        return this.setReg(ins.dst, v.t);
      }
      case "makeSlice": {
        const et = (T.info[ins.t]!.u as any).elem as number;
        const l = this.indexAtom(ins.len);
        const c = this.indexAtom(ins.cap);
        this.check(`Hp.MakeSliceCk<${l}, ${c}>`, (r) => this.pnH(r));
        const h = this.heapRead();
        this.setReg(ins.dst, `Hp.MakeSliceV<${h}, ${l}, ${c}>`, { mustBind: true });
        const es = this.e.slots(et);
        this.heapWrite((h) => `Hp.MakeSlice<${h}, ${c}, ${n2(es)}, ${this.e.zslots(et)}>`);
        return;
      }
      case "slice":
        return this.sliceOp(ins);
      case "sliceToArrayPtr": {
        const at = T.info[(T.info[ins.t]!.u as any).elem]!.u as any;
        const s = this.atom(ins.x);
        this.check(`R.SliceLenCk<${s}, ${n2(at.len)}>`, (r) => this.pnI(r));
        this.setReg(ins.dst, `R.SliceToPtr<${s}>`);
        return;
      }
      case "makeMap": {
        const mt = T.info[ins.t]!.u as any;
        const h = this.heapRead();
        this.setReg(ins.dst, `Mp.MakeMapV<${h}>`, { mustBind: true });
        this.heapWrite((h) => `Mp.MakeMap<${h}, ${this.e.keyMode(mt.key)}>`);
        return;
      }
      case "lookup": {
        const mt = T.info[this.typeOf(ins.x)]!.u as any;
        if (mt.k === "string") throw new Error("lookup on string");
        const m = this.atom(ins.x);
        const k = this.atom(ins.index);
        const c = this.e.canon(k, mt.key, '"n"');
        if (c === null) return this.keyTrap(mt.key);
        this.keyCk(k, mt.key);
        const h = this.heapRead();
        const z = this.e.zero(mt.elem);
        if (ins.commaOk) this.setReg(ins.dst, `Mp.MapLookupOk<${h}, ${m}, ${c}, ${z}>`);
        else this.setReg(ins.dst, `Mp.MapLookup<${h}, ${m}, ${c}, ${z}>`);
        return;
      }
      case "mapUpdate": {
        const mt = T.info[this.typeOf(ins.map)]!.u as any;
        const m = this.atom(ins.map);
        const k = this.atom(ins.key);
        const v = this.val(ins.val).t;
        this.check(`Mp.MapUpdateCk<${m}>`, (r) => this.pnIPlain(r));
        if (this.e.canon(k, mt.key, '"n"') === null) return this.keyTrap(mt.key);
        this.keyCk(k, mt.key);
        this.heapWrite((h) => {
          const c = this.e.canon(k, mt.key, `\`n\${R.MapSeq<${h}, ${m}> & string}\``)!;
          return `Mp.MapUpdate<${h}, ${m}, ${c}, ${k}, ${v}>`;
        });
        return;
      }
      case "makeChan":
      case "send":
      case "recv":
        return this.end(
          `R.Trap<${this.H}, ${this.K}, ${this.X}, ${strLit(`trap: channels are not supported in types (in ${this.fe.f.name})\n`)}>`,
        );
      case "makeInterface": {
        const x = this.val(ins.x).t;
        return this.setReg(ins.dst, `Hp.MakeIface<${n2(ins.xt)}, ${x}>`);
      }
      case "typeAssert": {
        const x = this.atom(ins.x);
        const at = ins.assert;
        const isI = T.info[at]!.k === "interface";
        if (ins.commaOk) {
          if (isI) this.setReg(ins.dst, `Hp.AssertIOk<${x}, ${n2(at)}, P>`);
          else this.setReg(ins.dst, `Hp.AssertTOk<${x}, ${n2(at)}, ${this.e.zero(at)}>`);
          return;
        }
        const r = this.bind(
          isI
            ? `Hp.AssertI<${x}, ${n2(at)}, P>`
            : `Hp.AssertT<${x}, ${n2(at)}, ${n2(this.typeOf(ins.x))}, P>`,
        );
        this.check(`R.NotHP<${r}>`, () => this.pnH(r));
        this.setReg(ins.dst, r, { atom: true });
        return;
      }
      case "makeClosure": {
        const bs = ins.bindings.map((o) => this.val(o).t);
        return this.setReg(ins.dst, tup([n2(ins.fn), tup(bs)]));
      }
      case "call":
        return this.call(ins);
      case "extract": {
        const x = this.atom(ins.tuple);
        return this.setReg(ins.dst, `${x}[${ins.index}]`);
      }
      case "range": {
        const x = this.val(ins.x).t;
        return this.setReg(ins.dst, `[${x}, "0"]`, { mustBind: true });
      }
      case "next":
        return this.next(ins);
      case "defer":
        return this.deferOp(ins);
      case "runDefers": {
        // D null: nothing; else push a "d" continuation and return into it
        const d = this.dText();
        const { cont, resume, live } = this.runDefersCont();
        const tail = `${d} extends null ? ${resume}<${[this.H, this.K, this.X, this.Fv, ...this.resumeArgs(live, true)].join(", ")}> : R.Rt<${this.H}, R.Cons<${cont}, ${this.K}>, ${this.X}, ${this.Fv}, null>`;
        this.finishSeg(tail);
        this.startResume(resume, undefined, live);
        // in the resume segment D is null (all defers ran)
        return;
      }
      case "phi":
        return;
    }
    throw new Error(`emit: unknown op ${(ins as any).op}`);
  }

  runDefersCont(): { cont: string; resume: string; live: number[] } {
    const fe = this.fe;
    const key = `c${fe.fid}_${fe.callSite++}`;
    const live = this.liveNow().filter((r) => r !== D_REG && this.env.has(r));
    const regsT = tup(live.map((r) => this.env.get(r)!.t));
    const cont = `R.Ct<"d", "${key}", ${regsT}, ${this.dText()}, ${n2(fe.fid)}, "r">`;
    return { cont, resume: key, live };
  }
  /** Arguments of a direct hop into resume segment (D?, result null, live regs). */
  resumeArgs(live: number[], dnull: boolean): string[] {
    const a: string[] = [];
    if (this.fe.hasD) a.push(dnull ? "null" : this.dText());
    for (const r of live) a.push(this.env.get(r)!.t);
    return a;
  }

  atomV(t: string): string {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t) || t.startsWith('"') || t === "null") return t;
    return this.bind(t);
  }

  typeOf(o: Operand): number {
    if ("r" in o) return this.fe.f.regTypes[o.r]!;
    if ("c" in o) return o.t;
    if ("zero" in o) return o.zero;
    if ("g" in o) return -1;
    return -1;
  }
  under(o: Operand): any {
    if ("g" in o) return { k: "pointer", elem: this.e.prog.globals[o.g]!.type };
    return this.e.info(this.typeOf(o)).u;
  }
  ptrElem(o: Operand): number {
    if ("g" in o) return this.e.prog.globals[o.g]!.type;
    const u = this.e.info(this.typeOf(o)).u as any;
    return u.elem;
  }
  /** A pointer operand as an atom, nil-checked (globals are never nil). */
  ptrAtom(o: Operand): string {
    const p = this.atom(o);
    if ("g" in o) return p;
    this.check(`Hp.NilCk<${p}>`, (r) => this.pnH(r));
    return p;
  }
  /** An index/len operand as a signed int atom (unsigned narrower kinds zero-extended). */
  indexAtom(o: Operand): string {
    const t = this.typeOf(o);
    const w = this.e.kindW(t);
    const v = this.atom(o);
    if (w[0] === "u" && w !== "u64") return this.atomV(`I.ZExt<"${w}", ${v}>`);
    return v;
  }

  binop(ins: Extract<Instr, { op: "binop" }>): void {
    const e = this.e;
    const k = ins.kind;
    const cmp = ["==", "!=", "<", "<=", ">", ">="].includes(k);
    let ot = cmp ? this.typeOf(ins.x) : ins.t;
    if (cmp && (ot < 0 || (("c" in ins.x || "zero" in ins.x) && "r" in ins.y))) {
      const yt = this.typeOf(ins.y);
      if (yt >= 0) ot = yt;
    }
    const ti = ot >= 0 ? e.info(ot) : null;
    if (cmp) {
      if (k === "==" || k === "!=") {
        const neg = k === "!=";
        const kind = ti ? ti.k : "pointer";
        let ex: string;
        if (
          kind === "bool" ||
          kind === "int" ||
          kind === "string" ||
          kind === "pointer" ||
          kind === "chan" ||
          kind === "map" ||
          kind === "func" ||
          kind === "slice" ||
          kind === "opaque" ||
          kind === "float"
        ) {
          if (kind === "float") {
            const x = this.atom(ins.x);
            const y = this.atom(ins.y);
            ex = `Hp.Eq<${x}, ${y}, "f${ti!.fbits}", P>`;
          } else {
            const x = this.val(ins.x).t;
            const y = this.val(ins.y).t;
            return this.setReg(ins.dst, neg ? `R.Ne<${x}, ${y}>` : `R.Eq<${x}, ${y}>`);
          }
        } else {
          const x = this.atom(ins.x);
          const y = this.atom(ins.y);
          const eqk = this.eqKindText(ot);
          ex = `Hp.Eq<${x}, ${y}, ${eqk}, P>`;
        }
        const r = this.bind(ex);
        this.check(`R.NotHP<${r}>`, () => this.pnH(r));
        return this.setReg(ins.dst, neg ? `R.Not<${r}>` : r, { atom: !neg });
      }
      const x = this.val(ins.x).t;
      const y = this.val(ins.y).t;
      if (ti!.k === "string") {
        const op = (CMP_OP as Record<string, string>)[k]!;
        return this.setReg(ins.dst, `Sr.${op}<${x}, ${y}>`);
      }
      const w = e.kindW(ot);
      const op = (CMP_OP as Record<string, string>)[k]!;
      return this.setReg(ins.dst, `I.${op}<"${w}", ${x}, ${y}>`);
    }
    if (ti!.k === "string") {
      const x = this.val(ins.x).t;
      const y = this.val(ins.y).t;
      return this.setReg(ins.dst, `\`\${${x} & string}\${${y} & string}\``);
    }
    const w = e.kindW(ins.t);
    switch (k) {
      case "/":
      case "%": {
        const x = this.val(ins.x).t;
        const y = this.atom(ins.y);
        this.check(`R.NonZero<${y}>`, () => this.rtErr("integer divide by zero"));
        return this.setReg(ins.dst, `I.${k === "/" ? "Quo" : "Rem"}<"${w}", ${x}, ${y}>`);
      }
      case "<<":
      case ">>": {
        const yt = this.typeOf(ins.y);
        const cw = e.kindW(yt);
        const x = this.val(ins.x).t;
        const y = this.atom(ins.y);
        if (cw[0] === "i") this.check(`R.NotNeg<${y}>`, () => this.rtErr("negative shift amount"));
        return this.setReg(ins.dst, `I.${k === "<<" ? "Shl" : "Shr"}<"${w}", ${x}, "${cw}", ${y}>`);
      }
    }
    const op = (ARITH_OP as Record<string, string>)[k]!;
    const x = this.val(ins.x).t;
    const y = this.val(ins.y).t;
    return this.setReg(ins.dst, `I.${op}<"${w}", ${x}, ${y}>`);
  }

  eqKindText(t: number): string {
    const T = this.e.T;
    if (T.eq(t) === null) return `"unc"`;
    const one = (s: number): string => {
      const k = T.info[s]!;
      if (k.k === "float") return `"f${k.fbits}"`;
      if (k.k === "interface") return `"i"`;
      return `"="`;
    };
    if (T.info[t]!.agg) return `[${T.slotTypes(t).map(one).join(", ")}]`;
    return one(t);
  }

  convert(ins: Extract<Instr, { op: "convert" }>): void {
    const e = this.e;
    const from = this.typeOf(ins.x);
    const fi = e.info(from);
    const ti = e.info(ins.t);
    if ((fi.ik || fi.fbits) && (ti.ik || ti.fbits)) {
      const fw = e.kindW(from);
      const tw = e.kindW(ins.t);
      const x = this.val(ins.x).t;
      if (fw === tw) return this.setReg(ins.dst, x, { atom: this.val(ins.x).atom });
      return this.setReg(ins.dst, `I.Conv<"${fw}", "${tw}", ${x}>`);
    }
    if (fi.ik && ti.k === "string") {
      const fw = e.kindW(from);
      // unsigned narrow values are zero-extended first (uint8(200) is 200,
      // not the sign-extended -56); RuneStr handles any int
      const x =
        fw[0] === "u" && fw !== "u64"
          ? this.atomV(`I.ZExt<"${fw}", ${this.atom(ins.x)}>`)
          : this.atom(ins.x);
      return this.setReg(ins.dst, `Sr.RuneStr<${x}>`);
    }
    if (fi.k === "string" && ti.k === "slice") {
      const ek = e.info((ti.u as any).elem).ik;
      const s = this.atom(ins.x);
      const h = this.heapRead();
      if (ek === "uint8" || ek === "int8") {
        this.setReg(ins.dst, `Sr.StrToBytesV<${h}, ${s}>`, { mustBind: true });
        this.heapWrite((h) => `Sr.StrToBytes<${h}, ${s}>`);
      } else {
        this.setReg(ins.dst, `Sr.StrToRunesV<${h}, ${s}>`, { mustBind: true });
        this.heapWrite((h) => `Sr.StrToRunes<${h}, ${s}>`);
      }
      return;
    }
    if (fi.k === "slice" && ti.k === "string") {
      const ek = e.info((fi.u as any).elem).ik;
      const s = this.atom(ins.x);
      const h = this.heapRead();
      if (ek === "uint8" || ek === "int8") return this.setReg(ins.dst, `Sr.BytesToStr<${h}, ${s}>`);
      return this.setReg(ins.dst, `Sr.RunesToStr<${h}, ${s}>`);
    }
    if (fi.k === "slice" && ti.k === "array") {
      const n = (ti.u as any).len as number;
      const s = this.atom(ins.x);
      this.check(`R.SliceLenCk<${s}, ${n2(n)}>`, (r) => this.pnI(r));
      if (e.slots(ins.t) === 0) return this.setReg(ins.dst, "[]", { atom: true });
      const h = this.heapRead();
      return this.setReg(ins.dst, `Hp.LoadK<${h}, R.SliceToPtr<${s}>, ${e.zero(ins.t)}>`);
    }
    const v = this.val(ins.x);
    return this.setReg(ins.dst, v.t, { atom: v.atom });
  }

  sliceOp(ins: Extract<Instr, { op: "slice" }>): void {
    const e = this.e;
    const xu = this.under(ins.x);
    const x = this.atom(ins.x);
    const bound = (o: Operand | undefined) => (o ? this.indexAtom(o) : "null");
    if (xu.k === "string") {
      const lo = ins.low ? this.atom(ins.low) : "null";
      const hi = ins.high ? this.atom(ins.high) : "null";
      const kl = ins.low ? `"${e.kindW(this.typeOf(ins.low))}"` : `"i64"`;
      const kh = ins.high ? `"${e.kindW(this.typeOf(ins.high))}"` : `"i64"`;
      const r = this.bind(`Sr.Slice<${x}, ${lo}, ${hi}, ${kl}, ${kh}>`);
      this.check(`R.NotP<${r}>`, () => this.pnI(r));
      return this.setReg(ins.dst, r, { atom: true });
    }
    const lo = bound(ins.low);
    const hi = bound(ins.high);
    const mx = bound(ins.max);
    let ex: string;
    if (xu.k === "slice") ex = `Hp.SliceS<${x}, ${lo}, ${hi}, ${mx}, ${n2(e.slots(xu.elem))}>`;
    else {
      const at = e.info(this.ptrElem(ins.x)).u as any;
      ex = `Hp.SliceA<${x}, ${lo}, ${hi}, ${mx}, ${n2(e.slots(at.elem))}, ${n2(at.len)}>`;
    }
    const r = this.bind(ex);
    this.check(`R.NotHP<${r}>`, () => this.pnH(r));
    this.setReg(ins.dst, r, { atom: true });
  }

  next(ins: Extract<Instr, { op: "next" }>): void {
    const it = this.atom(ins.iter);
    const itReg = "r" in ins.iter ? ins.iter.r : -1;
    if (ins.isString) {
      const r = this.bind(`Sr.Next<${it}[0], ${it}[1]>`);
      this.setReg(ins.dst, r, { atom: true });
      if (itReg >= 0) this.env.set(itReg, { t: this.bind(`[${it}[0], ${r}[3]]`), atom: true });
      return;
    }
    const el = (this.e.info(ins.t).u as any).elems as number[];
    const h = this.heapRead();
    const r = this.bind(
      `Mp.MapNext<${h}, ${it}[0], ${it}[1], ${this.e.zero(el[1]!)}, ${this.e.zero(el[2]!)}>`,
    );
    this.setReg(ins.dst, r, { atom: true });
    if (itReg >= 0) this.env.set(itReg, { t: this.bind(`[${it}[0], ${r}[3]]`), atom: true });
  }

  // ---- calls

  call(ins: Extract<Instr, { op: "call" }>): void {
    const c = ins.callee;
    const e = this.e;
    if ("builtin" in c) return this.builtin(ins);
    if ("static" in c) {
      const g = e.prog.funcs[c.static]!;
      if (g.body === "intrinsic") {
        const args = ins.args.map((o) => this.val(o));
        const r = this.intrinsic(g.intrinsic ?? g.name, args, g);
        if (r !== null && ins.dst !== undefined) this.setReg(ins.dst, r);
        return;
      }
      const trapped = g.body === "trap" || (e.o.keep && !e.o.keep.has(g.name));
      if (trapped)
        return this.end(
          `R.Trap<${this.H}, ${this.K}, ${this.X}, ${strLit(`trap: ${g.trap ?? "not kept (--keep)"} (in ${g.name})\n`)}>`,
        );
      // direct jump into the callee's entry block
      const ge = new FuncEmitterLite(e, g, c.static);
      const ps = ge.blockParams0();
      const argv = ins.args.map((o) => this.val(o).t);
      const cargs = ps.map((r) => (r === D_REG ? "null" : r < argv.length ? argv[r]! : "null"));
      const { cont, resume, live } = this.callCont(ins.dst);
      const tail = `b${c.static}_0<${[this.H, `R.Cons<${cont}, ${this.K}>`, this.X, this.Fv, ...cargs].join(", ")}>`;
      this.finishSeg(tail);
      this.startResume(resume, ins.dst, live);
      return;
    }
    if ("value" in c) {
      const fv = this.atom(c.value);
      this.check(`Hp.NilCk<${fv}>`, (r) => this.pnH(r));
      const argv = ins.args.map((o) => this.val(o).t);
      const { cont, resume, live } = this.callCont(ins.dst);
      const tail = `R.Cl<${this.H}, R.Cons<${cont}, ${this.K}>, ${this.X}, ${this.Fv}, ${fv}[0], ${tup(argv)}, ${fv}[1]>`;
      this.finishSeg(tail);
      this.startResume(resume, ins.dst, live);
      return;
    }
    // invoke
    const rv = this.atom(c.invoke);
    this.check(`Hp.NilCk<${rv}>`, (r) => this.pnH(r));
    const argv = ins.args.map((o) => this.val(o).t);
    const tab = e.methodTabs.has(c.method) ? `Mt_${mname(c.method)}` : "{}";
    const { cont, resume, live } = this.callCont(ins.dst);
    const tail = `R.Cl<${this.H}, R.Cons<${cont}, ${this.K}>, ${this.X}, ${this.Fv}, R.Look<${tab}, ${rv}[0]>, ${tup([`${rv}[1]`, ...argv])}, []>`;
    this.finishSeg(tail);
    this.startResume(resume, ins.dst, live);
  }

  deferOp(ins: Extract<Instr, { op: "defer" }>): void {
    const c = ins.callee;
    const e = this.e;
    const argv = ins.args.map((o) => this.val(o).t);
    let rec: string;
    if ("static" in c) rec = tup([n2(c.static), tup(argv), "[]"]);
    else if ("value" in c) {
      const fv = this.atom(c.value);
      rec = `R.DeferVal<${fv}, ${tup(argv)}>`;
    } else if ("invoke" in c) {
      const rv = this.atom(c.invoke);
      this.check(`Hp.NilCk<${rv}>`, (r) => this.pnH(r));
      const tab = e.methodTabs.has(c.method) ? `Mt_${mname(c.method)}` : "{}";
      rec = tup([`R.Look<${tab}, ${rv}[0]>`, tup([`${rv}[1]`, ...argv]), "[]"]);
    } else {
      // builtin defers: record name, args and the static print info
      const info = ins.args.map((o) => this.printInfo(this.typeOf(o)));
      rec = tup([`"b:${c.builtin}"`, tup(argv), `[${info.join(", ")}]`]);
    }
    if (ins.stack) {
      // onto the frame a deferstack value names (range-over-func bodies)
      const sx = this.atom(ins.stack);
      if (!this.fe.hasD) {
        this.K = this.bind(`R.DeferAt<${this.K}, ${sx}, ${rec}>`);
        return;
      }
      // the frame itself when it is the one deferstack named
      const kd = this.bind(`R.DeferOn<${this.K}, ${this.dText()}, ${sx}, ${rec}>`);
      this.K = this.atomV(`${kd}[0]`);
      this.env.set(D_REG, { t: this.atomV(`${kd}[1]`), atom: true });
      return;
    }
    const d = this.dText();
    const nd = this.bind(`R.Cons<${rec}, ${d}>`);
    this.env.set(D_REG, { t: nd, atom: true });
  }

  /** Print kind of a static type for print/println. */
  printInfo(t: number): string {
    if (t < 0) return `"p"`;
    const ti = this.e.info(t);
    switch (ti.k) {
      case "bool":
        return `"b"`;
      case "int":
        return `"${this.e.kindW(t)}"`;
      case "string":
        return `"s"`;
      case "float":
        return `"f${ti.fbits}"`;
      case "slice":
        return `"sl"`;
      case "interface":
        return `"if"`;
      default:
        return `"p"`;
    }
  }

  builtin(ins: Extract<Instr, { op: "call" }>): void {
    const name = (ins.callee as { builtin: string }).builtin;
    const e = this.e;
    const at = ins.args.map((o) => this.typeOf(o));
    const u0 = at[0] !== undefined && at[0] >= 0 ? e.info(at[0]).u : null;
    const dst = ins.dst;
    const set = (ex: string, o: { atom?: boolean; mustBind?: boolean } = {}) => {
      if (dst !== undefined) this.setReg(dst, ex, o);
    };
    switch (name) {
      case "len": {
        const k = u0?.k;
        if (k === "array") return set(n2((u0 as any).len), { atom: true });
        if (k === "pointer")
          return set(n2((e.info((u0 as any).elem).u as any).len), { atom: true });
        const x = this.val(ins.args[0]!).t;
        if (k === "string") return set(`Sr.Len<${x}>`);
        if (k === "slice") return set(`Hp.Len<${x}>`);
        if (k === "map") {
          const h = this.heapRead();
          return set(`Mp.MapLen<${h}, ${x}>`);
        }
        if (k === "chan") return set(`"0"`, { atom: true });
        throw new Error("len of " + k);
      }
      case "cap": {
        const k = u0?.k;
        if (k === "array") return set(n2((u0 as any).len), { atom: true });
        if (k === "pointer")
          return set(n2((e.info((u0 as any).elem).u as any).len), { atom: true });
        const x = this.val(ins.args[0]!).t;
        if (k === "slice") return set(`Hp.Cap<${x}>`);
        return set(`"0"`, { atom: true });
      }
      case "append": {
        const et = (u0 as any).elem as number;
        const es = e.slots(et);
        const ze = e.zslots(et);
        const [size] = e.T.size(et);
        const noscan = !e.T.ptrs(et);
        const s = this.atom(ins.args[0]!);
        const fromString = e.info(at[1]!).k === "string";
        const h = this.heapRead();
        let r: string;
        if (fromString) {
          const str = this.atom(ins.args[1]!);
          r = this.bind(
            `Hp.AppendVals<${h}, ${s}, Sr.Codes<${str}>, Sr.Len<${str}>, "1", ["0"], "1", true>`,
          );
        } else {
          const src = this.atom(ins.args[1]!);
          r = this.bind(`Hp.Append<${h}, ${s}, ${src}, ${n2(es)}, ${ze}, ${n2(size)}, ${noscan}>`);
        }
        this.H = `${r}[0]`;
        this.heapNest = 1;
        return set(`${r}[1]`);
      }
      case "copy": {
        const et = (u0 as any).elem as number;
        const es = e.slots(et);
        const d = this.atom(ins.args[0]!);
        const fromString = e.info(at[1]!).k === "string";
        const src = this.atom(ins.args[1]!);
        if (fromString) {
          const n = this.bind(`N.Min<Hp.Len<${d}> & string, Sr.Len<${src}>>`);
          this.heapWrite(
            (h) => `Hp.CopyVals_<${h}, ${d}, Sr.Codes<R.StrTake<${src}, ${n}>>, ["0"]>`,
          );
          return set(n, { atom: true });
        }
        set(`Hp.CopyN<${d}, ${src}>`);
        this.heapWrite((h) => `Hp.Copy<${h}, ${d}, ${src}, ${n2(es)}, ${e.zslots(et)}>`);
        return;
      }
      case "delete": {
        const mt = u0 as any;
        const m = this.atom(ins.args[0]!);
        const k = this.atom(ins.args[1]!);
        const c = e.canon(k, mt.key, '"n"');
        if (c === null) return this.keyTrap(mt.key);
        this.keyCk(k, mt.key);
        this.heapWrite((h) => `Mp.MapDelete<${h}, ${m}, ${c}>`);
        return;
      }
      case "clear": {
        const x = this.atom(ins.args[0]!);
        if (u0?.k === "map") {
          this.heapWrite((h) => `Mp.MapClear<${h}, ${x}>`);
          return;
        }
        const et = (u0 as any).elem as number;
        const es = e.slots(et);
        this.heapWrite((h) => `R.ClearSlice<${h}, ${x}, ${n2(es)}, ${e.zslots(et)}>`);
        return;
      }
      case "min":
      case "max": {
        const t = ins.t!;
        const ti = e.info(t);
        const vals = ins.args.map((o) => this.atom(o));
        let acc = vals[0]!;
        for (let i = 1; i < vals.length; i++) {
          const y = vals[i]!;
          const lt =
            ti.k === "string" ? `Sr.Lt<${y}, ${acc}>` : `I.Lt<"${e.kindW(t)}", ${y}, ${acc}>`;
          const gt =
            ti.k === "string" ? `Sr.Gt<${y}, ${acc}>` : `I.Gt<"${e.kindW(t)}", ${y}, ${acc}>`;
          acc = this.atomV(`${name === "min" ? lt : gt} extends true ? ${y} : ${acc}`);
        }
        return set(acc, { atom: true });
      }
      case "print":
      case "println": {
        const parts = ins.args.map(
          (o) => `R.PrintV<${this.val(o).t}, ${this.printInfo(this.typeOf(o))}>`,
        );
        const sep = name === "println" ? " " : "";
        let s = parts.map((p) => `\${${p} & string}`).join(sep);
        if (name === "println") s += "\\n";
        this.X = `R.XErr<${this.X}, \`${s}\`>`;
        return;
      }
      case "recover": {
        const r = this.bind(`R.Recover<${this.K}, ${this.X}>`);
        this.X = `${r}[1]`;
        return set(`${r}[0]`);
      }
      case "close":
        return this.end(
          `R.Trap<${this.H}, ${this.K}, ${this.X}, ${strLit(`trap: channels are not supported in types (in ${this.fe.f.name})\n`)}>`,
        );
      case "wrapnilchk": {
        const p = this.atom(ins.args[0]!);
        const typ = this.val(ins.args[1]!).t;
        const meth = this.val(ins.args[2]!).t;
        this.check(`R.WrapNilCk<${p}>`, () =>
          this.panicState(tup([e.PE, `R.WrapNilMsg<${typ}, ${meth}>`])),
        );
        return set(p, { atom: true });
      }
      case "deferstack":
        // the running frame's stack index (frames below it, as an int)
        return set(`R.StackIx<${this.K}>`);
    }
    throw new Error("unknown builtin " + name);
  }

  /**
   * An intrinsic call inline: returns the result expression (or null for
   * none); heap and output effects update H / X.
   */
  intrinsic(name: string, args: Val[], g: Func): string | null {
    const e = this.e;
    const a = (i: number) => (args[i]!.atom ? args[i]!.t : this.atomV(args[i]!.t));
    const H = () => this.heapRead();
    switch (name) {
      case "internal/bytealg.Compare":
        return `Sr.BCompare<${H()}, ${a(0)}, ${a(1)}>`;
      case "internal/bytealg.Count":
        return `Sr.BCount<${H()}, ${a(0)}, ${a(1)}>`;
      case "internal/bytealg.CountString":
        return `Sr.CountByte<${a(0)}, ${a(1)}>`;
      case "internal/bytealg.Equal":
        return `Sr.BEqual<${H()}, ${a(0)}, ${a(1)}>`;
      case "internal/bytealg.Index":
        return `Sr.BIndex<${H()}, ${a(0)}, ${a(1)}>`;
      case "internal/bytealg.IndexString":
        return `Sr.IndexStr<${a(0)}, ${a(1)}>`;
      case "internal/bytealg.IndexByte":
        return `Sr.BIndexByte<${H()}, ${a(0)}, ${a(1)}>`;
      case "internal/bytealg.IndexByteString":
        return `Sr.IndexByte<${a(0)}, ${a(1)}>`;
      case "internal/bytealg.MakeNoZero": {
        const n = a(0);
        const h = H();
        const v = this.bind(`Sr.MakeNoZeroV<${h}, ${n}>`);
        this.heapWrite((h) => `Sr.MakeNoZero<${h}, ${n}>`);
        return v;
      }
      case "internal/bytealg.abigen_runtime_cmpstring":
        return `Sr.Compare<${a(0)}, ${a(1)}>`;
      case "strings.(*Builder).String": {
        const b = a(0);
        this.check(`Hp.NilCk<${b}>`, (r) => this.pnH(r));
        return `Sr.BuilderString<${H()}, ${b}>`;
      }
      case "internal/abi.NoEscape":
        return a(0);
      case "slices.overlaps": {
        // overlaps[E](a, b []E): both non-empty in the same object, and their
        // slot ranges intersect (src/ref/intrinsics.ts)
        const st = e.prog.types[(e.prog.types[g.sig] as any).params[0]] as any;
        const es = Math.max(1, e.slots(st.elem));
        return `R.SliceOverlaps<${a(0)}, ${a(1)}, ${strLit(encNat(es))}>`;
      }
      case "maps.clone": {
        // clone(m any) any: a new map with m's entries (renumbered), the same
        // dynamic type; nil interface or nil map: the argument itself
        const x = a(0);
        const h = H();
        const v = this.bind(`R.MapCloneV<${h}, ${x}>`);
        this.heapWrite((h) => `R.MapCloneH<${h}, ${x}>`);
        return v;
      }
      case "gointypes/rt.Write": {
        const fd = a(0);
        const s = this.bind(`Sr.BytesToStr<${H()}, ${a(1)}>`);
        this.X = `R.XWrite<${this.X}, ${fd}, ${s}>`;
        return null;
      }
      case "gointypes/rt.Exit":
      case "syscall.Exit": {
        const c = a(0);
        this.end(`R.ExitC<${this.H}, ${this.K}, ${this.X}, ${c}>`);
        return null;
      }
      case "runtime.KeepAlive":
      case "runtime.SetFinalizer":
      case "runtime.GC":
      case "runtime.Gosched":
      case "os.runtime_beforeExit":
      case "internal/godebug.setUpdate":
      case "internal/godebug.setNewIncNonDefault":
      case "internal/godebug.registerMetric":
      case "sync.runtime_doSpin":
      case "sync.runtime_notifyListCheck":
      case "sync.runtime_registerPoolCleanup":
      case "sync.runtime_procUnpin":
      case "sync/atomic.runtime_procUnpin":
        return null;
      case "runtime.GOMAXPROCS":
      case "runtime.NumCPU":
      case "runtime.NumGoroutine":
        return `"1"`;
      case "time.runtimeNano":
      case "sync.runtime_nanotime":
      case "sync.runtime_procPin":
      case "sync/atomic.runtime_procPin":
        return `"0"`;
      case "internal/chacha8rand.block": {
        const [sd, bf, ct] = [a(0), a(1), a(2)];
        this.heapWrite((h) => `Ch.Block<${h}, ${sd}, ${bf}, ${ct}>`);
        return null;
      }
      case "time.runtimeNow":
        return `["0", "0", "0"]`;
      case "time.runtimeIsBubbled":
      case "sync.runtime_canSpin":
        return `false`;
      case "syscall.runtime_envs":
        return `null`;
      case "noop": {
        const sig = e.prog.types[g.sig] as any;
        return e.resultsZero(sig.results);
      }
      case "sync.throw":
      case "sync.fatal":
      case "internal/sync.throw":
      case "internal/sync.fatal": {
        const m = a(0);
        this.end(
          `R.ExitC<${this.H}, ${this.K}, R.XErr<${this.X}, \`fatal error: \${${m} & string}\\n\\ngoroutine 1 [running]:\\n\`>, 2>`,
        );
        return null;
      }
    }
    // sync/atomic families
    const m = name.match(
      /^sync\/atomic\.(Add|And|Or|CompareAndSwap|Load|Store|Swap)(Int32|Uint32|Int64|Uint64|Uintptr|Pointer)$/,
    );
    if (m) {
      const op = m[1]!;
      const w = {
        Int32: "i32",
        Uint32: "u32",
        Int64: "i64",
        Uint64: "u64",
        Uintptr: "u64",
        Pointer: "p",
      }[m[2]!]!;
      const p = a(0);
      this.check(`Hp.NilCk<${p}>`, () => this.trapPanic("nil pointer in atomic operation"));
      const h = H();
      const old = this.bind(`Hp.Load1<${h}, ${p}, ${w === "p" ? "null" : '"0"'}>`);
      switch (op) {
        case "Load":
          return old;
        case "Store":
          this.heapWrite((h) => `Hp.Store1<${h}, ${p}, ${a(1)}>`);
          return null;
        case "Swap":
          this.heapWrite((h) => `Hp.Store1<${h}, ${p}, ${a(1)}>`);
          return old;
        case "Add": {
          const nv = this.bind(`I.Add<"${w}", ${old}, ${a(1)}>`);
          this.heapWrite((h) => `Hp.Store1<${h}, ${p}, ${nv}>`);
          return nv;
        }
        case "And":
        case "Or": {
          const nv = this.bind(`I.${op}<"${w}", ${old}, ${a(1)}>`);
          this.heapWrite((h) => `Hp.Store1<${h}, ${p}, ${nv}>`);
          return old;
        }
        case "CompareAndSwap": {
          const ok = this.bind(`R.Eq<${old}, ${a(1)}>`);
          const nv = this.bind(`${ckParen(ok)} extends true ? ${a(2)} : ${old}`);
          this.heapWrite((h) => `Hp.Store1<${h}, ${p}, ${nv}>`);
          return ok;
        }
      }
    }
    this.end(
      `R.Trap<${this.H}, ${this.K}, ${this.X}, ${strLit(`trap: intrinsic ${name} is not supported in types\n`)}>`,
    );
    return null;
  }

  trapPanic(msg: string): string {
    return `R.Trap<${this.H}, ${this.K}, ${this.X}, ${strLit(`trap: ${msg} (in ${this.fe.f.name})\n`)}>`;
  }
}

/** Entry-block parameters of a callee (without emitting it). */
class FuncEmitterLite {
  fe: FuncEmitter | null;
  constructor(e: Emitter, g: Func, gid: number) {
    this.fe = g.body === "ir" ? cachedFE(e, g, gid) : null;
  }
  blockParams0(): number[] {
    return this.fe ? this.fe.blockParams(0) : [];
  }
}
const feCache = new WeakMap<Func, FuncEmitter>();
function cachedFE(e: Emitter, g: Func, gid: number): FuncEmitter {
  let fe = feCache.get(g);
  if (!fe) feCache.set(g, (fe = new FuncEmitter(e, g, gid)));
  return fe;
}

/** Estimated instantiations of an instruction (fuel weights). */
/** Estimated instantiations of one chacha8rand.block (4 lanes of 8 rounds on u32). */
const CHACHA_COST = 450_000;

function opCost(ins: Instr): number {
  switch (ins.op) {
    case "store":
      return 500;
    case "alloc":
      return 450;
    case "load":
      return 120;
    case "binop":
      return ins.kind === "*" || ins.kind === "/" || ins.kind === "%" ? 1500 : 150;
    case "call":
      return 200;
    case "makeSlice":
      return 600;
    case "mapUpdate":
      return 1500;
    case "lookup":
      return 800;
    case "next":
      return 600;
    case "convert":
      return 300;
    case "slice":
      return 300;
    case "indexAddr":
    case "index":
      return 120;
    default:
      return 40;
  }
}

/** Whether an instruction reads the heap (it must see every earlier write: a new segment). */
function readsHeap(ins: Instr, e: Emitter): boolean {
  switch (ins.op) {
    case "load":
    case "alloc":
    case "makeSlice":
    case "makeMap":
    case "lookup":
    case "next":
    case "convert":
      return true;
    case "call": {
      const c = ins.callee;
      if ("builtin" in c) return ["len", "append", "copy"].includes(c.builtin);
      if ("static" in c) return e.prog.funcs[c.static]!.body === "intrinsic";
      return false;
    }
    default:
      return false;
  }
}

interface SwitchChain {
  x: number;
  /** case constants (key text) and the block whose "then" edge they take */
  cases: { key: string; blk: number }[];
  /** the last block of the chain (its "else" edge is the default) */
  last: number;
}
/** Address expressions that are never nil (a fresh object, or derived from a checked pointer). */
const NONNIL = /^Hp\.(PtrMk<Hp\.NextId<|FieldAddr<|ArrayIndexAddr<|SliceIndexAddr<)/;
/** Fewest cases worth a table dispatch. */
const SWITCH_MIN = 4;

function constTextOf(e: Emitter, c: any, t: number): string {
  if (c === null) return "null";
  if (typeof c === "boolean") return String(c);
  if (typeof c === "string") return strLit(c);
  const ti = e.info(t);
  if ("i" in c) {
    const w = ti.ik ? Number(ti.ik.replace(/\D/g, "")) : 64;
    return n2(BigInt.asIntN(w, BigInt(c.i)));
  }
  const b = BigInt(c.fbits);
  return n2(BigInt.asIntN(ti.fbits ?? 64, b));
}

/** A conditional type in a check position needs parentheses. */
function ckParen(t: string): string {
  return /\bextends\b/.test(t) ? `(${t})` : t;
}
