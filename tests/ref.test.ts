// Unit tests of the reference runtime (src/ref): integer semantics per width
// against a BigInt model, shifts, division, conversions, UTF-8, map order,
// growslice capacities, and small hand-written IR programs (panics, defer,
// recover, snapshots).
import { expect, test } from "vite-plus/test";
import type { Instr, Program, Type } from "../src/ir/types.ts";
import { GoMap, MapIter } from "../src/ref/gomap.ts";
import { Machine } from "../src/ref/interp.ts";
import { restore, snapshot } from "../src/ref/snapshot.ts";
import { Types } from "../src/ref/types.ts";
import {
  add64s,
  add64u,
  and64,
  andNot64,
  convInt,
  decodeRune,
  div64s,
  div64u,
  encodeRune,
  growCap,
  type Kind,
  mul64s,
  mul64u,
  neg64u,
  norm,
  not64s,
  not64u,
  or64,
  rem64s,
  rem64u,
  shl64,
  shr64,
  sub64s,
  sub64u,
  xor64,
} from "../src/ref/values.ts";

// ---------------------------------------------------------------- integers

let seed = 12345;
function rnd(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed;
}
function rnd64(): bigint {
  const pick = rnd() % 6;
  const specials = [
    0n,
    1n,
    -1n,
    (1n << 63n) - 1n,
    -(1n << 63n),
    (1n << 53n) - 1n,
    1n << 53n,
    -(1n << 53n),
  ];
  if (pick === 0) return specials[rnd() % specials.length]!;
  if (pick === 1) return BigInt((rnd() % 2001) - 1000);
  return BigInt.asIntN(64, (BigInt(rnd()) << 32n) | BigInt(rnd()));
}
const canon = (b: bigint) => (b >= -(2n ** 53n - 1n) && b <= 2n ** 53n - 1n ? Number(b) : b);
const S = (b: bigint) => canon(BigInt.asIntN(64, b));
const U = (b: bigint) => canon(BigInt.asUintN(64, b));

test("64-bit arithmetic matches a BigInt model (signed and unsigned)", () => {
  for (let n = 0; n < 5000; n++) {
    const a = rnd64();
    const b = rnd64();
    const ua = BigInt.asUintN(64, a);
    const ub = BigInt.asUintN(64, b);
    const sa = canon(a);
    const sb = canon(b);
    const xa = canon(ua);
    const xb = canon(ub);
    expect(add64s(sa, sb)).toBe(S(a + b));
    expect(sub64s(sa, sb)).toBe(S(a - b));
    expect(mul64s(sa, sb)).toBe(S(a * b));
    expect(add64u(xa, xb)).toBe(U(ua + ub));
    expect(sub64u(xa, xb)).toBe(U(ua - ub));
    expect(mul64u(xa, xb)).toBe(U(ua * ub));
    expect(and64(true)(sa, sb)).toBe(S(a & b));
    expect(or64(true)(sa, sb)).toBe(S(a | b));
    expect(xor64(true)(sa, sb)).toBe(S(a ^ b));
    expect(andNot64(false)(xa, xb)).toBe(U(ua & ~ub));
    expect(not64s(sa)).toBe(S(~a));
    expect(not64u(xa)).toBe(U(~ua));
    expect(neg64u(xa)).toBe(U(-ua));
    if (b !== 0n) {
      expect(div64s(sa, sb)).toBe(S(a / b));
      expect(rem64s(sa, sb)).toBe(S(a % b));
      expect(div64u(xa, xb)).toBe(U(ua / ub));
      expect(rem64u(xa, xb)).toBe(U(ua % ub));
    }
    const s = rnd() % 70;
    expect(shl64(true)(sa, s)).toBe(s >= 64 ? 0 : S(a << BigInt(s)));
    expect(shr64(true)(sa, s)).toBe(s >= 64 ? (a < 0n ? -1 : 0) : S(a >> BigInt(s)));
    expect(shr64(false)(xa, s)).toBe(s >= 64 ? 0 : U(ua >> BigInt(s)));
  }
});

test("MinInt64 / -1 wraps; division by zero panics", () => {
  expect(div64s(-(1n << 63n), -1)).toBe(-(1n << 63n));
  expect(rem64s(-(1n << 63n), -1)).toBe(0);
  expect(() => div64s(1, 0)).toThrow();
});

