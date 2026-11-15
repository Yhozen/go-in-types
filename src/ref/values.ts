// Reference values (docs/DESIGN.md "Value model") and integer semantics.
//
// Internal representation of 64-bit integers (int64, uint64, int, uint,
// uintptr and float64 bit patterns): a JS number when the value is a safe
// integer (|v| <= 2^53 - 1), else a bigint. Every operation returns the
// canonical form, so `===` is value equality and `<` works across both
// forms. Snapshots print 64-bit values as numbers or `{ n: decimal }`; the
// mapping to DESIGN.md's bigint form is exact (see src/ref/snapshot.ts).

/** A memory object: a flat array of slots. */
export type Obj = any[];

export class Ptr {
  o: Obj;
  i: number;
  constructor(o: Obj, i: number) {
    this.o = o;
    this.i = i;
  }
}

export class Slice {
  o: Obj;
  i: number;
  len: number;
  cap: number;
  constructor(o: Obj, i: number, len: number, cap: number) {
    this.o = o;
    this.i = i;
    this.len = len;
    this.cap = cap;
  }
}

export class Func {
  fn: number;
  env: any[];
  constructor(fn: number, env: any[]) {
    this.fn = fn;
    this.env = env;
  }
}

export class Iface {
  t: number;
  v: any;
  constructor(t: number, v: any) {
    this.t = t;
    this.v = v;
  }
}

export class Chan {
  buf: any[] = [];
  closed = false;
  t: number;
  cap: number;
  constructor(t: number, cap: number) {
    this.t = t;
    this.cap = cap;
  }
}

export class StrIter {
  s: string;
  pos: number;
  constructor(s: string, pos: number) {
    this.s = s;
    this.pos = pos;
  }
}

/** Thrown for a Go panic raised by the runtime or an instruction. */
export class GoPanic {
  v: any;
  constructor(v: any) {
    this.v = v;
  }
}

/** Thrown for an unsupported operation reached at run time. */
export class Trap {
  what: string;
  constructor(what: string) {
    this.what = what;
  }
}

/** Thrown to end the run (os.Exit, fatal errors). */
export class Exit {
  code: number;
  msg: string;
  constructor(code: number, msg = "") {
    this.code = code;
    this.msg = msg;
  }
}

// ------------------------------------------------------------ integers

export const MAXS = Number.MAX_SAFE_INTEGER;
const MAXSN = BigInt(MAXS);

export type I64 = number | bigint;

export function canonS(b: bigint): I64 {
  b = BigInt.asIntN(64, b);
  return b >= -MAXSN && b <= MAXSN ? Number(b) : b;
}
export function canonU(b: bigint): I64 {
  b = BigInt.asUintN(64, b);
  return b <= MAXSN ? Number(b) : b;
}
export function big(x: I64): bigint {
  return typeof x === "bigint" ? x : BigInt(x);
}
/** A 64-bit value as a JS number (exact only if safe; used for lengths/indexes). */
export function num(x: I64): number {
  return typeof x === "number" ? x : Number(x);
}

export const add64s = (a: I64, b: I64): I64 => {
  if (typeof a === "number" && typeof b === "number") {
    const r = a + b;
    if (r >= -MAXS && r <= MAXS) return r;
  }
  return canonS(big(a) + big(b));
};
export const add64u = (a: I64, b: I64): I64 => {
  if (typeof a === "number" && typeof b === "number") {
    const r = a + b;
    if (r <= MAXS) return r;
  }
  return canonU(big(a) + big(b));
};
export const sub64s = (a: I64, b: I64): I64 => {
  if (typeof a === "number" && typeof b === "number") {
    const r = a - b;
    if (r >= -MAXS && r <= MAXS) return r;
  }
  return canonS(big(a) - big(b));
};
export const sub64u = (a: I64, b: I64): I64 => {
  if (typeof a === "number" && typeof b === "number") {
    const r = a - b;
    if (r >= 0 && r <= MAXS) return r;
  }
  return canonU(big(a) - big(b));
};
export const mul64s = (a: I64, b: I64): I64 => {
  if (typeof a === "number" && typeof b === "number") {
    const r = a * b;
    if (r >= -MAXS && r <= MAXS) return r + 0;
  }
  return canonS(big(a) * big(b));
};
export const mul64u = (a: I64, b: I64): I64 => {
  if (typeof a === "number" && typeof b === "number") {
    const r = a * b;
    if (r <= MAXS) return r + 0;
  }
  return canonU(big(a) * big(b));
};
export const div64s = (a: I64, b: I64): I64 => {
  if (b === 0) throw divZero();
  if (typeof a === "number" && typeof b === "number") return (a - (a % b)) / b + 0;
  return canonS(big(a) / big(b));
};
export const div64u = (a: I64, b: I64): I64 => {
  if (b === 0) throw divZero();
  if (typeof a === "number" && typeof b === "number") return (a - (a % b)) / b + 0;
  return canonU(big(a) / big(b));
};
export const rem64s = (a: I64, b: I64): I64 => {
  if (b === 0) throw divZero();
  if (typeof a === "number" && typeof b === "number") return (a % b) + 0;
  return canonS(big(a) % big(b));
};
export const rem64u = (a: I64, b: I64): I64 => {
  if (b === 0) throw divZero();
  if (typeof a === "number" && typeof b === "number") return (a % b) + 0;
  return canonU(big(a) % big(b));
};
const isI32 = (x: I64): x is number => typeof x === "number" && (x | 0) === x;
export const and64 =
  (s: boolean) =>
  (a: I64, b: I64): I64 =>
    isI32(a) && isI32(b) ? a & b : s ? canonS(big(a) & big(b)) : canonU(big(a) & big(b));
