// Runs heap micro benchmarks on tsrs and prints instantiations per op.
//
//   node run.ts [--tsrs PATH] [--k K] [--jobs 2] [--timeout 300] [--out results.json] \
//       node=tuple,iface obj=t16,lua bind=arg,infer op=read,write n=0,1024 ...
//
// Each cell runs K and 2K steps; cost/op = (inst(2K) - inst(K)) / K, which
// cancels building the heap and the first resolution of every alias.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generate, type Cfg } from "./gen.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const tsrs = opt("tsrs", join(root, "node_modules/.bin/tsrs"));
const K = Number(opt("k", "100"));
const jobs = Number(opt("jobs", "2"));
const timeout = Number(opt("timeout", "300"));
const outFile = opt("out", "");
// optional instrumented build (README.md): adds relation-cache entries and permissive/restrictive instantiations per op
const diag = opt("diag", "");
const dims: Record<string, string[]> = {
  node: ["tuple"],
  obj: ["t16"],
  bind: ["arg"],
  op: ["write"],
  n: ["0"],
  dfr: ["0"],
  glit: ["0"],
  elit: ["0"],
};
for (const a of args) {
  const [k, v] = a.split("=");
  dims[k] = v.split(",");
}
const work = join(root, ".run/bench");
mkdirSync(work, { recursive: true });

type Run = { inst: number; types: number; check: number; mem: number; errors: string; ms: number; out: string };
function runOne(file: string, bin = tsrs, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((res) => {
    const t0 = Date.now();
    const p = spawn(
      bin,
      ["--ignoreConfig", "--fast", "--singleThreaded", "--extendedDiagnostics", "--noEmit", "--types", "", "--lib", "es2023", "--strict", file],
      { env: { ...process.env, TSRS_FAST: "1", ...env } },
    );
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), timeout * 1000);
    p.on("close", () => {
      clearTimeout(timer);
      const num = (re: RegExp) => Number(out.match(re)?.[1] ?? NaN);
      const errors = out
        .split("\n")
        .filter((l) => /error TS/.test(l))
        .slice(0, 3)
        .join(" | ");
      res({
        inst: num(/^Instantiations:\s+(\d+)/m),
        types: num(/^Types:\s+(\d+)/m),
        check: num(/^Check time:\s+([\d.]+)s/m),
        mem: num(/^Memory used:\s+(\d+)K/m),
        errors: Number.isNaN(num(/^Instantiations:\s+(\d+)/m)) ? "timeout/crash " + errors : errors,
        ms: Date.now() - t0,
        out,
      });
    });
  });
}

const cells: Cfg[] = [];
for (const node of dims.node)
  for (const obj of dims.obj)
    for (const bind of dims.bind)
      for (const op of dims.op)
        for (const n of dims.n)
          for (const dfr of dims.dfr)
            for (const elit of dims.elit)
              for (const glit of dims.glit)
                cells.push({ node, obj, bind, op, n: Number(n), k: K, dfr: dfr === "1", elit: elit === "1", glit: glit === "1" } as Cfg);

const results: any[] = outFile && existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : [];
const tasks: (() => Promise<void>)[] = [];
for (const c of cells) {
  tasks.push(async () => {
    const name = `${c.node}-${c.obj}-${c.bind}-${c.op}-${c.n}${c.dfr ? "-dfr" : ""}${c.elit ? "-elit" : ""}${c.glit ? "-glit" : ""}`;
    const f1 = join(work, `${name}-k1.ts`);
    const f2 = join(work, `${name}-k2.ts`);
    writeFileSync(f1, generate(c));
    writeFileSync(f2, generate({ ...c, k: 2 * c.k }));
    const r1 = await runOne(f1);
    const r2 = await runOne(f2);
    const per = (r2.inst - r1.inst) / c.k;
    let rel: number | undefined, walk: number | undefined;
    if (diag) {
      const d1 = await runOne(f1, diag, { TSRS_HEAPDIAG: "1" });
      const d2 = await runOne(f2, diag, { TSRS_HEAPDIAG: "1" });
      const g = (r: Run, k: string) => Number(r.out.match(new RegExp(`^heapdiag ${k}\\s+(\\d+)`, "m"))?.[1] ?? NaN);
      rel = Math.round((g(d2, "relation_size_max") - g(d1, "relation_size_max")) / c.k);
      walk = Math.round(
        (g(d2, "inst_permissive") + g(d2, "inst_restrictive") - g(d1, "inst_permissive") - g(d1, "inst_restrictive")) / c.k,
      );
    }
    const row = {
      ...c,
      perOp: Math.round(per),
      typesPerOp: Math.round((r2.types - r1.types) / c.k),
      usPerOp: Math.round(((r2.check - r1.check) * 1e6) / c.k),
      base: r1.inst,
      check2: r2.check,
      memK: r2.mem,
      relPerOp: rel,
      walkPerOp: walk,
      errors: [r1.errors, r2.errors].filter(Boolean).join(" || "),
    };
    results.push(row);
    console.log(
      [name, `inst/op=${row.perOp}`, `types/op=${row.typesPerOp}`, `us/op=${row.usPerOp}`, `base=${r1.inst}`, `check=${r2.check}s`, `mem=${Math.round(r2.mem / 1024)}M`, ...(diag ? [`rel/op=${rel}`, `walk/op=${walk}`] : []), row.errors].join("  "),
    );
    if (outFile) writeFileSync(outFile, JSON.stringify(results, null, 1));
  });
}
let next = 0;
await Promise.all(
  Array.from({ length: jobs }, async () => {
    while (next < tasks.length) await tasks[next++]();
  }),
);
