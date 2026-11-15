// Imports the in-scope subset of $GOROOT/test `// run` programs into
// tests/go/gotest/ (copied unchanged) and writes tests/go/gotest/EXCLUDED.md.
//   node scripts/import-gotest.ts
// A test is in scope when it is a single-file `// run` test (no arguments),
// uses no goroutines/channels/select/complex numbers, imports none of the
// excluded packages, and its native run with overlay/tests.json reproduces
// Go's own expectation (its .out file, or no output and exit 0). Then
// regenerate .out files with scripts/gen-go-out.ts.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { corpusDir, ensureOverlay, pool } from "./gen-go-out.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const goTest = join(execFileSync("go", ["env", "GOROOT"], { encoding: "utf8" }).trim(), "test");
const outDir = join(corpusDir, "gotest");

const banned: Record<string, string> = {
  reflect: "reflect",
  unsafe: "unsafe",
  os: "os",
  "os/exec": "os",
  syscall: "os",
  "io/ioutil": "os",
  log: "os (log)",
  runtime: "runtime package",
  "runtime/debug": "runtime package",
  sync: "goroutines (sync)",
  "sync/atomic": "goroutines (sync/atomic)",
  time: "time",
  "math/rand": "math/rand (seeded by the runtime)",
};

function imports(src: string): string[] {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const out: string[] = [];
  for (const m of noComments.matchAll(/^import\s*\(([\s\S]*?)\)/gm))
    for (const q of m[1]!.matchAll(/"([^"]+)"/g)) out.push(q[1]!);
  for (const m of noComments.matchAll(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) out.push(m[1]!);
  return out;
}

function staticReason(src: string): string | null {
  for (const imp of imports(src)) if (imp in banned) return `imports ${imp}: ${banned[imp]}`;
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:[^"\\\n]|\\.)*"|`[^`]*`/g, '""');
  if (/^\s*go\s+[\w(]/m.test(code)) return "goroutines (go statement)";
  if (/\bselect\s*\{/.test(code)) return "select";
  if (/\bchan\b/.test(code)) return "channels (no goroutines to pair with; out of scope)";
  if (/\bcomplex(64|128)?\b|\breal\(|\bimag\(|\d+i\b/.test(code))
    return "complex numbers (trap in the engine)";
  if (/^\s*\/\/go:(linkname|noescape|nosplit|uintptrescapes|systemstack|nowritebarrier)/m.test(src))
    return "compiler/runtime directive";
  return null;
}

async function main() {
  const overlay = await ensureOverlay();
  const tests = readdirSync(goTest)
    .filter((f) => f.endsWith(".go"))
    .sort()
    .filter((f) => readFileSync(join(goTest, f), "utf8").split("\n")[0] === "// run");
  const excluded: [string, string][] = [];
  const candidates: string[] = [];
  for (const f of tests) {
    const r = staticReason(readFileSync(join(goTest, f), "utf8"));
    if (r) excluded.push([f, r]);
    else candidates.push(f);
  }
  const tmp = join(tmpdir(), "gotest-import");
  mkdirSync(tmp, { recursive: true });
  const included: string[] = [];
  await pool(candidates, Math.max(2, cpus().length - 2), async (f) => {
    const bin = join(tmp, f.replace(/\.go$/, ""));
    try {
      await run("go", ["build", "-overlay", overlay, "-o", bin, join(goTest, f)], {
        env: { ...process.env, GOARCH: "amd64", CGO_ENABLED: "0" },
      });
    } catch (e: any) {
      excluded.push([
        f,
        "does not build with the overlays: " +
          String(e.stderr)
            .split("\n")
            .filter((l: string) => l && !l.startsWith("#"))[0],
      ]);
      return;
    }
    let out = "";
    let code = 0;
    try {
      // Go's harness compares combined stdout+stderr with the .out file.
      out = execFileSync("sh", ["-c", `"${bin}" 2>&1`], {
        encoding: "latin1",
        timeout: 20_000,
        maxBuffer: 64 << 20,
      });
    } catch (e: any) {
      out = e.stdout ?? "";
      code = e.status ?? -1;
    }
    const golden = join(goTest, f.replace(/\.go$/, ".out"));
    const want = existsSync(golden) ? readFileSync(golden, "latin1") : "";
    if (code !== 0)
      excluded.push([f, `exit ${code} natively with the overlays: ${out.split("\n")[0]}`]);
    else if (out !== want)
      excluded.push([
        f,
        "native output with the overlays differs from Go's .out (overlay fmt subset)",
      ]);
    else included.push(f);
  });
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const f of included.sort()) {
    copyFileSync(join(goTest, f), join(outDir, f));
    const golden = join(goTest, f.replace(/\.go$/, ".out"));
    if (existsSync(golden)) copyFileSync(golden, join(outDir, f.replace(/\.go$/, ".golden")));
  }
  excluded.sort(([a], [b]) => (a < b ? -1 : 1));
  writeFileSync(
    join(outDir, "EXCLUDED.md"),
    "# $GOROOT/test `// run` programs not in the corpus\n\n" +
      `Generated by \`node scripts/import-gotest.ts\` (Go ${execFileSync("go", ["env", "GOVERSION"], { encoding: "utf8" }).trim()}): ` +
      `${tests.length} single-file \`// run\` tests, ${included.length} included, ${excluded.length} excluded.\n\n` +
      "| test | reason |\n| --- | --- |\n" +
      excluded.map(([f, r]) => `| ${f} | ${r.replaceAll("|", "\\|")} |`).join("\n") +
      "\n",
  );
  console.log(`${tests.length} tests: ${included.length} included, ${excluded.length} excluded`);
}

await main();
