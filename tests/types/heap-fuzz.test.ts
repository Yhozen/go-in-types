// Fuzz: random straight-line op sequences (alloc, load, store, fieldAddr,
// indexAddr, makeSlice, slice, append, copy, len, cap, interfaces,
// equality, closures) as an IR function run on the reference interpreter
// (src/ref Machine), and the same sequence as type-level aliases over
// src/types/heap.ts. Every result, every check (nil, index, makeslice) and
// at the end every object's slots must equal the reference's, encoded by
// the codec (src/types/codec-heap.ts). A panicking op ends a case; its
// panic must match too.
import { expect, test } from "vite-plus/test";
import type { Instr, Operand, Program, Type } from "../../src/ir/types.ts";
import { Machine } from "../../src/ref/interp.ts";
import { Iface, Ptr, Slice } from "../../src/ref/values.ts";
import { Enc, encNat, eqKind, progTables, strLit, TypeInfo } from "../../src/types/codec-heap.ts";
import { runCases, type Case } from "./tsrs-harness.ts";

// ---------------------------------------------------------------- program

const T_BOOL = 0,
  T_INT = 1,
  T_U8 = 2,
  T_STR = 3,
  T_F64 = 4,
  T_S = 5,
  T_PINT = 6,
  T_PS = 7,
  T_SINT = 8,
  T_SS = 9,
  T_A20 = 10,
  T_PA20 = 11,
  T_EFACE = 12,
  T_T = 13,
  T_I = 14,
  T_MSIG = 15,
  T_F = 16,
  T_PF = 17,
  T_SU8 = 18,
  T_PSTR = 19,
  T_MSIGR = 20,
  T_ERRS = 21,
  T_PLAIN = 22,
  T_A3 = 23,
  T_PA3 = 24,
  T_PU8 = 26,
  T_TUP_INT = 28,
  T_TUP_S = 29,
  T_TUP_I = 30,
  T_TUP_T = 31,
  T_CLOS = 32;

function baseTypes(): Type[] {
  const t: Type[] = [];
  t[T_BOOL] = { k: "bool", slots: 1 };
  t[T_INT] = { k: "int", int: "int64", name: "int", slots: 1 };
  t[T_U8] = { k: "int", int: "uint8", slots: 1 };
  t[T_STR] = { k: "string", slots: 1 };
  t[T_F64] = { k: "float", bits: 64, slots: 1 };
  t[T_S] = {
    k: "struct",
    slots: 3,
    fields: [
      { name: "a", type: T_INT, offset: 0, embedded: false },
      { name: "b", type: T_STR, offset: 1, embedded: false },
      { name: "p", type: T_PINT, offset: 2, embedded: false },
    ],
  };
  t[T_PINT] = { k: "pointer", elem: T_INT, slots: 1 };
  t[T_PS] = { k: "pointer", elem: T_S, slots: 1 };
  t[T_SINT] = { k: "slice", elem: T_INT, slots: 1 };
  t[T_SS] = { k: "slice", elem: T_S, slots: 1 };
  t[T_A20] = { k: "array", elem: T_INT, len: 20, slots: 20 };
  t[T_PA20] = { k: "pointer", elem: T_A20, slots: 1 };
  t[T_EFACE] = { k: "interface", methods: [], sigs: [], slots: 1 };
  t[T_T] = {
    k: "named",
    name: "main.T",
    underlying: T_INT,
    slots: 1,
    methods: { M: 2 },
    ptrMethods: { M: 2 },
  };
  t[T_I] = { k: "interface", methods: ["M"], sigs: [T_MSIG], slots: 1 };
  t[T_MSIG] = { k: "func", params: [], results: [], variadic: false, slots: 1 };
  t[T_F] = {
    k: "struct",
    slots: 2,
    fields: [
      { name: "f", type: T_F64, offset: 0, embedded: false },
      { name: "i", type: T_INT, offset: 1, embedded: false },
    ],
  };
  t[T_PF] = { k: "pointer", elem: T_F, slots: 1 };
  t[T_SU8] = { k: "slice", elem: T_U8, slots: 1 };
  t[T_PSTR] = { k: "pointer", elem: T_STR, slots: 1 };
  t[T_MSIGR] = { k: "func", params: [T_T], results: [], variadic: false, slots: 1 };
  t[T_ERRS] = {
    k: "named",
    name: "runtime.errorString",
    underlying: T_STR,
    slots: 1,
    methods: {},
    ptrMethods: {},
  };
  t[T_PLAIN] = {
    k: "named",
    name: "runtime.plainError",
    underlying: T_STR,
    slots: 1,
    methods: {},
    ptrMethods: {},
  };
  t[T_A3] = { k: "array", elem: T_INT, len: 3, slots: 3 };
  t[T_PA3] = { k: "pointer", elem: T_A3, slots: 1 };
  t[25] = { k: "opaque", what: "unused", slots: 1 };
  t[T_PU8] = { k: "pointer", elem: T_U8, slots: 1 };
  t[27] = { k: "opaque", what: "unused", slots: 1 };
  t[T_TUP_INT] = { k: "tuple", elems: [T_INT, T_BOOL], slots: 2 };
  t[T_TUP_S] = { k: "tuple", elems: [T_S, T_BOOL], slots: 4 };
  t[T_TUP_I] = { k: "tuple", elems: [T_I, T_BOOL], slots: 2 };
  t[T_TUP_T] = { k: "tuple", elems: [T_T, T_BOOL], slots: 2 };
  t[T_CLOS] = { k: "func", params: [], results: [], variadic: false, slots: 1 };
  return t;
}

