// Measure the type-level integer operations (src/types/int.ts): instantiations
// per operation from stock tsrs `--extendedDiagnostics`, over a file of many
// distinct cases of one operation minus a baseline file with the same
// assertions on literals (the method of lua-in-types' bench-aot-int64.ts).
//
//   scripts/heavy.sh node scripts/bench-int.ts [copies] [--noise N] [--only Op,Op]
//
// Columns (operand values; the kind used):
//   1     both operands one nibble (-8..7), i64
//   byte  uint8 values 0..255 (one or two nibbles), u8
//   idx   int values 0..255 (one to three nibbles), i64
//   i16   int16 values 0..400 (ast.Kind-like), i16
//   32    full-width int32 / uint32 (random sign, 8 nibbles), i32 / u32
//   64    full-width int64 / uint64 (16 nibbles), i64 / u64
// `--noise N` adds N unrelated live types (a forced 16-wide trie of N slot
// tuples) to both files: per-op cost must not change.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BinOpKind, IntKind } from "../src/ir/types.ts";
import { WIDTH, type I64 } from "../src/ref/values.ts";
import { intTag, intToType } from "../src/types/codec-int.ts";
import { OPNAME, expected, rng } from "./gen-int-tests.ts";
import { refBinop, refConv, refUnop, refValue } from "./int-ref.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DIR = resolve(ROOT, ".run/bench-int");
const TSRS = resolve(ROOT, "node_modules/.bin/tsrs");
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const NOISE = Number(flag("--noise") ?? 0);
const ONLY = flag("--only")?.split(",");
const COPIES = Number(args[0] ?? 200);
const lit = (s: string) => JSON.stringify(s);
const random = rng(4242);

type Col = { label: string; kind: (signed: boolean) => IntKind; value: (k: IntKind) => I64 };
const small = (lo: number, hi: number) => (k: IntKind) =>
  refValue(BigInt(lo + Math.floor(random() * (hi - lo + 1))), k);
/** A random full-width value (top nibble nonzero) of kind k. */
const full = (k: IntKind) => {
  for (;;) {
    let x = 0n;
    for (let i = 0; i < WIDTH[k]; i++) x = (x << 1n) | (random() < 0.5 ? 1n : 0n);
    const v = refValue(x, k);
    if (intToType(v, k).length === WIDTH[k] / 4) return v;
  }
};
const COLS: Col[] = [
  { label: "1", kind: (s) => (s ? "int64" : "uint64"), value: small(-8, 7) },
  { label: "byte", kind: () => "uint8", value: small(0, 255) },
  { label: "idx", kind: (s) => (s ? "int64" : "uint64"), value: small(0, 255) },
  { label: "i16", kind: () => "int16", value: small(0, 400) },
  { label: "32", kind: (s) => (s ? "int32" : "uint32"), value: full },
  { label: "64", kind: (s) => (s ? "int64" : "uint64"), value: full },
];

type Case = [expr: string, expected: string];
type Bench = { name: string; make: (c: Col) => Case | undefined };

const bin = (op: BinOpKind, signed = true): Bench => ({
  name: `${OPNAME[op]}${signed ? "" : " (u)"}`,
  make: (c) => {
    const k = c.kind(signed);
    const a = c.value(k);
    let b = c.value(k);
    if ((op === "/" || op === "%") && b === 0) b = refValue(3n, k);
    const tag = lit(intTag(k));
    const A = lit(intToType(a, k));
    const B = lit(intToType(b, k));
    const expr =
      op === "==" || op === "!="
        ? `I.${OPNAME[op]}<${A}, ${B}>`
        : `I.${OPNAME[op]}<${tag}, ${A}, ${B}>`;
    return [expr, expected(refBinop(op, k, a, b), k)];
  },
});
const shift = (op: "<<" | ">>", signed = true): Bench => ({
  name: `${OPNAME[op]}${signed ? "" : " (u)"}`,
  make: (c) => {
    const k = c.kind(signed);
    const a = c.value(k);
    const n = refValue(BigInt(1 + Math.floor(random() * (WIDTH[k] - 1))), "uint64");
    const expr = `I.${OPNAME[op]}<${lit(intTag(k))}, ${lit(intToType(a, k))}, "u64", ${lit(intToType(n, "uint64"))}>`;
    return [expr, expected(refBinop(op, k, a, n), k)];
  },
});
const unary = (name: string, f: (k: IntKind, a: I64) => [string, string]): Bench => ({
  name,
  make: (c) => {
    const k = c.kind(true);
    const [expr, exp] = f(k, c.value(k));
    return [expr, exp];
  },
});