export const or64 =
  (s: boolean) =>
  (a: I64, b: I64): I64 =>
    isI32(a) && isI32(b) ? a | b : s ? canonS(big(a) | big(b)) : canonU(big(a) | big(b));
export const xor64 =
  (s: boolean) =>
  (a: I64, b: I64): I64 =>
    isI32(a) && isI32(b) ? a ^ b : s ? canonS(big(a) ^ big(b)) : canonU(big(a) ^ big(b));
export const andNot64 =
  (s: boolean) =>
  (a: I64, b: I64): I64 =>
    isI32(a) && isI32(b) ? a & ~b : s ? canonS(big(a) & ~big(b)) : canonU(big(a) & ~big(b));

/** Shift count as a small non-negative number (>= 64 means "all out"); panics if negative. */
export function shiftCount(s: I64): number {
  if (typeof s === "bigint") {
    if (s < 0n) throw rtError("negative shift amount");
    return 1000;
  }
  if (s < 0) throw rtError("negative shift amount");
  return s > 1000 ? 1000 : s;
}
const P2: number[] = [];
for (let i = 0; i < 64; i++) P2.push(2 ** i);

export const shl64 =
  (signed: boolean) =>
  (x: I64, sc: I64): I64 => {
    const s = shiftCount(sc);
    if (s >= 64) return 0;
    if (typeof x === "number" && s < 53) {
      const r = x * P2[s]!;
      if (r >= -MAXS && r <= MAXS) return r + 0;
    }
    return signed ? canonS(big(x) << BigInt(s)) : canonU(big(x) << BigInt(s));
  };
export const shr64 =
  (signed: boolean) =>
  (x: I64, sc: I64): I64 => {
    const s = shiftCount(sc);
    if (s >= 64) return signed && x < 0 ? -1 : 0;
    if (typeof x === "number") return Math.floor(x / P2[s]!) + 0;
    return signed ? canonS(x >> BigInt(s)) : canonU(x >> BigInt(s));
  };
export const neg64s = (x: I64): I64 => (typeof x === "number" ? 0 - x : canonS(-x));
export const neg64u = (x: I64): I64 => (x === 0 ? 0 : canonU(-big(x)));
export const not64s = (x: I64): I64 => {
  if (typeof x === "number") {
    const r = -x - 1;
    if (r >= -MAXS) return r;
  }
  return canonS(~big(x));
};
export const not64u = (x: I64): I64 => canonU(~big(x));

export type Kind = "int8" | "int16" | "int32" | "int64" | "uint8" | "uint16" | "uint32" | "uint64";
export const WIDTH: Record<Kind, number> = {
  int8: 8,
  int16: 16,
  int32: 32,
  int64: 64,
  uint8: 8,
  uint16: 16,
  uint32: 32,
  uint64: 64,
};
export const isSigned = (k: Kind) => k[0] === "i";

/** Normalises an integer-valued JS number (exact) to a width <= 32. */
export function norm(k: Kind): (x: number) => number {
  switch (k) {
    case "int8":
      return (x) => (x << 24) >> 24;
    case "int16":
      return (x) => (x << 16) >> 16;
    case "int32":
      return (x) => x | 0;
    case "uint8":
      return (x) => x & 0xff;
    case "uint16":
      return (x) => x & 0xffff;
    case "uint32":
      return (x) => x >>> 0;
  }
  throw new Error("norm " + k);
}

/** Converts an integer of kind `from` to kind `to`. */
export function convInt(from: Kind, to: Kind): (x: any) => any {
  const fw = WIDTH[from];
  const tw = WIDTH[to];
  const ts = isSigned(to);
  if (tw === 64) {
    if (fw < 64) {
      if (ts || !isSigned(from)) return (x) => x;
      return (x) => (x < 0 ? canonU(BigInt(x)) : x);
    }
    if (ts === isSigned(from)) return (x) => x;
    return ts
      ? (x) => (typeof x === "number" ? x : canonS(x))
      : (x) => (typeof x === "number" && x >= 0 ? x : canonU(big(x)));
  }
  const n = norm(to);
  if (fw === 64) return (x) => (typeof x === "number" ? n(x) : n(Number(BigInt.asIntN(32, x))));
  return n;
}

