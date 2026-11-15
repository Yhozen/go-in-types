// Expected integer results for the type-level integer tests and fuzzer, from
// the reference interpreter's own functions (src/ref/values.ts). The 64-bit
// cases call those functions directly; the narrower widths repeat
// src/ref/interp.ts's `binop` / `unop` closures (not exported there), which
// are built from values.ts's `norm` and `shiftCount`.
import type { BinOpKind, IntKind } from "../src/ir/types.ts";
import {
  add64s,
  add64u,
  and64,
  andNot64,
  convInt,
  div64s,
  div64u,
  GoPanic,
  isSigned,
  mul64s,
  mul64u,
  neg64s,
  neg64u,
  norm,
  not64s,
  not64u,
  or64,
  rem64s,
  rem64u,
  shiftCount,
  shl64,
  shr64,
  sub64s,
  sub64u,
  WIDTH,
  xor64,
  type I64,
} from "../src/ref/values.ts";

export const KINDS: IntKind[] = [
  "int8",
  "uint8",
  "int16",
  "uint16",
  "int32",
  "uint32",
  "int64",
  "uint64",
];

/** A panic result: the runtime error message. */
export interface RefPanic {
  panic: string;
}
export type RefResult = I64 | boolean | RefPanic;

/** A reference value of kind k from any integer (wrapped to the width). */
export function refValue(x: bigint, k: IntKind): I64 {
  const w = WIDTH[k];
  const b = isSigned(k) ? BigInt.asIntN(w, x) : BigInt.asUintN(w, x);
  if (w < 64) return Number(b);
  return b >= -BigInt(Number.MAX_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(b)
    : b;
}

function binop64(kind: BinOpKind, s: boolean): (a: any, b: any) => any {
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

/** interp.ts's `binop` for widths below 64. */
function binopN(kind: BinOpKind, ik: IntKind): (a: any, b: any) => any {
  const n = norm(ik);
  const w = WIDTH[ik];
  const s = isSigned(ik);
  const divZero = () => {
    throw new GoPanic({ t: -1, v: "integer divide by zero" });
  };
  switch (kind) {
    case "+":
      return (a, b) => n(a + b);
    case "-":
      return (a, b) => n(a - b);
    case "*":
      return w === 32 ? (a, b) => n(Math.imul(a, b)) : (a, b) => n(a * b);
    case "/":
      return (a, b) => (b === 0 ? divZero() : n(Math.trunc(a / b)));
    case "%":
      return (a, b) => (b === 0 ? divZero() : n(a % b));
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

function catching(f: () => RefResult): RefResult {
  try {
    return f();
  } catch (e) {
    if (e instanceof GoPanic) return { panic: String(e.v.v) };
    throw e;
  }
}

/** a OP b for operands of kind k (shift counts are of kind `ck`). */
export function refBinop(kind: BinOpKind, k: IntKind, a: I64, b: I64): RefResult {
  switch (kind) {
    case "==":
      return a === b;
    case "!=":
      return a !== b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
  }
  const fn = WIDTH[k] === 64 ? binop64(kind, isSigned(k)) : binopN(kind, k);
  return catching(() => fn(a, b));
}

/** -a or ^a of kind k (interp.ts's `unop`). */
export function refUnop(kind: "-" | "^", k: IntKind, a: I64): I64 {
  if (WIDTH[k] === 64) {
    const s = isSigned(k);
    return (kind === "-" ? (s ? neg64s : neg64u) : s ? not64s : not64u)(a);
  }
  const n = norm(k);
  return kind === "-" ? n(-(a as number)) : n(~(a as number));
}

/** Conversion of a kind-`from` value to kind `to`. */
export function refConv(from: IntKind, to: IntKind, a: I64): I64 {
  return convInt(from, to)(a);
}
