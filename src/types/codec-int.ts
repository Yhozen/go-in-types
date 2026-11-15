// Integers between reference values (src/ref/values.ts) and the type-level
// encoding (src/types/int.ts, docs/DESIGN.md "Type-level encodings").
//
// Every Go integer, of any width and signedness, is the nibble string of its
// w-bit pattern sign-extended to 64 bits: lowercase hex, least significant
// nibble first, trimmed to the shortest string that sign-extends to the value
// (0 -> "0", -1 -> "f", 8 -> "80"). So uint8 255 is "f", uint64 max is "f",
// int16 -2 is "e": the width and signedness live in the operation.
import type { IntKind } from "../ir/types.ts";
import { canonS, canonU, isSigned, WIDTH, type I64 } from "../ref/values.ts";

const MIN = -(1n << 63n);
const MAX = (1n << 63n) - 1n;
const NIBBLE = /^[0-9a-f]{1,16}$/;

/** The canonical nibble string of an int64 value (throws outside the int64 range). */
export function encodeInt64(x: bigint): string {
  if (x < MIN || x > MAX) throw new RangeError(`not an int64: ${x}`);
  let u = BigInt.asUintN(64, x);
  let s = "";
  for (let i = 0; i < 16; i++) {
    s += (u & 15n).toString(16);
    u >>= 4n;
  }
  // Drop high nibbles that only repeat the sign of the nibble below them.
  let n = 16;
  while (n > 1) {
    const top = s[n - 1]!;
    const below = parseInt(s[n - 2]!, 16);
    if ((top === "0" && below < 8) || (top === "f" && below >= 8)) n--;
    else break;
  }
  return s.slice(0, n);
}

/** The int64 value of a canonical nibble string (throws on anything else). */
export function decodeInt64(s: string): bigint {
  if (!NIBBLE.test(s)) throw new SyntaxError(`not an integer nibble string: ${JSON.stringify(s)}`);
  let u = 0n;
  for (let i = s.length - 1; i >= 0; i--) u = (u << 4n) | BigInt(parseInt(s[i]!, 16));
  const x = BigInt.asIntN(4 * s.length, u);
  if (encodeInt64(x) !== s) throw new SyntaxError(`not canonical: ${JSON.stringify(s)}`);
  return x;
}

/** Any integer (reference value, bigint or decimal) to its kind's type-level nibble string, wrapping to the width. */
export function intToType(v: I64 | string, k: IntKind): string {
  const b = typeof v === "bigint" ? v : BigInt(v);
  return encodeInt64(BigInt.asIntN(WIDTH[k], b));
}

/** A nibble string to the reference value of kind k (number up to 32 bits; number or bigint for 64). */
export function intFromType(s: string, k: IntKind): I64 {
  const x = decodeInt64(s);
  const w = WIDTH[k];
  if (BigInt.asIntN(w, x) !== x) throw new RangeError(`${JSON.stringify(s)} is not a ${k} value`);
  if (w === 64) return isSigned(k) ? canonS(x) : canonU(x);
  return Number(isSigned(k) ? x : BigInt.asUintN(w, x));
}

/** The type literal source text of a reference integer of kind k (e.g. `"80"`). */
export function intLiteral(v: I64 | string, k: IntKind): string {
  return JSON.stringify(intToType(v, k));
}

/** The type literal source text of an IR integer constant (`{ i: decimal }`) of kind k. */
export function constIntLiteral(c: { i: string }, k: IntKind): string {
  return intLiteral(c.i, k);
}

/** Type literal source text (`"80"`) back to the reference value of kind k. */
export function parseIntLiteral(src: string, k: IntKind): I64 {
  const s: unknown = JSON.parse(src);
  if (typeof s !== "string") throw new SyntaxError(`not a string literal: ${src}`);
  return intFromType(s, k);
}

/** The type-level width tag of an integer kind, as `src/types/int.ts` takes it ("i8", "u64", ...). */
export function intTag(k: IntKind): string {
  return `${isSigned(k) ? "i" : "u"}${WIDTH[k]}`;
}
