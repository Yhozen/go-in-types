// Long run: R rounds of K writes (alias-arg loop) on a heap of 256 + N objects; prints
// instantiations, check time, memory and (with --diag) the relation cache size.
//   node long.ts NODE OBJ N K R [--diag PATH]
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generate, type Cfg } from "./gen.ts";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const a = process.argv.slice(2);
const di = a.indexOf("--diag");
const diag = di >= 0 ? a.splice(di, 2)[1] : "";
const [node, obj, n, k, r] = a;
const c = { node, obj, bind: "arg", op: "write", n: Number(n), k: Number(k), rounds: Number(r) } as Cfg;
mkdirSync(join(root, ".run/bench"), { recursive: true });
const f = join(root, ".run/bench", `long-${node}-${obj}-${n}-${k}x${r}.ts`);
writeFileSync(f, generate(c));
const bin = diag || join(root, "node_modules/.bin/tsrs");
const p = spawnSync(bin, ["--ignoreConfig", "--fast", "--singleThreaded", "--extendedDiagnostics", "--noEmit", "--types", "", "--lib", "es2023", f], {
  env: { ...process.env, TSRS_FAST: "1", ...(diag ? { TSRS_HEAPDIAG: "1" } : {}) },
  encoding: "utf8",
  timeout: 900_000,
  maxBuffer: 1 << 26,
});
const out = (p.stdout ?? "") + (p.stderr ?? "");
const pick = (re: RegExp) => out.match(re)?.[1];
console.log(JSON.stringify({ ...c, ops: c.k * c.rounds!, inst: pick(/^Instantiations:\s+(\d+)/m), check: pick(/^Check time:\s+([\d.]+)s/m), memK: pick(/^Memory used:\s+(\d+)K/m), relation: pick(/^heapdiag relation_size_max\s+(\d+)/m), errors: out.split("\n").filter((l) => /error TS/.test(l)).slice(0, 2) }));
