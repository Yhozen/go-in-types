// Bulk loads, stores and copies (heap.ts LoadK / StoreK / Copy of 32 slots
// or more in a lazy object): random lazy objects of 17..5000 slots, partly written,
// read and written at random offsets and lengths; every result must equal
// the slot-by-slot model computed here.
import { expect, test } from "vite-plus/test";
import { encNat } from "../../src/types/codec-heap.ts";
import { importLine, runCases, type Case } from "./tsrs-harness.ts";

const q = JSON.stringify;
const nib = (v: number) => encNat(BigInt(v));

function rng(seed: number) {
  let s = seed | 0;
  return (n: number) => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

function buildCases(seed: number, count: number) {
  const rnd = rng(seed);
  const lines: string[] = [];
  const cases: Case[] = [];
  let nm = 0;
  for (let c = 0; c < count; c++) {
    const p = `b${seed}_${c}`;
    const M = [17, 40, 256, 300, 1000, 1500, 4096, 5000][rnd(8)]!;
    const depth = M <= 256 ? 2 : M <= 4096 ? 3 : 4;
    const P = 1 + rnd(3); // zero pattern period
    const dens = rnd(3);
    const slots = Array.from({ length: M }, (_, s) =>
      dens === 2 || (dens === 1 && rnd(2)) || (dens === 0 && rnd(20) === 0) ? `v${s}` : null,
    );
    const node = (d: number, base: number): string => {
      if (d === 0) return base < M && slots[base] ? q(slots[base]) : "undefined";
      if (base >= M) return `E${d}`;
      const span = 16 ** (d - 1);
      const kids = Array.from({ length: 16 }, (_, i) => node(d - 1, base + i * span));
      const n = `${p}N${nm++}`;
      lines.push(`type ${n} = Mk16<${kids.join(", ")}>;`);
      return n;
    };
    const span = 16 ** (depth - 1);
    const kids = Array.from({ length: 16 }, (_, i) => node(depth - 1, i * span));
    const zp = Array.from({ length: P }, (_, i) => q(`z${i}`));
    lines.push(`type ${p}O = Mk19<${kids.join(", ")}, "${depth}", ${q(nib(M))}, [${zp}]>;`);
    lines.push(`type ${p}H = H.PutObj<H.AllocObj<H.HeapEmpty, H.ZeroObj>, "00001", ${p}O>;`);
    const z = (s: number) => `z${s % P}`;
    const range = (s0: number, n: number) => Array.from({ length: n }, (_, i) => s0 + i);
    const tup = (xs: string[]) => `[${xs.map((x) => q(x)).join(", ")}]`;
    // load
    const n = 1 + rnd(Math.min(M, [40, 300, 5000][rnd(3)]!));
    const s0 = rnd(M - n + 1);
    const r0 = range(s0, n);
    cases.push({
      name: `${p} load M=${M} at ${s0} n=${n}`,
      actual: `H.LoadK<${p}H, ["00001", ${q(nib(s0))}], ${tup(r0.map(z))}>`,
      expected: tup(r0.map((s) => slots[s] ?? z(s))),
    });
    // store, then load an overlapping range
    const w = 1 + rnd(Math.min(M, [40, 300, 4096][rnd(3)]!));
    const w0 = rnd(M - w + 1);
    const vals = range(0, w).map((i) => `w${i}`);
    lines.push(`type ${p}W = H.StoreK<${p}H, ["00001", ${q(nib(w0))}], ${tup(vals)}>;`);
    const s1 = rnd(M);
    const n1 = 1 + rnd(Math.min(M - s1, 2000));
    const r1 = range(s1, n1);
    cases.push({
      name: `${p} store M=${M} at ${w0} n=${w}, load at ${s1} n=${n1}`,
      actual: `H.LoadK<${p}W, ["00001", ${q(nib(s1))}], ${tup(r1.map(z))}>`,
      expected: tup(r1.map((s) => (s >= w0 && s < w0 + w ? vals[s - w0]! : (slots[s] ?? z(s))))),
    });
    // copy (memmove) within the object, both directions, and from a second object
    const cn = 1 + rnd(Math.min(M, [40, 300, 3000][rnd(3)]!));
    const cs = rnd(M - cn + 1);
    const cd = rnd(M - cn + 1);
    const other = rnd(2) === 1;
    const sl = (id: string, off: number) =>
      `H.SliceMk<"${id}", ${q(nib(off))}, ${q(nib(cn))}, ${q(nib(cn))}>`;
    lines.push(
      `type ${p}C = H.Copy<H.PutObj<${p}H, "00002", ${p}O>, ${sl("00001", cd)}, ${sl(other ? "00002" : "00001", cs)}, "1", [${zp}]>;`,
    );
    const after = slots.slice();
    for (let i = 0; i < cn; i++) after[cd + i] = slots[cs + i]!;
    const s2 = rnd(M);
    const n2 = 1 + rnd(Math.min(M - s2, 2000));
    const r2 = range(s2, n2);
    cases.push({
      name: `${p} copy M=${M} ${cs} -> ${cd} n=${cn}${other ? " (other)" : ""}, load at ${s2} n=${n2}`,
      actual: `H.LoadK<${p}C, ["00001", ${q(nib(s2))}], ${tup(r2.map(z))}>`,
      expected: tup(r2.map((s) => after[s] ?? z(s))),
    });
  }
  return { lines, cases };
}

test("bulk LoadK / StoreK / Copy agree with the slot-by-slot model", () => {
  const header = [
    `import type * as H from "../../src/types/heap.ts";`,
    importLine(["Mk16", "Mk19", "E1", "E2", "E3"], "heap.gen.ts"),
  ].join("\n");
  for (const seed of [1, 2, 3]) {
    const { lines, cases } = buildCases(seed, 12);
    const res = runCases(`heap-bulk-${seed}.ts`, header + "\n" + lines.join("\n"), cases);
    expect(res.other).toEqual([]);
    expect(res.failures).toEqual([]);
  }
}, 600_000);
