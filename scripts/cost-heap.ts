// H5 cost test for the type-level heap (docs/stage0/HEAP.md): every
// primitive of src/types/heap.ts in an alias-argument loop over a heap of
// 256 + N live objects, at N = 0, 1k, 10k, 100k, on stock tsrs. Cost per op
// is (inst(2K) - inst(K)) / K. Fails (exit 1) if any op's cost grows with N.
//
//   scripts/heavy.sh node scripts/cost-heap.ts [--k 100] [--n 0,1024,10240,102400]
//       [--ops load1,store1,...] [--jobs 1] [--out .run/cost-heap.json] [--long]
//       [--tsrs PATH] [--diag PATH]
//
// --long: also the long run (50k writes in 100 chained statements of 500 on
// a 102k-object heap). --diag: the instrumented tsrs of
// experiments/stage0/heap (TSRS_HEAPDIAG=1) for walk/op and rel/op.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1]! : d;
};
const K = Number(opt("k", "100"));
const NS = opt("n", "0,1024,10240,102400").split(",").map(Number);
const jobs = Number(opt("jobs", "1"));
const outFile = opt("out", join(repo, ".run/cost-heap.json"));
const tsrs = opt("tsrs", join(repo, "node_modules/.bin/tsrs"));
const diag = opt("diag", "");
const long = argv.includes("--long");
const work = join(repo, ".run/cost-heap");
mkdirSync(work, { recursive: true });

const HEX = "0123456789abcdef";
const hex = (v: number, w: number) => v.toString(16).padStart(w, "0");
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
/** canonical int encoding of n >= 0 */
const nib = (n: number) => {
  if (n === 0) return "0";
  let s = "";
  while (n > 0) {
    s += HEX[n % 16];
    n = Math.floor(n / 16);
  }
  return parseInt(s[s.length - 1]!, 16) >= 8 ? s + "0" : s;
};
const q = (s: string) => JSON.stringify(s);

/** Lazy working-set objects: ids 0x00100 + j (inside block 001), 4096 slots, depth 3. */
const LAZY = 16;
const LAZY_SLOTS = 4096;

interface Op {
  /** heap after the step (H, I, A in scope; T = target id; V = step value) */
  h?: string;
  /** accumulator after the step */
  a?: string;
  /** a 2-result op: R = [heap, acc] */
  r?: string;
  /** initial accumulator */
  a0?: string;
  /** final check: type that must equal `expect` */
  chk?: (last: number) => [string, string];
}

