// Fuzz the type-level integers (src/types/int.ts) against the reference
// (scripts/int-ref.ts over src/ref/values.ts): random ops, kinds and
// operands of every size (one nibble, bytes, short forms up to 2047, powers
// of two, edges, full width), checked by tsrs as assertions.
//
//   scripts/heavy.sh node scripts/fuzz-int.ts [--seed S] [--n N]
//
// Writes .run/fuzz-int/fuzz-<seed>.ts; prints each failing case and exits 1
// on any mismatch.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BinOpKind, IntKind } from "../src/ir/types.ts";
import { WIDTH, type I64 } from "../src/ref/values.ts";
import { intTag, intToType } from "../src/types/codec-int.ts";
import { binExpr, edges, expected, randomValue, rng } from "./gen-int-tests.ts";
import { KINDS, refBinop, refConv, refUnop, refValue } from "./int-ref.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DIR = resolve(ROOT, ".run/fuzz-int");
const args = process.argv.slice(2);
const opt = (name: string, d: number) => {
  const i = args.indexOf(name);
  return i < 0 ? d : Number(args[i + 1]);
};
const SEED = opt("--seed", 1);
const N = opt("--n", 20000);
const random = rng(SEED);
const pick = <T>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)]!;
const lit = (s: string) => JSON.stringify(s);

/** An operand of kind k from a mix of sizes. */
function operand(k: IntKind): I64 {
  const w = WIDTH[k];
  switch (Math.floor(random() * 7)) {
    case 0:
      return refValue(BigInt(Math.floor(random() * 16) - 8), k);
    case 1:
      return refValue(BigInt(Math.floor(random() * 384) - 128), k);
    case 2:
      return refValue(BigInt(Math.floor(random() * 4096) - 2048), k);
    case 3: {
      const j = BigInt(Math.floor(random() * w));
      return refValue(
        (random() < 0.5 ? 1n : -1n) * (1n << j) + BigInt(Math.floor(random() * 3) - 1),
        k,
      );
    }
    case 4:
      return pick(edges(k));
    default:
      return randomValue(random, k);
  }
}

const BINOPS: BinOpKind[] = [
  "+",
  "-",
  "*",
  "/",
  "%",
  "&",
  "|",
  "^",
  "&^",
  "<<",
  ">>",
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
];

const cases: [string, string][] = [];
for (let i = 0; i < N; i++) {
  const k = pick(KINDS);
  const r = random();
  if (r < 0.75) {
    const op = pick(BINOPS);
    const a = operand(k);
    if (op === "<<" || op === ">>") {
      const ck = pick(KINDS);
      const c =
        random() < 0.8 ? refValue(BigInt(Math.floor(random() * (WIDTH[k] + 4))), ck) : operand(ck);
      cases.push([binExpr(op, k, a, c, ck), expected(refBinop(op, k, a, c), k)]);
    } else {
      const b = operand(k);
      cases.push([binExpr(op, k, a, b), expected(refBinop(op, k, a, b), k)]);
    }
  } else if (r < 0.85) {
    const a = operand(k);
    const u = pick(["-", "^"] as const);
    cases.push([
      `I.${u === "-" ? "Neg" : "Not"}<${lit(intTag(k))}, ${lit(intToType(a, k))}>`,
      expected(refUnop(u, k, a), k),
    ]);
  } else if (r < 0.95) {
    const to = pick(KINDS);
    const a = operand(k);
    cases.push([
      `I.Conv<${lit(intTag(k))}, ${lit(intTag(to))}, ${lit(intToType(a, k))}>`,
      expected(refConv(k, to, a), to),
    ]);
  } else {
    const a = operand(k);
    cases.push([`I.ToDec<${lit(intTag(k))}, ${lit(intToType(a, k))}>`, lit(String(a))]);
  }
}

mkdirSync(DIR, { recursive: true });
const path = resolve(DIR, `fuzz-${SEED}.ts`);
const HEAD = 4;
writeFileSync(
  path,
  `import type * as I from "../../src/types/int.ts";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
${cases.map(([e, x], i) => `export type F${i} = Assert<Equal<${e}, ${x}>>;`).join("\n")}
`,
);
let out = "";
try {
  out = execFileSync(
    resolve(ROOT, "node_modules/.bin/tsrs"),
    [
      "--ignoreConfig",
      "--noEmit",
      "--fast",
      "--strict",
      "--skipLibCheck",
      "--allowImportingTsExtensions",
      "--module",
      "nodenext",
      "--types",
      "",
      path,
    ],
    { encoding: "utf8", env: { ...process.env, TSRS_FAST: "1" }, maxBuffer: 1 << 26 },
  );
} catch (e) {
  out = (e as { stdout: string }).stdout;
}
const bad = new Set<number>();
for (const m of out.matchAll(/fuzz-\d+\.ts\((\d+),\d+\): error (TS\d+)/g))
  bad.add(Number(m[1]) - HEAD);
const other = out.split("\n").filter((l) => /error TS/.test(l) && !/fuzz-\d+\.ts\(/.test(l));
for (const i of bad) console.log(`FAIL ${cases[i]?.[0]} expected ${cases[i]?.[1]}`);
for (const l of other) console.log(l);
console.log(`seed ${SEED}: ${N - bad.size}/${N} pass`);
process.exit(bad.size || other.length ? 1 : 0);
