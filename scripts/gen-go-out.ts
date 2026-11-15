// Regenerates tests/go/**/*.out from native runs (see tests/go/README.md):
//   node scripts/gen-go-out.ts [--check] [--real] [filter...]
// Each program is built with `GOARCH=amd64 go build -overlay overlay/tests.json`
// (amd64 under Rosetta on Apple silicon: no fused multiply-add, the same
// target the front end loads) and run with a 20 s timeout.
//   --check  compare with the existing .out files instead of writing them
//   --real   also build without the overlay (real fmt, real sync, ...) and
//            report programs whose output differs: a parity check of the
//            overlays (hand-written programs only, upstream ones have their
//            own .out from the Go tree, checked as tests/go/gotest/*.golden)
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { formatOut, firstDiff } from "./go-out.ts";

const run = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const corpusDir = join(repo, "tests/go");
const binDir = join(repo, ".run/go-bin");

/** All corpus programs (tests/go/**\/*.go), sorted, relative to tests/go. */
export function corpus(filters: string[] = []): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".go")) out.push(relative(corpusDir, p));
    }
  };
  walk(corpusDir);
  return out.filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)));
}

export async function ensureOverlay(): Promise<string> {
  await run("node", [join(repo, "overlay/gen.ts")], { cwd: repo });
  return join(repo, "overlay/tests.json");
}

export interface NativeResult {
  stdout: string;
  stderr: string;
  exit: number;
  buildError?: string;
}

export async function native(file: string, overlay: string | null): Promise<NativeResult> {
  const src = resolve(corpusDir, file); // file: relative to tests/go, or absolute
  const bin = join(
    binDir,
    (overlay ? "ov-" : "real-") + file.replaceAll("/", "__").replace(/\.go$/, ""),
  );
  mkdirSync(binDir, { recursive: true });
  const args = ["build", "-o", bin];
  if (overlay) args.push("-overlay", overlay);
  args.push(src);
  try {
    await run("go", args, {
      cwd: dirname(src),
      env: { ...process.env, GOARCH: "amd64", CGO_ENABLED: "0" },
    });
  } catch (e: any) {
    return { stdout: "", stderr: "", exit: -1, buildError: String(e.stderr || e.message) };
  }
  try {
    const r = await run(bin, [], {
      encoding: "latin1",
      timeout: 20_000,
      maxBuffer: 64 << 20,
      cwd: dirname(src),
    });
    return { stdout: r.stdout, stderr: r.stderr, exit: 0 };
  } catch (e: any) {
    if (e.killed)
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exit: -1, buildError: "timeout" };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exit: typeof e.code === "number" ? e.code : -1,
    };
  }
}

export async function pool<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await f(items[i]!);
      }
    }),
  );
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const real = argv.includes("--real");
  const files = corpus(argv.filter((a) => !a.startsWith("--")));
  const overlay = await ensureOverlay();
  let bad = 0;
  await pool(files, Math.max(2, cpus().length - 2), async (f) => {
    const r = await native(f, overlay);
    if (r.buildError) {
      bad++;
      console.log(`BUILD ${f}: ${r.buildError.split("\n").slice(0, 3).join(" | ")}`);
      return;
    }
    const text = formatOut(r.stdout, r.stderr, r.exit);
    const outFile = join(corpusDir, f.replace(/\.go$/, ".out"));
    if (check) {
      const want = existsSync(outFile) ? readFileSync(outFile, "latin1") : "";
      if (want !== text) {
        bad++;
        console.log(`DIFF ${f}: ${firstDiff(want, text)}`);
      }
    } else {
      writeFileSync(outFile, text, "latin1");
    }
    if (
      real &&
      !f.startsWith("gotest/") &&
      !readFileSync(join(corpusDir, f), "utf8").includes('"gointypes/rt"')
    ) {
      const n = await native(f, null);
      const t = n.buildError
        ? `build error: ${n.buildError}`
        : formatOut(n.stdout, n.stderr, n.exit);
      if (t !== text) {
        bad++;
        console.log(`REAL ${f}: overlay output differs from real Go: ${firstDiff(t, text)}`);
      }
    }
  });
  console.log(`${files.length} programs, ${bad} problems${check ? " (check)" : ""}`);
  process.exitCode = bad === 0 ? 0 : 1;
}

if (process.argv[1] && basename(process.argv[1]) === "gen-go-out.ts") await main();