test("small widths wrap like Go", () => {
  const kinds: Kind[] = ["int8", "int16", "int32", "uint8", "uint16", "uint32"];
  for (const k of kinds) {
    const w = Number(k.replace(/\D/g, ""));
    const signed = k[0] === "i";
    const model = (b: bigint) => Number(signed ? BigInt.asIntN(w, b) : BigInt.asUintN(w, b));
    const n = norm(k);
    for (let i = 0; i < 2000; i++) {
      const a = model(BigInt(rnd()));
      const b = model(BigInt(rnd()));
      expect(n(a + b)).toBe(model(BigInt(a) + BigInt(b)));
      expect(n(a - b)).toBe(model(BigInt(a) - BigInt(b)));
      const mul = w === 32 ? n(Math.imul(a, b)) : n(a * b);
      expect(mul).toBe(model(BigInt(a) * BigInt(b)));
      if (b !== 0) expect(n(Math.trunc(a / b))).toBe(model(BigInt(a) / BigInt(b)));
    }
  }
});

test("integer conversions between every pair of widths", () => {
  const kinds: Kind[] = ["int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64"];
  const model = (k: Kind, b: bigint) => {
    const w = Number(k.replace(/\D/g, ""));
    const r = k[0] === "i" ? BigInt.asIntN(w, b) : BigInt.asUintN(w, b);
    return w === 64 ? canon(r) : Number(r);
  };
  for (const from of kinds)
    for (const to of kinds) {
      const c = convInt(from, to);
      for (let i = 0; i < 300; i++) {
        const x = model(from, rnd64());
        expect(c(x)).toBe(model(to, BigInt(x)));
      }
    }
});

// ---------------------------------------------------------------- UTF-8

test("UTF-8 decode matches Go's DecodeRuneInString on edge cases", () => {
  const b = (...xs: number[]) => String.fromCharCode(...xs);
  expect(decodeRune(b(0x41), 0)).toEqual([0x41, 1]);
  expect(decodeRune(b(0xc3, 0xa9), 0)).toEqual([0xe9, 2]);
  expect(decodeRune(b(0xc0, 0x80), 0)).toEqual([0xfffd, 1]); // overlong
  expect(decodeRune(b(0xe0, 0x80, 0x80), 0)).toEqual([0xfffd, 1]); // overlong
  expect(decodeRune(b(0xed, 0xa0, 0x80), 0)).toEqual([0xfffd, 1]); // surrogate
  expect(decodeRune(b(0xf4, 0x90, 0x80, 0x80), 0)).toEqual([0xfffd, 1]); // > U+10FFFF
  expect(decodeRune(b(0xf0, 0x9f, 0x98, 0x80), 0)).toEqual([0x1f600, 4]);
  expect(decodeRune(b(0xf0, 0x9f, 0x98), 0)).toEqual([0xfffd, 1]); // truncated
  expect(decodeRune(b(0x80), 0)).toEqual([0xfffd, 1]);
  expect(decodeRune(b(0xff), 0)).toEqual([0xfffd, 1]);
});

test("UTF-8 encode: invalid runes become U+FFFD", () => {
  const bytes = (s: string) => [...s].map((c) => c.charCodeAt(0));
  expect(bytes(encodeRune(0x24))).toEqual([0x24]);
  expect(bytes(encodeRune(0x20ac))).toEqual([0xe2, 0x82, 0xac]);
  expect(bytes(encodeRune(0x10348))).toEqual([0xf0, 0x90, 0x8d, 0x88]);
  for (const r of [-1, 0xd800, 0xdfff, 0x110000])
    expect(bytes(encodeRune(r))).toEqual([0xef, 0xbf, 0xbd]);
  for (let r = 0; r < 0x11000; r += 7) {
    if (r >= 0xd800 && r <= 0xdfff) continue;
    const s = encodeRune(r);
    expect(decodeRune(s, 0)).toEqual([r, s.length]);
  }
});

// ---------------------------------------------------------------- maps

