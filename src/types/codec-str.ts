// Codec for strings (docs/DESIGN.md "Type-level encodings"): a Go string is a
// byte string (one char per byte, 0..255) in the reference and, at the type
// level, a string literal type of the same chars or (128 bytes or more) a
// view `[Base, Off, Len]` of a literal Base (src/types/str.ts). The encoder
// always writes literals; the decoder reads both.

/** Type literal source text of a reference string: a double-quoted literal, bytes escaped as \xHH where needed. */
export function strToType(s: string): string {
  let r = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 255) throw new Error(`strToType: char ${c} is not a byte`);
    if (c === 0x22) r += '\\"';
    else if (c === 0x5c) r += "\\\\";
    else if (c >= 0x20 && c < 0x7f) r += s[i];
    else r += "\\x" + c.toString(16).padStart(2, "0");
  }
  return r + '"';
}

/** The minimum length of a view (str.ts VMIN). */
export const VMIN = 128;

/** Type literal source text of the view base[off : off+len] (len >= VMIN). */
export function viewToType(base: string, off: number, len: number): string {
  if (len < VMIN || off < 0 || off + len > base.length) throw new Error("viewToType: bad view");
  return `[${strToType(base)}, ${JSON.stringify(natToType(off))}, ${JSON.stringify(natToType(len))}]`;
}
/** A non-negative int in the type-level encoding (nibbles least significant first, sign nibble "0"). */
function natToType(n: number): string {
  let h = n.toString(16).split("").reverse().join("");
  if (/[89a-f]$/.test(h)) h += "0";
  return h;
}
function natFromType(s: string): number {
  if (!/^[0-9a-f]+$/.test(s) || /[89a-f]$/.test(s)) throw new Error("strFromType: bad int " + s);
  return parseInt(s.split("").reverse().join(""), 16);
}

const VIEW_RE = /^\[\s*("(?:[^"\\]|\\.)*")\s*,\s*"([0-9a-f]+)"\s*,\s*"([0-9a-f]+)"\s*,?\s*\]$/s;

/**
 * A string's type source text (a literal as printed by strToType or a
 * checker hover, or a view) back to the reference string.
 */
export function strFromType(src: string): string {
  const v = VIEW_RE.exec(src.trim());
  if (v) {
    const base = litFromType(v[1]!);
    const off = natFromType(v[2]!);
    const len = natFromType(v[3]!);
    if (off + len > base.length) throw new Error("strFromType: view out of range");
    return base.slice(off, off + len);
  }
  return litFromType(src);
}
function litFromType(src: string): string {
  const v = JSON.parse(
    src.replace(/\\x([0-9a-fA-F]{2})/g, (_m, h: string) => "\\u00" + h).replace(/\\'/g, "'"),
  ) as unknown;
  if (typeof v !== "string") throw new Error("strFromType: not a string literal: " + src);
  for (let i = 0; i < v.length; i++)
    if (v.charCodeAt(i) > 255) throw new Error("strFromType: non-byte char in " + src);
  return v;
}
