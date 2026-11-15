// Integer encoding helpers used by the string and map codecs and generators
// until the integer agent's codec lands (then these re-export it). The
// encoding is DESIGN.md's: lowercase hex nibbles, least significant first,
// the shortest two's complement form that sign-extends to the value's w-bit
// pattern sign-extended to 64 bits.

const HEX = "0123456789abcdef";

/** The canonical nibble string of a value given as its 64-bit pattern (any bigint; taken modulo 2^64). */
export function encInt(v: bigint | number): string {
  let u = BigInt.asUintN(64, BigInt(v));
  let s = "";
  for (let i = 0; i < 16; i++) {
    s += HEX[Number(u & 15n)];
    u >>= 4n;
  }
  // Trim: drop the top nibble while the one below it carries the same sign.
  while (s.length > 1) {
    const top = s[s.length - 1]!;
    const below = HEX.indexOf(s[s.length - 2]!);
    if ((top === "0" && below < 8) || (top === "f" && below >= 8)) s = s.slice(0, -1);
    else break;
  }
  return s;
}

/** The value (as int64) of a canonical nibble string. */
export function decInt(s: string): bigint {
  let u = 0n;
  for (let i = s.length - 1; i >= 0; i--) u = (u << 4n) | BigInt(HEX.indexOf(s[i]!));
  const neg = HEX.indexOf(s[s.length - 1]!) >= 8;
  return neg ? u - (1n << BigInt(4 * s.length)) : u;
}