test("map iteration is insertion order; deletes removed; re-insert goes last", () => {
  const m = new GoMap(0, (k) => k);
  for (let i = 0; i < 100; i++) m.set(i, i * 2);
  for (let i = 0; i < 100; i += 2) m.delete(i); // triggers compaction
  m.set(0, 1);
  const it = new MapIter(m);
  const keys: number[] = [];
  for (let e = it.next(); e; e = it.next()) {
    keys.push(e.k);
    if (e.k === 1) m.set(1000, 0); // inserted during iteration: seen
    if (e.k === 3) for (let i = 5; i < 60; i += 2) m.delete(i); // compaction mid-iteration
  }
  const want = [1, 3, ...Array.from({ length: 20 }, (_, i) => 61 + 2 * i), 0, 1000];
  expect(keys).toEqual(want);
});

// ---------------------------------------------------------------- growslice

test("append growth matches Go 1.27 capacities", () => {
  const seq = (size: number, noscan: boolean, n: number) => {
    const caps: number[] = [];
    let cap = 0;
    for (let len = 1; len <= n; len++)
      if (len > cap) {
        cap = growCap(len, cap, size, noscan);
        caps.push(cap);
      }
    return caps;
  };
  // Heap-allocated []int, []byte, [](3 x int64) (from native runs).
  expect(seq(8, true, 2000)).toEqual([
    1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 848, 1280, 1792, 2560,
  ]);
  expect(seq(1, true, 3000)).toEqual([8, 16, 32, 64, 128, 256, 512, 896, 1408, 2048, 3072]);
  expect(seq(24, true, 300)).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 512]);
  expect(growCap(7, 3, 8, true)).toBe(8);
  expect(growCap(1, 0, 16, false)).toBe(1);
});

// ---------------------------------------------------------------- IR programs

/** A tiny program builder: types fixed, functions given as block lists. */
function program(
  funcs: {
    name: string;
    regTypes: number[];
    params?: number;
    blocks: Instr[][];
    recover?: number;
    sig?: number;
  }[],
): Program {
  const types: Type[] = [
    { k: "func", params: [], results: [], variadic: false, slots: 1 }, // 0
    { k: "int", int: "int64", name: "int", slots: 1 }, // 1
    { k: "string", slots: 1 }, // 2
    { k: "bool", slots: 1 }, // 3
    { k: "interface", methods: [], sigs: [], slots: 1 }, // 4 any
    {
      k: "named",
      name: "runtime.errorString",
      underlying: 2,
      slots: 1,
      methods: {},
      ptrMethods: {},
    }, // 5
    { k: "int", int: "int8", slots: 1 }, // 6
    { k: "func", params: [], results: [1], variadic: false, slots: 1 }, // 7
  ];
  return {
    version: 2,
    build: {},
    types,
    globals: [],
    init: 0,
    main: 1,
    entries: {},
    funcs: [
      {
        name: "init",
        sig: 0,
        params: 0,
        freeVars: 0,
        regs: 0,
        regTypes: [],
        blocks: [{ preds: [], succs: [], instrs: [{ op: "return", results: [] }] }],
        body: "ir",
        recover: -1,
      },
      ...funcs.map((f) => ({
        name: f.name,
        sig: f.sig ?? 0,
        params: f.params ?? 0,
        freeVars: 0,
        regs: f.regTypes.length,
        regTypes: f.regTypes,
        blocks: f.blocks.map((instrs, i) => {
          const last = instrs[instrs.length - 1]!;
          const succs = last.op === "jump" ? [i + 1] : last.op === "if" ? [i + 1, i + 2] : [];
          return { preds: [], succs, instrs };
        }),
        body: "ir" as const,
        recover: f.recover ?? -1,
      })),
    ],
  };
}

const int = (n: number) => ({ c: { i: String(n) }, t: 1 });
const str = (s: string) => ({ c: s, t: 2 });

function run(p: Program) {
  // Fill preds from succs.
  for (const f of p.funcs) {
    for (const b of f.blocks) b.preds = [];
    f.blocks.forEach((b, i) => b.succs.forEach((s) => f.blocks[s]!.preds.push(i)));
  }
  const m = new Machine(p);
  m.boot();
  m.run();
  return m;
}

test("division by zero panics with Go's message and exit 2", () => {
  const p = program([
    {
      name: "main",
      regTypes: [1],
      blocks: [
        [
          { op: "binop", dst: 0, t: 1, kind: "/", x: int(1), y: int(0) },
          { op: "return", results: [] },
        ],
      ],
    },
  ]);
  const r = run(p).result();
  expect(r.exit).toBe(2);
  // This tiny program has no Error method for errorString: printed as a custom type.
  expect(r.stderr.split("\n")[0]).toBe('panic: runtime.errorString("integer divide by zero")');
});