const ops: Record<string, Op> = {
  none: { a0: q("x") },
  load1: {
    a: `H.Load1<H, H.PtrMk<T, "1">, "0">`,
    a0: q("x"),
    chk: (l) => [`Res[1]`, q(`v${tgtId(l)}`)],
  },
  store1: {
    h: `H.Store1<H, H.PtrMk<T, "1">, V>`,
    a0: q("x"),
    chk: (l) => [`H.Load1<Res[0], H.PtrMk<${q(tgtId(l))}, "1">, "0">`, q(`w${l}`)],
  },
  loadK: {
    a: `H.LoadK<H, H.PtrMk<T, "0">, ["0", "0", "0", "0"]>`,
    a0: q("x"),
    chk: (l) => [`Res[1][1]`, q(`v${tgtId(l)}`)],
  },
  storeK: {
    h: `H.StoreK<H, H.PtrMk<T, "2">, [V, V, V, V]>`,
    a0: q("x"),
    chk: (l) => [`H.Load1<Res[0], H.PtrMk<${q(tgtId(l))}, "5">, "0">`, q(`w${l}`)],
  },
  alloc: {
    h: `H.Alloc<H, H.Flat<V, "0", "0", null>>`,
    a0: q("x"),
    chk: (l) => [`H.Load1<Res[0], H.PtrMk<${q(allocId(l))}, "0">, "0">`, q(`w${l}`)],
  },
  allocLazy: {
    h: `H.AllocLazy<H, "001", [V]>`,
    a0: q("x"),
    chk: (l) => [`H.Load1<Res[0], H.PtrMk<${q(allocId(l))}, "0">, "z">`, q("z")],
  },
  lazyLoad1: {
    a: `H.Load1<H, H.PtrMk<LT, LS>, "z">`,
    a0: q("x"),
    chk: () => [`Res[1]`, q("z")],
  },
  lazyStore1: {
    h: `H.Store1<H, H.PtrMk<LT, LS>, V>`,
    a0: q("x"),
    chk: (l) => [`H.Load1<Res[0], H.PtrMk<${q(lazyId(l))}, ${q(lazySlot(l))}>, "z">`, q(`w${l}`)],
  },
  fieldAddr: {
    a: `H.FieldAddr<H.PtrMk<T, Ix>, "3">`,
    a0: q("x"),
    chk: (l) => [`Res[1][0]`, q(tgtId(l))],
  },
  indexAddr: {
    a: `H.IndexCk<Ix, "0001"> extends true ? H.SliceIndexAddr<H.SliceMk<LT, "0", "0001", "0001">, Ix, "3"> : never`,
    a0: q("x"),
    chk: (l) => [`Res[1][0]`, q(lazyId(l))],
  },
  slice: {
    a: `H.SliceS<H.SliceMk<LT, "0", "0001", "0001">, Ix, "0080", null, "1">`,
    a0: q("x"),
    chk: (l) => [`Res[1][2]`, q(nib(2048 - l))],
  },
  makeSlice: {
    h: `H.MakeSlice<H, Ix, "1", ["0"]>`,
    a0: q("x"),
    chk: (l) => [`H.Load1<Res[0], H.PtrMk<${q(allocId(l))}, "0">, "z">`, q("z")],
  },
  // in-place append into the lazy working set (cap 4096, len = step index)
  append: {
    r: `H.AppendVals<H, H.SliceMk<LT, "0", Ix, "0001">, [V], "1", "1", ["0"], "80", true>`,
    a0: q("x"),
    chk: (l) => [`Res[1][2]`, q(nib(l + 1))],
  },
  // one growing slice: in-place appends and growths, amortised (fast-path regrow)
  appendGrow: {
    r: `H.AppendVals<H, A, [V], "1", "1", ["0"], "80", true>`,
    a0: `null`,
    chk: (l) => [`Res[1][2]`, q(nib(l + 1))],
  },
  copy: {
    h: `H.Copy<H, H.SliceMk<LT, Ix, "4", "4">, H.SliceMk<LT2, "0", "4", "4">, "1", ["0"]>`,
    a0: q("x"),
    chk: () => [`Res[1]`, q("x")],
  },
  eq: {
    a: `H.Eq<H.MakeIface<"1", [V, "0"]>, H.MakeIface<"1", [V, "0"]>, "i", P>`,
    a0: q("x"),
    chk: () => [`Res[1]`, `true`],
  },
  assertT: {
    a: `H.AssertT<H.MakeIface<"1", V>, "1", "2", P>`,
    a0: q("x"),
    chk: (l) => [`Res[1]`, q(`w${l}`)],
  },
  assertI: {
    a: `H.AssertI<H.MakeIface<"1", V>, "3", P>`,
    a0: q("x"),
    chk: (l) => [`Res[1][1]`, q(`w${l}`)],
  },
};
const tgt = (i: number) => (i * 97 + 13) % 256;
const tgtId = (i: number) => hex(tgt(i), 5);
let allocBase = 0;
const allocId = (i: number) => hex(allocBase + i, 5);
const lazyId = (i: number) => hex(0x100 + (i % LAZY), 5);
const lazy2Id = (i: number) => hex(0x100 + ((i + 1) % LAZY), 5);
const lazySlot = (i: number) => nib((i * 131 + 7) % LAZY_SLOTS);

