// src/types/nat.ts against JS arithmetic and src/ref/values.ts growCap.
import { expect, test } from "vite-plus/test";
import { growCap, roundupsize } from "../../src/ref/values.ts";
import { encNat } from "../../src/types/codec-heap.ts";
import { importLine, runCases, type Case } from "./tsrs-harness.ts";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test("nat arithmetic and growslice match JS", () => {
  const r = rng(7);
  const pick = () => {
    const k = r();
    return k < 0.2
      ? Math.floor(r() * 20)
      : k < 0.6
        ? Math.floor(r() * 5000)
        : Math.floor(r() * 2 ** 30);
  };
  const q = (n: number) => `"${encNat(n)}"`;
  const cases: Case[] = [];
  for (let i = 0; i < 60; i++) {
    const a = pick();
    const b = pick();
    const [x, y] = a >= b ? [a, b] : [b, a];
    cases.push({ name: `add ${a} ${b}`, actual: `Add<${q(a)}, ${q(b)}>`, expected: q(a + b) });
    cases.push({ name: `sub ${x} ${y}`, actual: `Sub<${q(x)}, ${q(y)}>`, expected: q(x - y) });
    const m = Math.floor(r() * 300);
    cases.push({ name: `mul ${a} ${m}`, actual: `Mul<${q(a)}, ${q(m)}>`, expected: q(a * m) });
    cases.push({
      name: `cmp ${a} ${b}`,
      actual: `Cmp<${q(a)}, ${q(b)}>`,
      expected: a < b ? `"<"` : a > b ? `">"` : `"="`,
    });
    const d = 1 + Math.floor(r() * 200);
    cases.push({
      name: `div ${a} ${d}`,
      actual: `Div<${q(a)}, ${q(d)}>`,
      expected: q(Math.floor(a / d)),
    });
    cases.push({ name: `inc ${a}`, actual: `Inc<${q(a)}>`, expected: q(a + 1) });
    if (a > 0) cases.push({ name: `dec ${a}`, actual: `Dec<${q(a)}>`, expected: q(a - 1) });
  }
  for (const d of [1, 2, 4, 8, 16, 24])
    cases.push({
      name: `div 1000 ${d}`,
      actual: `Div<${q(1000)}, ${q(d)}>`,
      expected: q(Math.floor(1000 / d)),
    });
  for (const [v, w] of [
    [200, 8],
    [255, 8],
    [5, 8],
    [65535, 16],
    [40000, 16],
    [4294967295, 32],
  ] as const) {
    const pat = BigInt.asIntN(w, BigInt(v));
    cases.push({
      name: `zext ${v}/${w}`,
      actual: `ZExt<"${encNat(pat)}", "${w / 4}">`,
      expected: q(v),
    });
  }
  // growslice: sizes, noscan both ways, small and large capacities
  const sizes = [1, 8, 12, 16, 24, 40, 3, 100, 1000];
  for (let i = 0; i < 60; i++) {
    const size = sizes[i % sizes.length]!;
    const noscan = r() < 0.5;
    const oldCap = i < 20 ? Math.floor(r() * 20) : Math.floor(r() * 3000);
    const newLen = oldCap + 1 + (r() < 0.8 ? 0 : Math.floor(r() * 2000));
    cases.push({
      name: `grow ${newLen} ${oldCap} ${size} ${noscan}`,
      actual: `GrowCap<${q(newLen)}, ${q(oldCap)}, ${q(size)}, ${noscan}>`,
      expected: q(growCap(newLen, oldCap, size, noscan)),
    });
  }
  for (const s of [1, 7, 8, 500, 513, 1016, 1017, 1024, 5000, 32760, 32761, 40000, 100000])
    for (const noscan of [true, false])
      cases.push({
        name: `roundupsize ${s} ${noscan}`,
        actual: `RoundUpSize<${q(s)}, ${noscan}>`,
        expected: q(roundupsize(s, noscan)),
      });
  const res = runCases(
    "nat.ts",
    importLine(
      ["Add", "Sub", "Mul", "Div", "Cmp", "Inc", "Dec", "ZExt", "GrowCap", "RoundUpSize"],
      "nat.ts",
    ),
    cases,
  );
  expect(res.other).toEqual([]);
  expect(res.failures).toEqual([]);
}, 600_000);