const PTR: Record<number, number> = {
  [T_INT]: T_PINT,
  [T_S]: T_PS,
  [T_A20]: T_PA20,
  [T_A3]: T_PA3,
  [T_F]: T_PF,
  [T_STR]: T_PSTR,
  [T_U8]: T_PU8,
};
const SLICE_ELEM: Record<number, number> = { [T_SINT]: T_INT, [T_SS]: T_S, [T_SU8]: T_U8 };

// ---------------------------------------------------------------- generator

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

interface Step {
  instr: Instr;
  /** type-level emission: lines using H_prev / H_cur / R_<reg> names */
  tl: (ctx: TlCtx) => void;
  /** may panic: the check alias name (or the result itself) compared to `true`/panic */
}
interface TlCtx {
  hp: string;
  hc: string;
  line: (s: string) => void;
  /** register alias */
  R: (r: number) => string;
  /** a check alias for this step whose expected value is `true` unless the step panics */
  check: (expr: string) => void;
  /** heap unchanged */
  same: () => void;
}

function genCase(seed: number, nOps: number) {
  const r = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const types = baseTypes();
  const ti = new TypeInfo({ types } as any);
  const regTypes: number[] = [];
  const steps: Step[] = [];
  const newReg = (t: number) => (regTypes.push(t), regTypes.length - 1);
  const regsOf = (pred: (t: number) => boolean) =>
    regTypes.map((t, i) => [i, t] as const).filter(([, t]) => pred(t));
  const ci = (v: number, t = T_INT): Operand => ({ c: { i: String(v) }, t });
  const opText = (o: Operand, t: number, R: (r: number) => string): string => {
    if ("r" in o) return R(o.r);
    if ("c" in o) {
      const c = o.c as any;
      if (c === null) return "null";
      if (typeof c === "boolean") return String(c);
      if (typeof c === "string") return strLit(c);
      if ("i" in c) return strLit(encNat(BigInt.asIntN(ti.width(t), BigInt(c.i))));
      if ("fbits" in c) return strLit(encNat(BigInt.asIntN(64, BigInt(c.fbits))));
    }
    throw new Error("operand");
  };
  const zeroFlat = (t: number) => `H.Flat<${ti.zeroText(t).join(", ")}>`;
  const zeroTup = (t: number) => `[${ti.zeroText(t).join(", ")}]`;
  const slots = (t: number) => ti.T.info[t]!.slots;
  /** a random value operand of type t (a register of type t or a constant) */
  const valOf = (t: number): Operand | null => {
    const regs = regsOf((x) => x === t);
    if (regs.length > 0 && r() < 0.5) return { r: pick(regs)[0] };
    switch (t) {
      case T_INT:
        return ci(pick([0, 1, 7, 8, 15, 16, -1, 255, 1000, -9, int(-50, 50)]));
      case T_U8:
        return ci(pick([0, 1, 200, 255, 127, 128]), T_U8);
      case T_STR:
        return { c: pick(["", "a", "hello", "\xff\x00z", 'q"\\']), t: T_STR };
      case T_F64:
        return {
          c: {
            fbits: pick([
              "0x0",
              "0x8000000000000000",
              "0x3ff0000000000000",
              "0x7ff8000000000001",
              "0xfff0000000000001",
              "0x7ff0000000000000",
            ]),
          },
          t: T_F64,
        };
      case T_PINT:
        return regs.length > 0 ? { r: pick(regs)[0] } : { c: null, t: T_PINT };
    }
    return regs.length > 0 ? { r: pick(regs)[0] } : null;
  };

  const ops: (() => boolean)[] = [];
  // alloc
  ops.push(() => {
    const e = pick([T_INT, T_S, T_A20, T_A3, T_F, T_STR, T_U8]);
    const pt = PTR[e]!;
    const dst = newReg(pt);
    steps.push({
      instr: { op: "alloc", dst, t: pt, elem: e, heap: true },
      tl: (c) => {
        const n = slots(e);
        c.line(
          n <= 16
            ? `type ${c.hc} = H.Alloc<${c.hp}, ${zeroFlat(e)}>;`
            : `type ${c.hc} = H.AllocLazy<${c.hp}, ${strLit(encNat(n))}, ${zeroTup(ti.T.info[e]!.u.k === "array" ? (ti.T.info[e]!.u as any).elem : e)}>;`,
        );
        c.line(`type ${c.R(dst)} = H.PtrMk<H.NextId<${c.hp}>, "0">;`);
      },
    });
    return true;
  });
  // store
  ops.push(() => {
    const ps = regsOf((t) => types[t]!.k === "pointer");
    if (ps.length === 0) return false;
    let [p, pt] = pick(ps);
    let ptr: Operand = { r: p };
    if (r() < 0.05) ptr = { c: null, t: pt };
    const e = (types[pt] as any).elem as number;
    const v = valOf(e);
    if (!v) return false;
    steps.push({
      instr: { op: "store", ptr, val: v },
      tl: (c) => {
        const P = opText(ptr, pt, c.R);
        c.check(`H.NilCk<${P}>`);
        const V = opText(v, e, c.R);
        c.line(`type ${c.hc} = H.${slots(e) === 1 ? "Store1" : "StoreK"}<${c.hp}, ${P}, ${V}>;`);
      },
    });
    return true;
  });
  // load
  ops.push(() => {
    const ps = regsOf((t) => types[t]!.k === "pointer");
    if (ps.length === 0) return false;
    const [p, pt] = pick(ps);
    const e = (types[pt] as any).elem as number;
    const ptr: Operand = r() < 0.05 ? { c: null, t: pt } : { r: p };
    const dst = newReg(e);
    steps.push({
      instr: { op: "load", dst, t: e, ptr },
      tl: (c) => {
        const P = opText(ptr, pt, c.R);
        c.check(`H.NilCk<${P}>`);
        c.same();
        c.line(
          `type ${c.R(dst)} = ${slots(e) === 1 ? `H.Load1<${c.hc}, ${P}, ${ti.zeroText(e)[0]}>` : `H.LoadK<${c.hc}, ${P}, ${zeroTup(e)}>`};`,
        );
      },
    });
    return true;
  });
  // fieldAddr
  ops.push(() => {
    const ps = regsOf((t) => t === T_PS || t === T_PF);
    if (ps.length === 0) return false;
    const [p, pt] = pick(ps);
    const st = (types[pt] as any).elem as number;
    const field = st === T_S ? int(0, 1) : 1;
    const fd = (types[st] as any).fields[field];
    const dst = newReg(PTR[fd.type]!);
    steps.push({
      instr: { op: "fieldAddr", dst, t: PTR[fd.type]!, x: { r: p }, field },
      tl: (c) => {
        c.check(`H.NilCk<${c.R(p)}>`);
        c.same();
        c.line(`type ${c.R(dst)} = H.FieldAddr<${c.R(p)}, ${strLit(encNat(fd.offset))}>;`);
      },
    });
    return true;
  });
  // makeSlice
  ops.push(() => {
    const st = pick([T_SINT, T_SS, T_SU8]);
    const e = SLICE_ELEM[st]!;
    let len = int(0, 6);
    let cap = len + pick([0, 0, 1, 3, 10, 20]);
    if (r() < 0.05) len = -1;
    else if (r() < 0.05) cap = len - 1;
    const dst = newReg(st);
    steps.push({
      instr: { op: "makeSlice", dst, t: st, len: ci(len), cap: ci(cap) },
      tl: (c) => {
        const L = strLit(encNat(len));
        const C = strLit(encNat(cap));
        c.check(`H.MakeSliceCk<${L}, ${C}>`);
        c.line(
          `type ${c.hc} = H.MakeSlice<${c.hp}, ${C}, ${strLit(encNat(slots(e)))}, ${zeroTup(e)}>;`,
        );
        c.line(`type ${c.R(dst)} = H.MakeSliceV<${c.hp}, ${L}, ${C}>;`);
      },
    });
    return true;
  });
  // indexAddr on slices and array pointers
  ops.push(() => {
    const xs = regsOf((t) => t in SLICE_ELEM || t === T_PA20 || t === T_PA3);
    if (xs.length === 0) return false;
    const [x, xt] = pick(xs);
    const isSlice = xt in SLICE_ELEM;
    const e = isSlice ? SLICE_ELEM[xt]! : T_INT;
    const alen = xt === T_PA20 ? 20 : 3;
    const i = r() < 0.1 ? pick([-1, 25, 100]) : int(0, isSlice ? 8 : alen + 1);
    const dst = newReg(PTR[e]!);
    steps.push({
      instr: { op: "indexAddr", dst, t: PTR[e]!, x: { r: x }, index: ci(i) },
      tl: (c) => {
        const I = strLit(encNat(i));
        const es = strLit(encNat(slots(e)));
        c.same();
        if (isSlice) {
          c.check(`H.IndexCk<${I}, H.Len<${c.R(x)}> & string>`);
          c.line(`type ${c.R(dst)} = H.SliceIndexAddr<${c.R(x)}, ${I}, ${es}>;`);
        } else {
          c.check(
            `H.NilCk<${c.R(x)}> extends true ? H.IndexCk<${I}, ${strLit(encNat(alen))}> : H.NilCk<${c.R(x)}>`,
          );
          c.line(`type ${c.R(dst)} = H.ArrayIndexAddr<${c.R(x)}, ${I}, ${es}>;`);
        }
      },
    });
    return true;
  });
  // slice
  ops.push(() => {
    const xs = regsOf((t) => t in SLICE_ELEM || t === T_PA20 || t === T_PA3);
    if (xs.length === 0) return false;
    const [x, xt] = pick(xs);
    const isSlice = xt in SLICE_ELEM;
    const e = isSlice ? SLICE_ELEM[xt]! : T_INT;
    const rt = isSlice ? xt : T_SINT;
    const b = () =>
      r() < 0.35 ? undefined : r() < 0.08 ? pick([-1, 30]) : int(0, isSlice ? 12 : 21);
    const lo = b();
    const hi = b();
    const mx = r() < 0.4 ? (r() < 0.08 ? -2 : int(0, isSlice ? 14 : 21)) : undefined;
    const dst = newReg(rt);
    const instr: any = { op: "slice", dst, t: rt, x: { r: x } };
    if (lo !== undefined) instr.low = ci(lo);
    if (hi !== undefined) instr.high = ci(hi);
    if (mx !== undefined) instr.max = ci(mx);
    steps.push({
      instr,
      tl: (c) => {
        const o = (v: number | undefined) => (v === undefined ? "null" : strLit(encNat(v)));
        const es = strLit(encNat(slots(e)));
        c.same();
        c.line(
          `type ${c.R(dst)} = ${isSlice ? `H.SliceS<${c.R(x)}, ${o(lo)}, ${o(hi)}, ${o(mx)}, ${es}>` : `H.SliceA<${c.R(x)}, ${o(lo)}, ${o(hi)}, ${o(mx)}, ${es}, ${strLit(encNat(xt === T_PA20 ? 20 : 3))}>`};`,
        );
      },
    });
    return true;
  });
  // append(s, t...)
  ops.push(() => {
    const ss = regsOf((t) => t in SLICE_ELEM);
    if (ss.length === 0) return false;
    const [s, st] = pick(ss);
    const same = regsOf((t) => t === st);
    const [y] = pick(same);
    const e = SLICE_ELEM[st]!;
    const sOp: Operand = r() < 0.1 ? { c: null, t: st } : { r: s };
    const dst = newReg(st);
    steps.push({
      instr: { op: "call", dst, t: st, callee: { builtin: "append" }, args: [sOp, { r: y }] },
      tl: (c) => {
        const [size] = ti.T.size(e);
        const noscan = !ti.T.ptrs(e);
        const S = opText(sOp, st, c.R);
        c.line(
          `type A_${c.hc} = H.Append<${c.hp}, ${S}, ${c.R(y)}, ${strLit(encNat(slots(e)))}, ${zeroTup(e)}, ${strLit(encNat(size))}, ${noscan}>;`,
        );
        c.line(`type ${c.hc} = A_${c.hc}["0"];`);
        c.line(`type ${c.R(dst)} = A_${c.hc}["1"];`);
      },
    });
    return true;
  });
  // copy(dst, src)
  ops.push(() => {
    const ss = regsOf((t) => t in SLICE_ELEM);
    if (ss.length === 0) return false;
    const [d, st] = pick(ss);
    const [s] = pick(regsOf((t) => t === st));
    const e = SLICE_ELEM[st]!;
    const dst = newReg(T_INT);
    steps.push({
      instr: { op: "call", dst, t: T_INT, callee: { builtin: "copy" }, args: [{ r: d }, { r: s }] },
      tl: (c) => {
        c.line(
          `type ${c.hc} = H.Copy<${c.hp}, ${c.R(d)}, ${c.R(s)}, ${strLit(encNat(slots(e)))}, ${zeroTup(e)}>;`,
        );
        c.line(`type ${c.R(dst)} = H.CopyN<${c.R(d)}, ${c.R(s)}>;`);
      },
    });
    return true;
  });
  // len / cap
  ops.push(() => {
    const ss = regsOf((t) => t in SLICE_ELEM);
    if (ss.length === 0) return false;
    const [s] = pick(ss);
    const which = pick(["len", "cap"] as const);
    const dst = newReg(T_INT);
    steps.push({
      instr: { op: "call", dst, t: T_INT, callee: { builtin: which }, args: [{ r: s }] },
      tl: (c) => {
        c.same();
        c.line(`type ${c.R(dst)} = H.${which === "len" ? "Len" : "Cap"}<${c.R(s)}>;`);
      },
    });
    return true;
  });
  // makeInterface
  ops.push(() => {
    const xt = pick([T_INT, T_STR, T_S, T_T, T_SINT, T_F]);
    let v = valOf(xt === T_T ? T_INT : xt);
    if (xt === T_T) v = valOf(T_INT) ?? ci(3);
    if (!v) return false;
    if (xt === T_T && "r" in v) v = ci(int(0, 9));
    const it = xt === T_T && r() < 0.5 ? T_I : T_EFACE;
    const dst = newReg(it);
    steps.push({
      instr: { op: "makeInterface", dst, t: it, x: v, xt },
      tl: (c) => {
        c.same();
        c.line(`type ${c.R(dst)} = H.MakeIface<${strLit(encNat(xt))}, ${opText(v, xt, c.R)}>;`);
      },
    });
    return true;
  });
  // typeAssert
  ops.push(() => {
    const xs = regsOf((t) => t === T_EFACE || t === T_I);
    const nil = r() < 0.08;
    if (xs.length === 0 && !nil) return false;
    const [x, xt] = nil ? [-1, T_EFACE] : pick(xs);
    const xo: Operand = nil ? { c: null, t: T_EFACE } : { r: x };
    const at = pick([T_INT, T_S, T_T, T_I]);
    const ok = r() < 0.5;
    const rt = ok
      ? { [T_INT]: T_TUP_INT, [T_S]: T_TUP_S, [T_T]: T_TUP_T, [T_I]: T_TUP_I }[at]!
      : at;
    const dst = newReg(rt);
    steps.push({
      instr: { op: "typeAssert", dst, t: rt, x: xo, assert: at, commaOk: ok },
      tl: (c) => {
        const X = opText(xo, xt, c.R);
        const A = strLit(encNat(at));
        c.same();
        const e =
          at === T_I
            ? ok
              ? `H.AssertIOk<${X}, ${A}, P>`
              : `H.AssertI<${X}, ${A}, P>`
            : ok
              ? `H.AssertTOk<${X}, ${A}, ${slots(at) === 1 ? ti.zeroText(at)[0] : zeroTup(at)}>`
              : `H.AssertT<${X}, ${A}, ${strLit(encNat(xt))}, P>`;
        c.line(`type ${c.R(dst)} = ${e};`);
      },
    });
    return true;
  });
  // ==
  ops.push(() => {
    const t = pick([T_EFACE, T_EFACE, T_I, T_S, T_F, T_PINT, T_F64]);
    const regs = regsOf((x) => x === t);
    const a =
      t === T_F64 ? valOf(T_F64) : regs.length > 0 ? ({ r: pick(regs)[0] } as Operand) : null;
    const b =
      t === T_F64 ? valOf(T_F64) : regs.length > 0 ? ({ r: pick(regs)[0] } as Operand) : null;
    if (!a || !b) return false;
    const dst = newReg(T_BOOL);
    steps.push({
      instr: { op: "binop", dst, t: T_BOOL, kind: "==", x: a, y: b },
      tl: (c) => {
        c.same();
        c.line(
          `type ${c.R(dst)} = H.Eq<${opText(a, t, c.R)}, ${opText(b, t, c.R)}, ${eqKind(ti, t)}, P>;`,
        );
      },
    });
    return true;
  });
  // append(s, a, b, ...): IR: tmp := make([]T, k); tmp[i] = v_i; append(s, tmp...);
  // types: the same make and stores (ids stay aligned), then AppendVals with the values
  ops.push(() => {
    const ss = regsOf((t) => t === T_SINT || t === T_SU8);
    if (ss.length === 0) return false;
    const [s, st] = pick(ss);
    const e = SLICE_ELEM[st]!;
    const k = int(1, 5);
    const vals = Array.from({ length: k }, () => valOf(e)!);
    const tmp = newReg(st);
    const ptrs = vals.map(() => newReg(PTR[e]!));
    const dst = newReg(st);
    const instrs: Instr[] = [
      { op: "makeSlice", dst: tmp, t: st, len: ci(k), cap: ci(k) },
      ...vals.flatMap((v, i): Instr[] => [
        { op: "indexAddr", dst: ptrs[i]!, t: PTR[e]!, x: { r: tmp }, index: ci(i) },
        { op: "store", ptr: { r: ptrs[i]! }, val: v },
      ]),
      { op: "call", dst, t: st, callee: { builtin: "append" }, args: [{ r: s }, { r: tmp }] },
    ];
    instrs.forEach((instr, j) =>
      steps.push({
        instr,
        tl: (c) => {
          const K = strLit(encNat(k));
          const [size] = ti.T.size(e);
          if (j === 0) {
            c.line(`type ${c.hc} = H.MakeSlice<${c.hp}, ${K}, "1", ${zeroTup(e)}>;`);
            c.line(`type ${c.R(tmp)} = H.MakeSliceV<${c.hp}, ${K}, ${K}>;`);
          } else if (j === instrs.length - 1) {
            const V = `[${vals.map((v) => opText(v, e, c.R)).join(", ")}]`;
            c.line(
              `type A_${c.hc} = H.AppendVals<${c.hp}, ${c.R(s)}, ${V}, ${K}, "1", ${zeroTup(e)}, ${strLit(encNat(size))}, true>;`,
            );
            c.line(`type ${c.hc} = A_${c.hc}["0"];`);
            c.line(`type ${c.R(dst)} = A_${c.hc}["1"];`);
          } else if (j % 2 === 1) {
            const i = (j - 1) / 2;
            c.same();
            c.line(
              `type ${c.R(ptrs[i]!)} = H.SliceIndexAddr<${c.R(tmp)}, ${strLit(encNat(i))}, "1">;`,
            );
          } else {
            const i = (j - 2) / 2;
            c.line(
              `type ${c.hc} = H.Store1<${c.hp}, ${c.R(ptrs[i]!)}, ${opText(vals[i]!, e, c.R)}>;`,
            );
          }
        },
      }),
    );
    return true;
  });
  // makeClosure (func 3 has free vars int, string)
  ops.push(() => {
    const a = valOf(T_INT)!;
    const b = valOf(T_STR)!;
    const dst = newReg(T_CLOS);
    steps.push({
      instr: { op: "makeClosure", dst, t: T_CLOS, fn: 3, bindings: [a, b] },
      tl: (c) => {
        c.same();
        c.line(
          `type ${c.R(dst)} = H.MakeClosure<"3", [${opText(a, T_INT, c.R)}, ${opText(b, T_STR, c.R)}]>;`,
        );
      },
    });
    return true;
  });
  const weights = [3, 3, 3, 1, 3, 3, 3, 4, 2, 1, 2, 2, 2, 2, 1];
  const total = weights.reduce((a, b) => a + b);
  const mkProg = (): Program => ({
    version: 2,
    build: {},
    types,
    globals: [],
    funcs: [
      {
        name: "init",
        sig: T_MSIG,
        params: 0,
        freeVars: 0,
        regs: 0,
        regTypes: [],
        blocks: [{ preds: [], succs: [], instrs: [{ op: "return", results: [] }] }],
        body: "ir",
        recover: -1,
      },
      {
        name: "main.main",
        sig: T_MSIG,
        params: 0,
        freeVars: 0,
        regs: regTypes.length,
        regTypes: regTypes.slice(),
        blocks: [
          {
            preds: [],
            succs: [],
            instrs: [...steps.map((s) => s.instr), { op: "return", results: [] }],
          },
        ],
        body: "ir",
        recover: -1,
      },
      {
        name: "main.T.M",
        sig: T_MSIGR,
        params: 1,
        freeVars: 0,
        regs: 1,
        regTypes: [T_T],
        blocks: [{ preds: [], succs: [], instrs: [{ op: "return", results: [] }] }],
        body: "ir",
        recover: -1,
      },
      {
        name: "main.lit",
        sig: T_CLOS,
        params: 0,
        freeVars: 2,
        regs: 2,
        regTypes: [T_INT, T_STR],
        blocks: [{ preds: [], succs: [], instrs: [{ op: "return", results: [] }] }],
        body: "ir",
        recover: -1,
      },
    ],
    init: 0,
    main: 1,
    entries: {},
  });
  // reference-guided: an op that panics is kept rarely, and then ends the case
  let guard = 0;
  while (steps.length < nOps && guard++ < nOps * 30) {
    let k = r() * total;
    let i = 0;
    while (k >= weights[i]!) k -= weights[i++]!;
    const nr = regTypes.length;
    const ns = steps.length;
    if (!ops[i]!()) continue;
    const m = new Machine(mkProg());
    m.boot();
    m.run();
    if (m.curPanic === null) continue;
    if (r() < 0.12) break;
    steps.length = ns;
    regTypes.length = nr;
  }
  const prog = mkProg();
  return { prog, steps, regTypes };
}

