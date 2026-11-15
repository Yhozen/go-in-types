// Generates the IR of the TypeScript 7 compiler harness and reports its
// size: node scripts/tsgo-ir.ts [--config tsgo|census] [--tsgo-dir DIR] [-- frontend flags]
//
//   tsgo    overlay/tsgo.json (the corpus overlays: harness main, std, tsgo, xxh3)
//   census  overlay/tests.json (std overlays) + the stage 0 census harness
//           (experiments/stage0/census/overlay/harness_main.go.txt and stubs)
//
// Output (git-ignored): .run/tsgo/prog.json, .run/tsgo/stats.json.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { overlayFor, runFrontend } from "./frontend.ts";
import type { Program } from "../src/ir/types.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const dd = argv.indexOf("--");
const extra = dd >= 0 ? argv.splice(dd).slice(1) : [];
let config = "tsgo";
let tsgoDir = resolve(repo, "../../go-in-types/vendor/typescript/tsc");
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--config") config = argv[++i]!;
  else if (argv[i] === "--tsgo-dir") tsgoDir = resolve(argv[++i]!);
}
const outDir = join(repo, ".run", "tsgo");
mkdirSync(outDir, { recursive: true });

let overlay: string;
if (config === "census") {
  const std = JSON.parse(readFileSync(overlayFor("tests"), "utf8")) as {
    Replace: Record<string, string>;
  };
  const ov = join(repo, "experiments/stage0/census/overlay");
  const empty = join(ov, "empty_main.go.txt");
  const replace = {
    ...std.Replace,
    [join(tsgoDir, "cmd/tsgo/main.go")]: join(ov, "harness_main.go.txt"),
  };
  for (const f of [
    "sys.go",
    "lsp.go",
    "api.go",
    "isprocessalive_unix.go",
    "isprocessalive_other.go",
  ])
    replace[join(tsgoDir, "cmd/tsgo", f)] = empty;
  overlay = join(outDir, "census-overlay.json");
  writeFileSync(overlay, JSON.stringify({ Replace: replace }, null, 1));
} else overlay = overlayFor(config);

const out = join(outDir, "prog.json");
const t0 = performance.now();
const r = runFrontend(join(tsgoDir, "cmd/tsgo"), out, "none", ["-overlay", overlay, ...extra]);
const seconds = (performance.now() - t0) / 1000;
process.stderr.write(r.log);
if (r.errors.length) {
  console.error(`invalid IR (${r.errors.length} problems):\n${r.errors.slice(0, 40).join("\n")}`);
  process.exit(1);
}

const prog = JSON.parse(readFileSync(out, "utf8")) as Program;
const byBody = { ir: 0, trap: 0, intrinsic: 0 };
let blocks = 0;
let instrs = 0;
const ops: Record<string, number> = {};
const trapWhat: Record<string, number> = {};
const bump = (k: string) => (trapWhat[k] = (trapWhat[k] ?? 0) + 1);
const intrinsics = new Set<string>();
for (const f of prog.funcs) {
  byBody[f.body]++;
  if (f.body === "intrinsic") intrinsics.add(f.intrinsic!);
  if (f.body === "trap") bump(f.trap!.replace(/(not supported|without body|-keep\)).*/, "$1"));
  blocks += f.blocks.length;
  for (const b of f.blocks)
    for (const i of b.instrs) {
      instrs++;
      ops[i.op] = (ops[i.op] ?? 0) + 1;
      if (i.op === "trap") bump(`instr: ${i.what}`);
    }
}
const stats = {
  config,
  seconds: Math.round(seconds * 10) / 10,
  jsonBytes: statSync(out).size,
  funcs: prog.funcs.length,
  ...byBody,
  blocks,
  instrs,
  types: prog.types.length,
  globals: prog.globals.length,
  intrinsics: [...intrinsics].sort(),
  traps: Object.fromEntries(Object.entries(trapWhat).sort((a, b) => b[1] - a[1])),
  ops: Object.fromEntries(Object.entries(ops).sort((a, b) => b[1] - a[1])),
};
writeFileSync(join(outDir, "stats.json"), JSON.stringify(stats, null, 1));
console.log(JSON.stringify({ ...stats, traps: undefined, ops: undefined }));
console.log(`traps: ${JSON.stringify(stats.traps)}`);
