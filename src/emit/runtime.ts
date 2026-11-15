// Writes the type-level runtime (src/types primitives, src/emit/rt.ts and
// the fuel pool) as declaration files into one directory, so that a run
// loads it lazily (a `.ts` file is checked in full: ~8 s and ~4M
// instantiations; LESSONS.md "Emit `.d.ts`"). Emitted programs import
// `<dir>/rt.d.ts` etc.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Runtime modules: [source path from the repo, output base name]. */
export const RUNTIME_FILES: [string, string][] = [
  ["src/emit/rt.ts", "rt"],
  ["src/emit/fuel.gen.ts", "fuel.gen"],
  ["src/emit/chacha.ts", "chacha"],
  ["src/types/int.ts", "int"],
  ["src/types/int-pairs.gen.ts", "int-pairs.gen"],
  ["src/types/int-tables.gen.ts", "int-tables.gen"],
  ["src/types/nat.ts", "nat"],
  ["src/types/heap.ts", "heap"],
  ["src/types/heap.gen.ts", "heap.gen"],
  ["src/types/str.ts", "str"],
  ["src/types/str-tables.gen.ts", "str-tables.gen"],
  ["src/types/map.ts", "map"],
  ["src/types/map-tables.gen.ts", "map-tables.gen"],
];

/** Writes `<dir>/<name>.d.ts` for every runtime module (imports rewritten to the flat layout). */
export function writeRuntime(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const [src, base] of RUNTIME_FILES) {
    let text = readFileSync(join(repo, src), "utf8");
    text = text.replace(/from "(?:\.\.\/types\/|\.\/)([A-Za-z0-9.-]+)\.ts"/g, 'from "./$1.d.ts"');
    writeFileSync(join(dir, `${base}.d.ts`), text);
  }
}
