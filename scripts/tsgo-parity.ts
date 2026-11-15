// Native parity of the tsgo overlay: builds cmd/tsgo with overlay/tsgo.json
// and runs it on the 328 oracle inputs x {mini, es5}, comparing stdout and
// exit status with the unmodified native tsc 7.0.2 (node_modules/.bin/tsc).
//   node scripts/tsgo-parity.ts [--oracle DIR] [filter...]
// The reference outputs are cached in .run/tsgo-parity/ref (the native
// binary does not change).
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tsgoDir } from "../overlay/gen.ts";
import { pool } from "./gen-go-out.ts";

const run = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const oi = argv.indexOf("--oracle");
const oracle = oi >= 0 ? argv[oi + 1]! : resolve(repo, "../../ts-in-lua-in-types");
const filters = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--oracle");
const work = join(repo, ".run/tsgo-parity");
const libs: Record<string, string> = {
  mini: join(oracle, "lua/lib.mini.d.ts"),
  es5: join(
    repo,
    "node_modules/.pnpm/@typescript+typescript-darwin-arm64@7.0.2/node_modules/@typescript/typescript-darwin-arm64/lib/lib.es5.d.ts",
  ),
};

function inputs(): string[] {
  const base = join(oracle, "oracle/inputs");
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".ts")) out.push(relative(base, p));
    }
  };
  walk(base);
  return out.filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)));
}

async function check(bin: string[], dir: string, lib: string): Promise<string> {
  try {
    const r = await run(bin[0]!, [...bin.slice(1), "--noLib", "--noEmit", "--skipLibCheck", "--singleThreaded", lib, "main.ts"], {
      cwd: dir,
      encoding: "latin1",
      timeout: 120_000,
      maxBuffer: 64 << 20,
    });
    return r.stdout + r.stderr + "\n[exit 0]\n";
  } catch (e: any) {
    return (e.stdout ?? "") + (e.stderr ?? "") + `\n[exit ${e.code}]\n`;
  }
}

async function main() {
  execFileSync("node", [join(repo, "overlay/gen.ts")]);
  const tsgo = tsgoDir();
  const bin = join(work, "tsgo-overlay");
  mkdirSync(work, { recursive: true });
  execFileSync("go", ["build", "-tags", "purego", "-overlay", join(repo, "overlay/tsgo.json"), "-o", bin, "./cmd/tsgo"], {
    cwd: tsgo,
    stdio: "inherit",
    env: { ...process.env, CGO_ENABLED: "0" },
  });
  const ref = [join(repo, "node_modules/.bin/tsc")];
  const jobs = inputs().flatMap((f) => Object.keys(libs).map((m) => [f, m] as const));
  let ok = 0;
  const bad: string[] = [];
  await pool(jobs, Math.max(2, cpus().length - 2), async ([f, mode]) => {
    // Outside the repository: tsc looks for a tsconfig.json in parent directories.
    const d = join(tmpdir(), "tsgo-parity", `${f.replaceAll("/", "__")}.${mode}`);
    rmSync(d, { recursive: true, force: true });
    mkdirSync(d, { recursive: true });
    const lib = `lib.${mode}.d.ts`;
    copyFileSync(libs[mode]!, join(d, lib));
    copyFileSync(join(oracle, "oracle/inputs", f), join(d, "main.ts"));
    const cache = join(work, "ref", `${f.replaceAll("/", "__")}.${mode}.txt`);
    let want: string;
    if (existsSync(cache)) want = readFileSync(cache, "latin1");
    else {
      want = await check(ref, d, lib);
      mkdirSync(dirname(cache), { recursive: true });
      writeFileSync(cache, want, "latin1");
    }
    const got = await check([bin], d, lib);
    if (got === want) ok++;
    else {
      bad.push(`${f} ${mode}`);
      writeFileSync(join(d, "got.txt"), got, "latin1");
      writeFileSync(join(d, "want.txt"), want, "latin1");
    }
  });
  for (const b of bad.sort()) console.log("DIFF", b);
  console.log(`tsgo overlay native parity: ${ok}/${jobs.length}`);
  process.exitCode = bad.length === 0 ? 0 : 1;
}

await main();