function generate(op: string, n: number, k: number): string {
  const o = ops[op]!;
  const out: string[] = [];
  const w = (s: string) => out.push(s);
  w(`// GENERATED by scripts/cost-heap.ts ${JSON.stringify({ op, n, k })}`);
  w(`import type * as H from "../../src/types/heap.ts";`);
  w(`import type { E2, E3, E4, Mk16 } from "../../src/types/heap.gen.ts";`);
  w(`export {};`);
  // program tables for interface ops
  w(`interface PImpl { "1:3": true; }`);
  w(`interface PNames { "1": "main.T"; "2": "interface {}"; "3": "main.I"; }`);
  w(`interface PMissing { }`);
  w(`interface PEqk { "1": ["=", "="]; }`);
  w(`interface P { impl: PImpl; names: PNames; missing: PMissing; eqk: PEqk; }`);
  // objects: flat [id, v<id>, "0" ...]; lazy objects at 0x100..0x10f
  w(`type Obj<Id extends string> = H.Flat<Id, \`v\${Id}\`, "0", "0", "0", "0", "0", "0">;`);
  w(`type LObj = H.NewLazy<"0001", ["0"]>;`);
  w(
    `type Full1<Q extends string> = Mk16<${HEX.split("")
      .map((d) => `Obj<\`\${Q}${d}\`>`)
      .join(", ")}>;`,
  );
  w(
    `type Full2<P extends string> = Mk16<${HEX.split("")
      .map((d) => `Full1<\`\${P}${d}\`>`)
      .join(", ")}>;`,
  );
  w(
    `type Lazy2 = Mk16<${range(16)
      .map(() => "LObj")
      .join(", ")}>;`,
  );
  w(
    `type LBlock = Mk16<Lazy2, ${range(15)
      .map(() => "Full1<'0010'>")
      .join(", ")}>;`,
  );
  const blocks = 1 + n / 256 + 1; // working set, lazy block (001), n/256 others
  for (let b = 0; b < blocks; b++)
    w(b === 1 ? `type B_${hex(b, 3)} = LBlock;` : `type B_${hex(b, 3)} = Full2<"${hex(b, 3)}">;`);
  const has = (p: string) => parseInt(p.padEnd(3, "0"), 16) < blocks;
  for (let a = 0; a < 16; a++)
    for (let b = 0; b < 16; b++) {
      const p = HEX[a]! + HEX[b]!;
      if (has(p))
        w(
          `type L_${p} = Mk16<${HEX.split("")
            .map((d) => (has(p + d) ? `B_${p}${d}` : "E2"))
            .join(", ")}>;`,
        );
    }
  for (let a = 0; a < 16; a++) {
    const p = HEX[a]!;
    if (has(p))
      w(
        `type L_${p} = Mk16<${HEX.split("")
          .map((d) => (has(p + d) ? `L_${p}${d}` : "E3"))
          .join(", ")}>;`,
      );
  }
  w(
    `type Root = Mk16<${HEX.split("")
      .map((d) => (has(d) ? `L_${d}` : "E4"))
      .join(", ")}>;`,
  );
  allocBase = blocks * 256;
  w(`type H0 = H.HeapMk<"${hex(allocBase, 5)}", Root>;`);
  const tok = (i: number) => (i >= k ? "end" : `s${i}`);
  const tab = (name: string, f: (i: number) => string) =>
    w(
      `interface ${name} { ${range(k)
        .map((i) => `${tok(i)}: ${f(i)};`)
        .join(" ")} }`,
    );
  tab("Seq", (i) => q(tok(i + 1)));
  tab("Tgt", (i) => q(tgtId(i)));
  tab("Val", (i) => q(`w${i}`));
  tab("IxT", (i) => q(nib(i)));
  tab("LTg", (i) => q(lazyId(i)));
  tab("LTg2", (i) => q(lazy2Id(i)));
  tab("LSl", (i) => q(lazySlot(i)));
  w(`type At<T, I> = I extends keyof T ? T[I] : never;`);
  const sub = (s: string) =>
    s
      .replaceAll("LT2", "At<LTg2, I>")
      .replace(/\bT\b/g, "At<Tgt, I>")
      .replace(/\bV\b/g, "At<Val, I>")
      .replace(/\bIx\b/g, "At<IxT, I>")
      .replace(/\bLT\b/g, "At<LTg, I>")
      .replace(/\bLS\b/g, "At<LSl, I>");
  const nx = `At<Seq, I>`;
  if (o.r) {
    w(`type Loop<H, I, A> = I extends "end" ? [H, A] : LoopR<${sub(o.r)}, I>;`);
    w(`type LoopR<R, I> = Loop<R["0" & keyof R], ${nx}, R["1" & keyof R]>;`);
  } else
    w(
      `type Loop<H, I, A> = I extends "end" ? [H, A] : Loop<${o.h ? sub(o.h) : "H"}, ${nx}, ${o.a ? sub(o.a) : "A"}>;`,
    );
  w(`type Res = Loop<H0, "s0", ${o.a0 ?? q("x")}>;`);
  const [chk, expect] = o.chk ? o.chk(k - 1) : [`Res[1]`, o.a0 ?? q("x")];
  w(`type Chk = ${chk};`);
  w(`export const ok: [${expect}] = null! as [Chk];`);
  w(`type IsAnyOrNever<T> = [T] extends [never] ? true : 0 extends 1 & T ? true : false;`);
  w(`export const notAny: false = null! as IsAnyOrNever<Chk>;`);
  return out.join("\n") + "\n";
}

function generateLong(n: number, k: number, rounds: number): string {
  // reuse the store1 file layout, with chained statements of k writes each
  const base = generate("store1", n, k).split("\n");
  const cut = base.findIndex((l) => l.startsWith("type Loop<"));
  const out = base.slice(0, cut);
  out.push(
    `type LoopR<H, I, Rd extends string> = I extends "end" ? [H] : LoopR<H.Store1<H, H.PtrMk<At<Tgt, I>, "1">, \`\${Rd}\${At<Val, I> & string}\`>, At<Seq, I>, Rd>;`,
  );
  for (let r = 1; r <= rounds; r++)
    out.push(`type Res_${r} = LoopR<${r === 1 ? "H0" : `Res_${r - 1}[0]`}, "s0", "r${r}">;`);
  out.push(`type Chk = H.Load1<Res_${rounds}[0], H.PtrMk<${q(tgtId(k - 1))}, "1">, "0">;`);
  out.push(`export const ok: [${q(`r${rounds}w${k - 1}`)}] = null! as [Chk];`);
  return out.join("\n") + "\n";
}

