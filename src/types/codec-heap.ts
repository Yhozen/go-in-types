// Codec for heap values (src/types/heap.ts): reference values and machine
// state <-> type literal source text. Filled in below; see the file header
// of heap.ts for the encodings.

const HEX = "0123456789abcdef";

/**
 * Canonical int encoding of an integer (any sign, interpreted as a 64-bit
 * two's complement pattern already): lowercase nibbles, least significant
 * first, shortest form that sign-extends.
 */
export function encNat(v: number | bigint): string {
  let b = BigInt.asIntN(64, BigInt(v));
  let s = "";
  for (;;) {
    const d = Number(b & 15n);
    s += HEX[d];
    b >>= 4n;
    if ((b === 0n && d < 8) || (b === -1n && d >= 8)) return s;
  }
}

/** Decodes a canonical int to a signed 64-bit bigint. */
export function decNat(s: string): bigint {
  let b = 0n;
  for (let i = s.length - 1; i >= 0; i--) b = (b << 4n) | BigInt(HEX.indexOf(s[i]!));
  return BigInt.asIntN(64, BigInt.asIntN(s.length * 4, b));
}