// ---------------------------------------------------------------- reference run + type-level text

function panicText(v: any, ti: TypeInfo): string {
  const x = v as Iface;
  const kind =
    ti.prog.types[x.t]!.k === "named" && (ti.prog.types[x.t] as any).name === "runtime.plainError"
      ? "p"
      : "e";
  const msg = x.v as string;
  const numeric = /^(index out of range|slice bounds out of range)/.test(msg);
  const parts: string[] = [];
  if (numeric) {
    let last = 0;
    for (const m of msg.matchAll(/-?\d+/g)) {
      parts.push(strLit(msg.slice(last, m.index)));
      parts.push(`[${strLit(encNat(BigInt(m[0])))}]`);
      last = m.index! + m[0].length;
    }
    if (last < msg.length) parts.push(strLit(msg.slice(last)));
  } else parts.push(strLit(msg));
  return `H.Panic<"${kind}", [${parts.filter((p) => p !== '""').join(", ")}]>`;
}

function buildCase(
  seed: number,
  nOps: number,
  pre: string,
): { lines: string[]; cases: Case[]; panicked: boolean } {
  const { prog, steps, regTypes } = genCase(seed, nOps);
  const ti = new TypeInfo(prog);
  // full run: find the panicking op, if any
  const m1 = new Machine(prog);
  m1.boot();
  m1.run();
  const panicked = m1.curPanic !== null;
  if (m1.exitCode !== 0 && !panicked) throw new Error("reference run failed: " + m1.err.join(""));
  const nRun = panicked ? m1.ops - 2 : steps.length; // ops: init return + main instrs
  const m = new Machine(prog);
  m.boot();
  m.run(1 + nRun);
  const regs = m.top!.regs;
  // object ids in order of first appearance in each step's result register
  const enc = new Enc(ti);
  const objSlotTypes: number[][] = [];
  const lines: string[] = [];
  const cases: Case[] = [];
  const R = (r: number) => `${pre}R${r}`;
  let hp = `H.HeapEmpty`;
  const limit = Math.min(steps.length, nRun + (panicked ? 1 : 0));
  for (let k = 0; k < limit; k++) {
    const st = steps[k]!;
    const hc = `${pre}H${k}`;
    let checked = false;
    const isPanicStep = panicked && k === nRun;
    const ctx: TlCtx = {
      hp,
      hc,
      R,
      line: (s) => lines.push(s),
      same: () => lines.push(`type ${hc} = ${hp};`),
      check: (e) => {
        checked = true;
        const name = `${pre}K${k}`;
        lines.push(`type ${name} = ${e};`);
        cases.push({
          name: `${pre} step ${k} check (${st.instr.op})`,
          actual: name,
          expected: isPanicStep ? panicText(m1.curPanic!.v, ti) : "true",
        });
      },
    };
    st.tl(ctx);
    hp = hc;
    const dst = (st.instr as any).dst as number | undefined;
    if (isPanicStep) {
      if (!checked) {
        // the result itself is the panic (slice, typeAssert, ==)
        if (dst === undefined) throw new Error("panic without check or result");
        cases.push({
          name: `${pre} step ${k} panic (${st.instr.op})`,
          actual: R(dst),
          expected: panicText(m1.curPanic!.v, ti),
        });
      }
      break;
    }
    if (dst !== undefined) {
      const v = regs[dst];
      // register new objects (allocation order)
      const o = v instanceof Ptr ? v.o : v instanceof Slice ? v.o : null;
      if (o && !enc.ids.has(o)) {
        enc.id(o);
        const i = st.instr as any;
        const et = i.op === "alloc" ? i.elem : SLICE_ELEM[regTypes[dst]!]!;
        const n = (o as any[]).length;
        const es = ti.slotTypes(et);
        objSlotTypes.push(Array.from({ length: n }, (_, j) => es[j % es.length]!));
      }
      cases.push({
        name: `${pre} step ${k} ${st.instr.op} r${dst}`,
        actual: R(dst),
        expected: enc.value(v, regTypes[dst]!),
      });
    }
  }
  // every object's slots
  if (!panicked)
    enc.order.forEach((o, k) => {
      const sts = objSlotTypes[k]!;
      const arr = o as any[];
      if (arr.length === 0 || arr.length > 200) return;
      const zero = sts.map((t) => ti.zeroText(t)[0]);
      cases.push({
        name: `${pre} object ${k}`,
        actual: `H.LoadK<${hp}, [${strLit(enc.id(o))}, "0"], [${zero.join(", ")}]>`,
        expected: `[${arr.map((x, j) => enc.value(x, sts[j]!)).join(", ")}]`,
      });
    });
  return { lines, cases, panicked };
}