type Run = { inst: number; mem: number; check: number; errors: string; out: string };
function runOne(file: string, bin = tsrs, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((res) => {
    const p = spawn(
      bin,
      [
        "--ignoreConfig",
        "--fast",
        "--singleThreaded",
        "--extendedDiagnostics",
        "--noEmit",
        "--types",
        "",
        "--lib",
        "es2023",
        "--strict",
        "--module",
        "nodenext",
        "--allowImportingTsExtensions",
        file,
      ],
      { env: { ...process.env, TSRS_FAST: "1", ...env } },
    );
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), 600_000);
    p.on("close", () => {
      clearTimeout(timer);
      const num = (re: RegExp) => Number(out.match(re)?.[1] ?? NaN);
      const inst = num(/^Instantiations:\s+(\d+)/m);
      const errors = out
        .split("\n")
        .filter((l) => /error TS/.test(l))
        .slice(0, 3)
        .join(" | ");
      res({
        inst,
        mem: num(/^Memory used:\s+(\d+)K/m),
        check: num(/^Check time:\s+([\d.]+)s/m),
        errors: Number.isNaN(inst) ? "timeout/crash " + errors : errors,
        out,
      });
    });
  });
}

const diagNum = (out: string, key: string) =>
  Number(out.match(new RegExp(`${key}[^\\d]*(\\d+)`))?.[1] ?? NaN);