// ------------------------------------------------------------ errors

/** Set by the machine: builds runtime.errorString / runtime.plainError values. */
export const rt = {
  errorString: -1,
  plainError: -1,
};
export function rtError(msg: string): GoPanic {
  return new GoPanic(new Iface(rt.errorString, msg));
}
export function plainError(msg: string): GoPanic {
  return new GoPanic(new Iface(rt.plainError, msg));
}
export const divZero = () => rtError("integer divide by zero");
export const nilDeref = () => rtError("invalid memory address or nil pointer dereference");
export const indexOOR = (i: number, n: number) =>
  rtError(i < 0 ? `index out of range [${i}]` : `index out of range [${i}] with length ${n}`);

// ------------------------------------------------------------ UTF-8

export function encodeRune(r: number): string {
  if (r < 0 || r > 0x10ffff || (r >= 0xd800 && r <= 0xdfff)) r = 0xfffd;
  if (r < 0x80) return String.fromCharCode(r);
  if (r < 0x800) return String.fromCharCode(0xc0 | (r >> 6), 0x80 | (r & 0x3f));
  if (r < 0x10000)
    return String.fromCharCode(0xe0 | (r >> 12), 0x80 | ((r >> 6) & 0x3f), 0x80 | (r & 0x3f));
  return String.fromCharCode(
    0xf0 | (r >> 18),
    0x80 | ((r >> 12) & 0x3f),
    0x80 | ((r >> 6) & 0x3f),
    0x80 | (r & 0x3f),
  );
}

/** Go's string(x) for an integer x of any width (a bigint is a 64-bit value): U+FFFD unless x is a valid rune. */
export function intString(x: number | bigint): string {
  if (typeof x === "bigint") x = x >= 0n && x <= 0x10ffffn ? Number(x) : -1;
  return encodeRune(x);
}

/** Decodes one rune at byte i of s like utf8.DecodeRuneInString: [rune, size]. */
export function decodeRune(s: string, i: number): [number, number] {
  const n = s.length - i;
  const c0 = s.charCodeAt(i);
  if (c0 < 0x80) return [c0, 1];
  const bad: [number, number] = [0xfffd, 1];
  if (c0 < 0xc2 || c0 > 0xf4) return bad;
  const cont = (c: number) => c >= 0x80 && c <= 0xbf;
  if (c0 < 0xe0) {
    if (n < 2) return bad;
    const c1 = s.charCodeAt(i + 1);
    if (!cont(c1)) return bad;
    return [((c0 & 0x1f) << 6) | (c1 & 0x3f), 2];
  }
  if (n < 2) return bad;
  const c1 = s.charCodeAt(i + 1);
  let lo = 0x80;
  let hi = 0xbf;
  if (c0 === 0xe0) lo = 0xa0;
  else if (c0 === 0xed) hi = 0x9f;
  else if (c0 === 0xf0) lo = 0x90;
  else if (c0 === 0xf4) hi = 0x8f;
  if (c1 < lo || c1 > hi) return bad;
  if (c0 < 0xf0) {
    if (n < 3) return bad;
    const c2 = s.charCodeAt(i + 2);
    if (!cont(c2)) return bad;
    return [((c0 & 0x0f) << 12) | ((c1 & 0x3f) << 6) | (c2 & 0x3f), 3];
  }
  if (n < 3) return bad;
  const c2 = s.charCodeAt(i + 2);
  if (!cont(c2)) return bad;
  if (n < 4) return bad;
  const c3 = s.charCodeAt(i + 3);
  if (!cont(c3)) return bad;
  return [((c0 & 0x07) << 18) | ((c1 & 0x3f) << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f), 4];
}

/** Host text (JS string) to a Go byte string (UTF-8). */
export function utf8Bytes(s: string): string {
  return Buffer.from(s, "utf8").toString("latin1");
}

// ------------------------------------------------------------ growslice

