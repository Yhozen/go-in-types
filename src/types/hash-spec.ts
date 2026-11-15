// The map-key hash shared by the type-level runtime (src/types/map.ts, whose
// tables scripts/gen-strmap.ts writes from this file) and the codec
// (src/types/codec-map.ts). Taken from lua-in-types (src/aot/emit/hash.ts):
// 16 bits of state as four nibbles (a, b, c, d) = halves L = ab and R = cd;
// each byte x is one Feistel round
//
//   f = V[b][U[a][x]]          (U[a], V[b]: fixed random permutations of 0..255)
//   (a, b, c, d) <- (c ^ hi(f), d ^ lo(f), a, b)
//
// so every round is a bijection of the state for a fixed byte: two strings of
// the same length that differ in one byte never collide. The result is the
// final state as four hex nibbles, the path of the key in the map's 16-wide
// index trie (first nibble at the root).

/** Deterministic PRNG (mulberry32) so the tables never change. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const perm = (next: () => number): number[] => {
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [p[i], p[j]] = [p[j]!, p[i]!];
  }
  return p;
};

const next = rng(0x5eed1e55);
/** U[a][x]: 16 permutations of the bytes. */
export const U: number[][] = Array.from({ length: 16 }, () => perm(next));
/** V[b][y]: 16 more. */
export const V: number[][] = Array.from({ length: 16 }, () => perm(next));

const HEX = "0123456789abcdef";

/** The hash of a byte string as four hex nibbles (the type-level `Hash<S>`). */
export function strHash(s: string): string {
  let a = 0;
  let b = 0;
  let c = 0;
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    const f = V[b]![U[a]![s.charCodeAt(i)]!]!;
    [a, b, c, d] = [c ^ (f >> 4), d ^ (f & 15), a, b];
  }
  return HEX[a]! + HEX[b]! + HEX[c]! + HEX[d]!;
}
