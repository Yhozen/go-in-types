// Fuzzer: random well-typed, deterministic, terminating Go programs
// (scripts/fuzz-gen.ts), run natively (go build -overlay overlay/tests.json,
// amd64) and through the engine (front end + reference); outputs compared in
// the tests/go .out format.
//   node scripts/fuzz-go.ts [-n N] [--seed S] [--native-only] [--keep]
//   --native-only  only check that programs build and run natively (generator check)
//   --keep         copy failing programs to tests/go/fuzz/ (then regenerate .out files)
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { corpusDir, ensureOverlay, native, pool } from "./gen-go-out.ts";
import { firstDiff, formatOut } from "./go-out.ts";
import { generate } from "./fuzz-gen.ts";
import { frontend, reference, repo, StageError } from "./pipeline.ts";

export interface FuzzResult {
  seed: number;
  ok: boolean;
  stage?: string;
  detail?: string;
}

export async function fuzz(
  n: number,
  seed0: number,
  nativeOnly: boolean,
  keep = false,
): Promise<FuzzResult[]> {
  await ensureOverlay();
  const dir = join(repo, ".run/fuzz");
  mkdirSync(dir, { recursive: true });
  const seeds = Array.from({ length: n }, (_, i) => seed0 + i);
  return pool(seeds, Math.max(2, cpus().length - 2), async (seed): Promise<FuzzResult> => {
    const file = join(dir, `fuzz${seed}.go`);
    writeFileSync(file, generate(seed));
    const nat = await native(file, join(repo, "overlay/tests.json"));
    if (nat.buildError)
      return {
        seed,
        ok: false,
        stage: "generator",
        detail: nat.buildError.split("\n").slice(0, 2).join(" | "),
      };
    if (nativeOnly) return { seed, ok: true };
    const want = formatOut(nat.stdout, nat.stderr, nat.exit);
    let got: string;
    try {
      const prog = await frontend(file, join(dir, "ir"));
      const r = await reference(prog);
      got = formatOut(r.stdout, r.stderr, r.exit);
    } catch (e) {
      if (e instanceof StageError) return { seed, ok: false, stage: e.stage, detail: e.message };
      throw e;
    }
    if (got === want) return { seed, ok: true };
    if (keep) {
      mkdirSync(join(corpusDir, "fuzz"), { recursive: true });
      copyFileSync(file, join(corpusDir, "fuzz", `fuzz${seed}.go`));
    }
    return { seed, ok: false, stage: "output", detail: firstDiff(want, got) };
  });
}

if (process.argv[1]?.endsWith("fuzz-go.ts")) {
  const a = process.argv.slice(2);
  const opt = (k: string, d: number) => (a.includes(k) ? Number(a[a.indexOf(k) + 1]) : d);
  const res = await fuzz(
    opt("-n", 50),
    opt("--seed", 1),
    a.includes("--native-only"),
    a.includes("--keep"),
  );
  for (const r of res) if (!r.ok) console.log(`FAIL seed ${r.seed} [${r.stage}] ${r.detail}`);
  console.log(`fuzz: ${res.filter((r) => r.ok).length}/${res.length} ok`);
  process.exitCode = res.every((r) => r.ok) ? 0 : 1;
}