test("panic with a string, int8 and nested panics print like Go", () => {
  const mk = (v: any, t: number) =>
    program([
      {
        name: "main",
        regTypes: [4],
        blocks: [
          [
            { op: "makeInterface", dst: 0, t: 4, x: { c: v, t }, xt: t },
            { op: "panic", x: { r: 0 } },
          ],
        ],
      },
    ]);
  expect(run(mk("boom\nline2", 2)).result().stderr.split("\n\ngoroutine")[0]).toBe(
    "panic: boom\n\tline2",
  );
  expect(
    run(mk({ i: "-5" }, 6))
      .result()
      .stderr.split("\n")[0],
  ).toBe("panic: -5");
});

test("defer + recover: recovered panic returns from the Recover block", () => {
  // main: calls f (static) whose deferred closure recovers; prints result via println.
  const p = program([
    {
      name: "main",
      regTypes: [1],
      blocks: [
        [
          { op: "call", dst: 0, t: 1, callee: { static: 2 }, args: [] },
          { op: "call", callee: { builtin: "println" }, args: [str("got"), { r: 0 }] },
          { op: "return", results: [] },
        ],
      ],
    },
    {
      name: "f",
      sig: 7,
      regTypes: [4],
      blocks: [
        [
          { op: "defer", callee: { static: 3 }, args: [] },
          { op: "makeInterface", dst: 0, t: 4, x: str("x"), xt: 2 },
          { op: "panic", x: { r: 0 } },
        ],
        [{ op: "return", results: [int(42)] }],
      ],
      recover: 1,
    },
    {
      name: "f$1",
      regTypes: [4],
      blocks: [
        [
          { op: "call", dst: 0, t: 4, callee: { builtin: "recover" }, args: [] },
          { op: "return", results: [] },
        ],
      ],
    },
  ]);
  // Block 0 of f ends in panic (no succs); block 1 is the Recover block.
  const r = run(p).result();
  expect(r.stderr).toBe("got 42\n");
  expect(r.exit).toBe(0);
});

test("snapshot at every op count resumes to the same result", () => {
  // Loop: sum 0..99 with phis, printing the total.
  const p = program([
    {
      name: "main",
      regTypes: [1, 1, 3, 1, 1],
      blocks: [
        [{ op: "jump" }],
        [
          { op: "phi", dst: 0, t: 1, edges: [int(0), { r: 3 }] },
          { op: "phi", dst: 1, t: 1, edges: [int(0), { r: 4 }] },
          { op: "binop", dst: 2, t: 3, kind: "<", x: { r: 0 }, y: int(100) },
          { op: "if", cond: { r: 2 } },
        ],
        [
          { op: "binop", dst: 3, t: 1, kind: "+", x: { r: 0 }, y: int(1) },
          { op: "binop", dst: 4, t: 1, kind: "+", x: { r: 1 }, y: { r: 0 } },
          { op: "jump" },
        ],
        [
          { op: "call", callee: { builtin: "println" }, args: [{ r: 1 }] },
          { op: "return", results: [] },
        ],
      ],
    },
  ]);
  const f = p.funcs[1]!;
  f.blocks[2]!.succs = [1];
  f.blocks[1]!.succs = [2, 3];
  const full = run(p).result();
  expect(full.stderr).toBe("4950\n");
  for (let at = 0; at < full.ops; at += 37) {
    const m = new Machine(p);
    m.boot();
    expect(m.run(at)).toBe("paused");
    const snap = JSON.parse(JSON.stringify(snapshot(m, "x")));
    const m2 = restore(p, snap);
    m2.run();
    expect(m2.result()).toEqual(full);
    expect(JSON.stringify(m2.opStats().byKind)).toBe(JSON.stringify(run(p).opStats().byKind));
  }
});

test("interface equality on uncomparable dynamic types panics", () => {
  const p = program([]);
  p.types.push({ k: "slice", elem: 1, slots: 1 });
  const T = new Types(p);
  expect(() => T.ifaceEq({ t: 8, v: null } as any, { t: 8, v: null } as any)).toThrow();
});
