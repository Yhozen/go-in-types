// Emits a program as a `.d.ts` module run by tsrs (docs/EMIT.md).
//   node scripts/emit.ts prog.json -o out.d.ts [--keep names.txt] [--prefix G] [--runtime dir]
// The runtime (.d.ts copies of src/types and src/emit/rt.ts) goes to
// --runtime (default: <out dir>/rt).
// --keep: a file of function names (one per line, e.g. the census executed
// list); only those get bodies, the others trap when called.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Program } from "../src/ir/types.ts";
import { emit, type EmitStats, type EntryInfo } from "../src/emit/emit.ts";
import { writeRuntime } from "../src/emit/runtime.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const input = argv.find(
  (a, i) =>
    !a.startsWith("-") && !["-o", "--keep", "--prefix", "--runtime"].includes(argv[i - 1] ?? ""),
);
if (!input) {
  console.error("usage: node scripts/emit.ts prog.json -o out.d.ts [--keep file] [--prefix G]");
  process.exit(2);
}
const out = resolve(opt("-o") ?? input.replace(/\.json$/, ".d.ts"));
const keepFile = opt("--keep");
const keep = keepFile
  ? new Set(
      readFileSync(keepFile, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    )
  : undefined;
const t0 = performance.now();
const prog = JSON.parse(readFileSync(input, "utf8")) as Program;
const t1 = performance.now();
const stats = {} as EmitStats;
const rtDir = resolve(opt("--runtime") ?? join(dirname(out), "rt"));
writeRuntime(rtDir);
const rtRel = relative(dirname(out), rtDir).replaceAll("\\", "/");
const entries: EntryInfo[] = [];
const text = emit(
  prog,
  { rt: rtRel.startsWith(".") ? rtRel : "./" + rtRel, keep, prefix: opt("--prefix") },
  stats,
  entries,
);
const t2 = performance.now();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, text);
// the sidecar entry table (EMIT.md "Entries")
writeFileSync(out.replace(/\.d\.ts$/, "") + ".entries.json", JSON.stringify(entries));
console.error(
  `emit: ${out}: ${(stats.bytes / 1e6).toFixed(2)} MB, ${stats.funcs} funcs, ${stats.blocks} blocks, ${stats.segments} segments, ${stats.entries} entries; parse ${((t1 - t0) / 1000).toFixed(2)} s, emit ${((t2 - t1) / 1000).toFixed(2)} s`,
);