async function cell(op: string, n: number) {
  const f1 = join(work, `${op}-${n}-${K}.ts`);
  const f2 = join(work, `${op}-${n}-${2 * K}.ts`);
  writeFileSync(f1, generate(op, n, K));
  writeFileSync(f2, generate(op, n, 2 * K));
  const [a, b] = [await runOne(f1), await runOne(f2)];
  const row: Record<string, unknown> = {
    op,
    n,
    perOp: (b.inst - a.inst) / K,
    errors: [a.errors, b.errors].filter(Boolean).join(" | "),
    check2K: b.check,
    mem2K: b.mem,
  };
  if (diag) {
    const env = { TSRS_HEAPDIAG: "1" };
    const [da, db] = [await runOne(f1, diag, env), await runOne(f2, diag, env)];
    const walk = (o: string) => diagNum(o, "inst_permissive") + diagNum(o, "inst_restrictive");
    row.walkPerOp = (walk(db.out) - walk(da.out)) / K;
    row.relPerOp = (diagNum(db.out, "relation") - diagNum(da.out, "relation")) / K;
  }
  return row;
}

async function main() {
  const which = opt("ops", Object.keys(ops).join(",")).split(",");
  const cells: [string, number][] = [];
  for (const op of which) for (const n of NS) cells.push([op, n]);
  const rows: Record<string, unknown>[] = [];
  let next = 0;
  await Promise.all(
    range(jobs).map(async () => {
      while (next < cells.length) {
        const [op, n] = cells[next++]!;
        const r = await cell(op, n);
        rows.push(r);
        console.error(JSON.stringify(r));
      }
    }),
  );
  let failed = false;
  console.log(`\n| op | ${NS.map((n) => `N=${n}`).join(" | ")} |`);
  console.log(`| --- | ${NS.map(() => "---:").join(" | ")} |`);
  for (const op of which) {
    const rs = NS.map((n) => rows.find((r) => r.op === op && r.n === n)!);
    const c0 = rs[0]!.perOp as number;
    const cells = rs.map((r) => {
      const c = r.perOp as number;
      const bad = Boolean(r.errors) || !(c <= c0 * 1.05 + 12);
      if (bad) failed = true;
      return `${c}${r.errors ? " ERR" : ""}${bad ? " !" : ""}${diag ? ` (walk ${r.walkPerOp}, rel ${r.relPerOp})` : ""}`;
    });
    console.log(`| ${op} | ${cells.join(" | ")} |`);
  }
  const result: Record<string, unknown> = { k: K, rows };
  if (long) {
    const n = 102400;
    const runs: Record<string, unknown>[] = [];
    for (const rounds of [20, 100]) {
      const f = join(work, `long-${rounds}.ts`);
      writeFileSync(f, generateLong(n, 500, rounds));
      const r = await runOne(f);
      runs.push({
        writes: rounds * 500,
        inst: r.inst,
        check: r.check,
        mem: r.mem,
        errors: r.errors,
      });
      if (r.errors) failed = true;
    }
    const [a, b] = runs as { inst: number; writes: number }[];
    const per = (b!.inst - a!.inst) / (b!.writes - a!.writes);
    console.log(
      `\nlong run (N=${n}): ${JSON.stringify(runs)}; ${per} per write between 10k and 50k writes`,
    );
    result.long = { runs, perWrite: per };
  }
  writeFileSync(outFile, JSON.stringify(result, null, 2));
  if (failed) {
    console.log("\nFAIL: cost grows with heap size, or a run failed");
    process.exit(1);
  }
}
await main();
