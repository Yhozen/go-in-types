// Codec for strings (docs/DESIGN.md "Type-level encodings"): a Go string is a
// byte string (one char per byte, 0..255) in the reference and a string
// literal type of the same chars at the type level.

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

/** A string literal type's source text (as printed by strToType or a checker hover) back to the reference string. */
export function strFromType(src: string): string {
  const v = JSON.parse(
    src.replace(/\\x([0-9a-fA-F]{2})/g, (_m, h: string) => "\\u00" + h).replace(/\\'/g, "'"),
  ) as unknown;
  if (typeof v !== "string") throw new Error("strFromType: not a string literal: " + src);
  for (let i = 0; i < v.length; i++)
    if (v.charCodeAt(i) > 255) throw new Error("strFromType: non-byte char in " + src);
  return v;
}