const BENCHES: Bench[] = [
  bin("+"),
  bin("-"),
  bin("*"),
  bin("*", false),
  bin("/"),
  bin("/", false),
  bin("%"),
  bin("%", false),
  bin("&"),
  bin("|"),
  bin("^"),
  bin("&^"),
  shift("<<"),
  shift(">>"),
  shift(">>", false),
  bin("=="),
  bin("<"),
  bin("<", false),
  bin("<="),
  unary("Neg", (k, a) => [
    `I.Neg<${lit(intTag(k))}, ${lit(intToType(a, k))}>`,
    expected(refUnop("-", k, a), k),
  ]),
  unary("Not", (k, a) => [
    `I.Not<${lit(intTag(k))}, ${lit(intToType(a, k))}>`,
    expected(refUnop("^", k, a), k),
  ]),
  unary("Conv to u8", (k, a) => [
    `I.Conv<${lit(intTag(k))}, "u8", ${lit(intToType(a, k))}>`,
    expected(refConv(k, "uint8", a), "uint8"),
  ]),
  unary("Conv u-ext", (k, a) => {
    const u = (k.startsWith("u") ? k : `u${k}`) as IntKind;
    const v = refConv(k, u, a);
    return [
      `I.Conv<${lit(intTag(u))}, "i64", ${lit(intToType(v, u))}>`,
      expected(refConv(u, "int64", v), "int64"),
    ];
  }),
  unary("ToDec", (k, a) => [`I.ToDec<${lit(intTag(k))}, ${lit(intToType(a, k))}>`, lit(String(a))]),
];

function noiseSource(n: number): string {
  if (n === 0) return "";
  // N slot tuples in a 16-wide trie of tuples, forced by an exported alias.
  const leaves: string[] = [];
  for (let i = 0; i < n; i++) leaves.push(`["${i.toString(16)}", ${i % 7}, "x${i}"]`);
  let level = leaves;
  let id = 0;
  const decls: string[] = [];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 16) {
      const name = `N${id++}`;
      decls.push(`type ${name} = [${level.slice(i, i + 16).join(", ")}];`);
      next.push(name);
    }
    level = next;
  }
  return `${decls.join("\n")}\nexport type Noise = ${level[0]};\nexport type NoiseUse = Noise extends [infer _A, ...infer _R] ? 1 : 0;\n`;
}

function file(cases: Case[], baseline: boolean): string {
  const lines = cases.map(
    ([e, x], i) => `export type B${i} = Assert<Equal<${baseline ? x : e}, ${x}>>;`,
  );
  return `import type * as I from "../../src/types/int.ts";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
${baseline ? "export type Keep = I.W;\n" : ""}${noiseSource(NOISE)}
${lines.join("\n")}
`;
}

function instantiations(path: string): number {
  const out = execFileSync(
    TSRS,
    [
      "--ignoreConfig",
      "--noEmit",
      "--fast",
      "--extendedDiagnostics",
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
  if (/error TS/.test(out))
    throw new Error(`${path}: ${out.split("\n").find((l) => /error TS/.test(l))}`);
  return Number(/Instantiations:\s+(\d+)/.exec(out)![1]);
}

mkdirSync(DIR, { recursive: true });
const rows: string[][] = [];
for (const b of BENCHES) {
  if (ONLY && !ONLY.includes(b.name)) continue;
  const row = [b.name];
  for (const c of COLS) {
    const cases: Case[] = [];
    const seen = new Set<string>();
    for (let tries = 0; cases.length < COPIES && tries < COPIES * 20; tries++) {
      const x = b.make(c);
      if (!x || seen.has(x[0])) continue;
      seen.add(x[0]);
      cases.push(x);
    }
    if (cases.length === 0) {
      row.push("");
      continue;
    }
    const tag = `${b.name.replace(/\W+/g, "_")}-${c.label}`;
    const p = resolve(DIR, `${tag}.ts`);
    const q = resolve(DIR, `${tag}-base.ts`);
    writeFileSync(p, file(cases, false));
    writeFileSync(q, file(cases, true));
    const per = (instantiations(p) - instantiations(q)) / cases.length;
    row.push(per.toFixed(0) + (cases.length < COPIES ? `*` : ""));
  }
  rows.push(row);
  console.error(row.join("\t"));
}
const head = ["op", ...COLS.map((c) => c.label)];
const md = [head, head.map(() => "---"), ...rows].map((r) => `| ${r.join(" | ")} |`).join("\n");
console.log(`copies ${COPIES}, noise ${NOISE}\n\n${md}`);