test("heap ops agree with the reference interpreter (fuzz)", () => {
  const N = Number(process.env.HEAP_FUZZ ?? 200);
  const base = Number(process.env.HEAP_FUZZ_SEED ?? 1);
  const per = 20;
  const prog = genCase(1, 1).prog;
  const header = [
    `import type * as H from "../../src/types/heap.ts";`,
    progTables(prog, [T_INT, T_STR, T_S, T_T, T_SINT, T_F], [T_EFACE, T_I]),
  ].join("\n");
  let panics = 0;
  let total = 0;
  for (let b = 0; b < N; b += per) {
    const lines: string[] = [];
    const cases: Case[] = [];
    for (let s = b; s < Math.min(N, b + per); s++) {
      const c = buildCase(base + s, 12 + (s % 40), `c${s}_`);
      lines.push(...c.lines);
      cases.push(...c.cases);
      if (c.panicked) panics++;
    }
    total += cases.length;
    const res = runCases(`fuzz-${b}.ts`, header + "\n" + lines.join("\n"), cases);
    expect(res.other).toEqual([]);
    expect(res.failures).toEqual([]);
  }
  if (process.env.HEAP_FUZZ_STATS) console.log({ cases: N, checks: total, panics });
  expect(total).toBeGreaterThan(N * 5);
  expect(panics).toBeGreaterThan(0);
}, 900_000);