// Go 1.27 runtime size classes (internal/runtime/gc/sizeclasses.go).
const CLASS_TO_SIZE = [
  0, 8, 16, 24, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 256, 288, 320, 352,
  384, 416, 448, 480, 512, 576, 640, 704, 768, 896, 1024, 1152, 1280, 1408, 1536, 1792, 2048, 2304,
  2688, 3072, 3200, 3456, 4096, 4864, 5376, 6144, 6528, 6784, 6912, 8192, 9472, 9728, 10240, 10880,
  12288, 13568, 14336, 16384, 18432, 19072, 20480, 21760, 24576, 27264, 28672, 32768,
];
const SIZE_TO_CLASS8: number[] = [];
const SIZE_TO_CLASS128: number[] = [];
{
  let c = 0;
  for (let i = 0; i <= 1024 / 8; i++) {
    while (CLASS_TO_SIZE[c]! < i * 8) c++;
    SIZE_TO_CLASS8.push(c);
  }
  c = 0;
  for (let i = 0; i <= (32768 - 1024) / 128; i++) {
    while (CLASS_TO_SIZE[c]! < 1024 + i * 128) c++;
    SIZE_TO_CLASS128.push(c);
  }
}

export function roundupsize(size: number, noscan: boolean): number {
  let req = size;
  if (req <= 32768 - 8) {
    if (!noscan && req > 512) req += 8;
    if (req <= 1024 - 8) return CLASS_TO_SIZE[SIZE_TO_CLASS8[Math.ceil(req / 8)]!]! - (req - size);
    return CLASS_TO_SIZE[SIZE_TO_CLASS128[Math.ceil((req - 1024) / 128)]!]! - (req - size);
  }
  return Math.ceil(req / 8192) * 8192;
}

export function nextslicecap(newLen: number, oldCap: number): number {
  let newcap = oldCap;
  const doublecap = newcap + newcap;
  if (newLen > doublecap) return newLen;
  if (oldCap < 256) return doublecap;
  for (;;) {
    newcap += (newcap + 768) >> 2;
    if (newcap >= newLen) break;
  }
  return newcap <= 0 ? newLen : newcap;
}

/** The capacity growslice gives (Go 1.27). */
export function growCap(newLen: number, oldCap: number, elemSize: number, noscan: boolean): number {
  if (elemSize === 0) return newLen;
  const newcap = nextslicecap(newLen, oldCap);
  const mem = roundupsize(newcap * elemSize, noscan);
  return Math.floor(mem / elemSize);
}

// ------------------------------------------------------------ print

/**
 * Go 1.27's runtime printfloat64/32 (print/println of floats, float panic
 * values): strconv.AppendFloat(v, 'g', -1, bits), the shortest decimal that
 * reads back as v.
 */
export function printFloat(v: number, bits: 32 | 64 = 64): string {
  if (v !== v) return "NaN";
  if (v === Infinity) return "+Inf";
  if (v === -Infinity) return "-Inf";
  const neg = v < 0 || (v === 0 && 1 / v < 0);
  const [digs, dp] = shortest(Math.abs(v), bits);
  const nd = digs.length;
  const exp = dp - 1;
  let out: string;
  if (nd > 0 && (exp < -4 || exp >= 6)) {
    // %e with nd - 1 fraction digits, at least two exponent digits
    const e = Math.abs(exp);
    out = `${digs[0]}${nd > 1 ? "." + digs.slice(1) : ""}e${exp < 0 ? "-" : "+"}${e < 10 ? "0" : ""}${e}`;
  } else if (nd === 0) out = "0";
  else if (dp <= 0) out = `0.${"0".repeat(-dp)}${digs}`;
  else if (dp >= nd) out = digs + "0".repeat(dp - nd);
  else out = `${digs.slice(0, dp)}.${digs.slice(dp)}`;
  return (neg ? "-" : "") + out;
}

/** Shortest round-trip digits of v >= 0 and the decimal point position (v = 0.digs * 10^dp). */
function shortest(v: number, bits: 32 | 64): [string, number] {
  if (v === 0) return ["", 0];
  const split = (s: string): [string, number] => {
    const [m, e] = s.split("e");
    const digs = m!.replace(".", "").replace(/0+$/, "");
    return [digs, Number(e) + 1];
  };
  if (bits === 64) return split(v.toExponential());
  // float32: the closest of the shortest decimals that round to v
  for (let p = 1; p <= 9; p++) {
    const near = v.toExponential(p - 1);
    const [m, e] = near.split("e");
    const units = BigInt(m!.replace(".", ""));
    let best: string | null = null;
    let bestDist = Infinity;
    for (const du of [-1n, 0n, 1n]) {
      const u = units + du;
      if (u <= 0n) continue;
      const s = `${u}e${Number(e) - (p - 1)}`;
      if (Math.fround(Number(s)) !== v) continue;
      const d = Math.abs(Number(s) - v);
      if (d < bestDist) ((best = s), (bestDist = d));
    }
    if (best !== null) return split(Number(best).toExponential(p - 1));
  }
  return split(v.toExponential(8));
}

const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
export function bitsToF64(b: I64): number {
  u64[0] = big(b);
  return f64[0]!;
}
export function bitsToF32(b: number): number {
  u32[0] = b;
  return f32[0]!;
}
