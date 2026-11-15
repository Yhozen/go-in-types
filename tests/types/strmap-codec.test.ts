// Round trips of the string and map codecs (the type-level side of the map
// codec is checked by tests/types/map.gen.ts, which asserts that every
// fuzzed map state equals the codec's text).
import { expect, test } from "vite-plus/test";
import { GoMap } from "../../src/ref/gomap.ts";
import { encodeInt64 } from "../../src/types/codec-int.ts";
import {
  mapStateFromType,
  mapStateToType,
  orderDepth,
  parseTypeText,
  type MapKeyCodec,
  type MapValCodec,
} from "../../src/types/codec-map.ts";
import { strFromType, strToType } from "../../src/types/codec-str.ts";

let seed = 7;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x80000000;
};
const ri = (n: number) => Math.floor(rand() * n);

test("strings: every byte round-trips", () => {
  const all = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i)).join("");
  for (const s of ["", "a", '"\\', all, all.split("").reverse().join("")]) {
    expect(strFromType(strToType(s))).toBe(s);
    expect(parseTypeText(strToType(s))).toBe(s);
  }
});

test("order depth follows the next sequence number", () => {
  expect([0, 1, 16, 17, 256, 257, 4097].map(orderDepth)).toEqual([1, 1, 1, 2, 2, 3, 4]);
});

const strKeys: MapKeyCodec = {
  mode: "s",
  canon: (k) => k as string,
  keyText: (k) => strToType(k as string),
  keyFrom: (t) => t,
};
const intKeys: MapKeyCodec = {
  mode: "i",
  canon: (k) => encodeInt64(k as bigint),
  keyText: (k) => JSON.stringify(encodeInt64(k as bigint)),
  keyFrom: (t) => {
    const s = t as string;
    let u = 0n;
    for (let i = s.length - 1; i >= 0; i--) u = (u << 4n) | BigInt(parseInt(s[i]!, 16));
    return BigInt.asIntN(4 * s.length, u);
  },
};
const vals: MapValCodec = { valText: (v) => JSON.stringify(v), valFrom: (t) => t };

for (const [name, kc, key] of [
  ["string", strKeys, () => "k" + ri(60)],
  ["int", intKeys, () => BigInt(ri(200) - 100) * 65536n],
] as const)
  test(`maps (${name} keys): state text round-trips`, () => {
    for (let round = 0; round < 20; round++) {
      const m = new GoMap(3, (k) => k);
      const n = ri(400);
      for (let i = 0; i < n; i++) {
        const k = key();
        if (rand() < 0.7) m.set(k, "v" + i);
        else m.delete(k);
        if (rand() < 0.003) m.clear();
      }
      const text = mapStateToType(m, kc, vals);
      const back = mapStateFromType(text, 3, (k) => k, kc, vals);
      const live = (g: GoMap) =>
        g.es.filter((e) => e.alive).map((e) => [e.k, e.v, e.seq] as [unknown, unknown, number]);
      expect(live(back)).toEqual(live(m));
      expect(back.nextSeq).toBe(m.nextSeq);
      expect(back.size).toBe(m.size);
      expect(mapStateToType(back, kc, vals)).toBe(text);
    }
  });
