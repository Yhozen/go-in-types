import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vite-plus/test";
import { WIDTH, isSigned, type I64 } from "../../src/ref/values.ts";
import {
  constIntLiteral,
  decodeInt64,
  encodeInt64,
  intFromType,
  intLiteral,
  intTag,
  intToType,
  parseIntLiteral,
} from "../../src/types/codec.ts";
import { tablesSource } from "../../scripts/gen-int-tables.ts";
import { edges, randomValue, rng, testFiles } from "../../scripts/gen-int-tests.ts";
import { KINDS, refBinop, refConv, refUnop } from "../../scripts/int-ref.ts";

const ROOT = resolve(import.meta.dirname, "../..");

test("encoding examples from DESIGN.md", () => {
  expect(intToType(0, "int64")).toBe("0");
  expect(intToType(-1, "int64")).toBe("f");
  expect(intToType(8, "int64")).toBe("80");
  expect(intToType(255, "uint8")).toBe("f");
  expect(intToType(2n ** 64n - 1n, "uint64")).toBe("f");
  expect(intToType(-2, "int16")).toBe("e");
  expect(intToType(200, "uint8")).toBe("8c");
  expect(intToType(200, "int16")).toBe("8c0");
  expect(intToType(-(2n ** 63n), "int64")).toBe("0000000000000008");
  expect(intTag("uint16")).toBe("u16");
  expect(intLiteral(128, "int32")).toBe('"080"');
  expect(constIntLiteral({ i: "-129" }, "int16")).toBe('"f7f"');
});

test("codec round trip on every kind", () => {
  const random = rng(7);
  for (const k of KINDS) {
    const vals = [...edges(k)];
    for (let i = 0; i < 500; i++) vals.push(randomValue(random, k));
    for (const v of vals) {
      const s = intToType(v, k);
      expect(intFromType(s, k)).toBe(v);
      expect(parseIntLiteral(JSON.stringify(s), k)).toBe(v);
      expect(encodeInt64(decodeInt64(s))).toBe(s);
      // 64-bit reference values are numbers when safe, else bigints.
      if (WIDTH[k] < 64) expect(typeof v).toBe("number");
    }
  }
});

test("codec rejects forms outside the kind or not canonical", () => {
  expect(() => intFromType("080", "int8")).toThrow();
  expect(() => intFromType("080", "uint8")).toThrow();
  expect(() => intFromType("00", "int8")).toThrow();
  expect(() => intFromType("F", "int8")).toThrow();
  expect(() => intFromType("", "int8")).toThrow();
  expect(() => decodeInt64("00000000000000080")).toThrow();
  expect(() => parseIntLiteral("12", "int8")).toThrow();
});

/** An independent bigint oracle for the reference wrapper (Go semantics). */
function oracle(op: string, k: (typeof KINDS)[number], a: I64, b: I64): I64 | boolean | string {
  const w = WIDTH[k];
  const s = isSigned(k);
  const fix = (x: bigint): I64 => {
    const r = s ? BigInt.asIntN(w, x) : BigInt.asUintN(w, x);
    return w < 64 || (r >= -(2n ** 53n - 1n) && r <= 2n ** 53n - 1n) ? Number(r) : r;
  };
  const A = BigInt(a);
  const B = BigInt(b);
  switch (op) {
    case "+":
      return fix(A + B);
    case "-":
      return fix(A - B);
    case "*":
      return fix(A * B);
    case "/":
      return B === 0n ? "panic" : fix(A / B);
    case "%":
      return B === 0n ? "panic" : fix(A % B);
    case "&":
      return fix(A & B);
    case "|":
      return fix(A | B);
    case "^":
      return fix(A ^ B);
    case "&^":
      return fix(A & ~B);
    case "<":
      return A < B;
    case "==":
      return A === B;
  }
  throw new Error(op);
}

test("the reference wrapper agrees with a bigint oracle", () => {
  const random = rng(99);
  for (const k of KINDS) {
    const vals = [...edges(k)];
    for (let i = 0; i < 40; i++) vals.push(randomValue(random, k));
    for (const a of vals)
      for (const b of vals.slice(0, 20))
        for (const op of ["+", "-", "*", "/", "%", "&", "|", "^", "&^", "<", "=="] as const) {
          const r = refBinop(op, k, a, b);
          const o = oracle(op, k, a, b);
          expect(typeof r === "object" ? "panic" : r).toBe(o);
        }
    for (const a of vals) {
      expect(BigInt(refUnop("-", k, a))).toBe(BigInt(oracle("-", k, 0, a) as I64));
      for (const to of KINDS) {
        const tw = WIDTH[to];
        const x = BigInt(refConv(k, to, a));
        expect(x).toBe(isSigned(to) ? BigInt.asIntN(tw, BigInt(a)) : BigInt.asUintN(tw, BigInt(a)));
      }
    }
  }
});

test("generated tables and tests are up to date", () => {
  expect(readFileSync(resolve(ROOT, "src/types/int-tables.gen.ts"), "utf8")).toBe(tablesSource());
  for (const [path, src] of testFiles())
    expect(readFileSync(resolve(ROOT, path), "utf8"), path).toBe(src);
});
