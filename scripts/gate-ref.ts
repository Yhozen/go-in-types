// Stage 2 gate (vp run gate:ref): for every corpus program (tests/go/**/*.go)
// front end -> reference -> compare with the .out file; then the fuzzer;
// then the snapshot test (pause at several op counts, resume from the JSON
// snapshot in a fresh process, same output and op total).
//   node scripts/gate-ref.ts [--fuzz N] [--seed S] [--no-snapshot] [--slow] [filter...]
//
// Slow tier: programs in SLOW run only with --slow (with their own timeout,
// no snapshot test); without it they are listed as skipped in the table.
//
// Failures are classified:
//   front end  the front end failed on the program
//   reference  the reference crashed, timed out or printed no result
//   overlay    output differs and the engine stopped in overlay code
//              (fmt, sync, errors, gointypes/rt) with a trap
//   contract   output differs and the engine reached a trap (an operation
//              the contract leaves unsupported)
//   output     any other output difference (reference or front end bug)
import { existsSync, readFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { corpus, corpusDir, ensureOverlay, pool } from "./gen-go-out.ts";
import { firstDiff, formatOut } from "./go-out.ts";
import { fuzz } from "./fuzz-go.ts";
import { frontend, reference, repo, snapshot, StageError } from "./pipeline.ts";

const argv = process.argv.slice(2);
const opt = (k: string, d: number) => (argv.includes(k) ? Number(argv[argv.indexOf(k) + 1]) : d);
const filters = argv.filter(
  (a, i) => !a.startsWith("--") && !["--fuzz", "--seed"].includes(argv[i - 1] ?? ""),
);
const nFuzz = opt("--fuzz", 100);
const doSnap = !argv.includes("--no-snapshot");
const doSlow = argv.includes("--slow");

/** Slow tier: corpus program -> reference timeout (ms) and why it is slow. */
const SLOW: Record<string, { timeoutMs: number; why: string }> = {
  "gotest/divmod.go": { timeoutMs: 20 * 60_000, why: "~4.6G ops (exhaustive 8/16-bit div/mod)" },
};

interface Row {
  name: string;
  ok: boolean;
  cls?: string;
  detail?: string;
  ops?: number;
  prog?: string;
  out?: string;
}

function classify(got: string): string {
  const trap = /trap[^\n]*/i.exec(got)?.[0];
  if (!trap) return "output";
  return /\b(fmt|sync|errors|gointypes\/rt)\./.test(trap) ? "overlay" : "contract";
}

async function main() {
  await ensureOverlay();
  const all = corpus(filters);
  const skipped = doSlow ? [] : all.filter((f) => f in SLOW);
  const files = all.filter((f) => !skipped.includes(f));
  const irDir = join(repo, ".run/gate/ir");
  const rows = await pool(files, Math.max(2, cpus().length - 2), async (f): Promise<Row> => {
    const outFile = join(corpusDir, f.replace(/\.go$/, ".out"));
    if (!existsSync(outFile))
      return { name: f, ok: false, cls: "corpus", detail: "no .out (run scripts/gen-go-out.ts)" };
    const want = readFileSync(outFile, "latin1");
    try {
      const prog = await frontend(join(corpusDir, f), join(irDir, dirname(f)));
      const r = await reference(prog, SLOW[f]?.timeoutMs);
      const got = formatOut(r.stdout, r.stderr, r.exit);
      if (got === want)
        return { name: f, ok: true, ops: r.ops, prog: f in SLOW ? undefined : prog, out: got };
      return { name: f, ok: false, cls: classify(got), detail: firstDiff(want, got) };
    } catch (e) {
      if (e instanceof StageError) return { name: f, ok: false, cls: e.stage, detail: e.message };
      throw e;
    }
  });

  // Snapshot test: pause at 1/4, 1/2, 3/4 of the ops (and op 1), resume fresh.
  const snapRows: Row[] = [];
  if (doSnap) {
    const passing = rows.filter((r) => r.ok && r.prog && r.ops && r.ops > 1);
    const jobs = passing.flatMap((r) =>
      [1, Math.floor(r.ops! / 4), Math.floor(r.ops! / 2), Math.floor((3 * r.ops!) / 4)].map(
        (at) => ({ r, at }),
      ),
    );
    snapRows.push(
      ...(await pool(jobs, Math.max(2, cpus().length - 2), async ({ r, at }): Promise<Row> => {
        const name = `${r.name}@${at}`;
        const want = r.out!;
        try {
          const s = await snapshot(
            r.prog!,
            at,
            join(repo, ".run/gate/snap", name.replaceAll("/", "__") + ".json"),
          );
          const got = formatOut(s.stdout, s.stderr, s.exit);
          if (got !== want)
            return { name, ok: false, cls: "snapshot", detail: firstDiff(want, got) };
          if (s.ops !== r.ops)
            return { name, ok: false, cls: "snapshot", detail: `ops ${s.ops} != ${r.ops}` };
          return { name, ok: true };
        } catch (e) {
          if (e instanceof StageError)
            return { name, ok: false, cls: "snapshot", detail: e.message };
          throw e;
        }
      })),
    );
  }

  const fz = nFuzz > 0 ? await fuzz(nFuzz, opt("--seed", 1), false) : [];

  const tally = (rs: { ok: boolean; cls?: string; stage?: string }[]) => {
    const t: Record<string, number> = {};
    for (const r of rs)
      if (!r.ok) t[r.cls ?? r.stage ?? "?"] = (t[r.cls ?? r.stage ?? "?"] ?? 0) + 1;
    return Object.entries(t)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
  };
  for (const r of rows) if (!r.ok) console.log(`FAIL [${r.cls}] ${r.name}: ${r.detail}`);
  for (const r of snapRows) if (!r.ok) console.log(`FAIL [snapshot] ${r.name}: ${r.detail}`);
  for (const r of fz) if (!r.ok) console.log(`FAIL [fuzz ${r.stage}] seed ${r.seed}: ${r.detail}`);
  const line = (name: string, rs: { ok: boolean }[], t: string) =>
    `| ${name} | ${rs.filter((r) => r.ok).length}/${rs.length} | ${t || "-"} |`;
  const hand = rows.filter((r) => !r.name.includes("/"));
  const gotest = rows.filter((r) => r.name.startsWith("gotest/"));
  const other = rows.filter((r) => r.name.includes("/") && !r.name.startsWith("gotest/"));
  console.log("\n| set | pass | failures |\n| --- | --- | --- |");
  console.log(line("hand-written", hand, tally(hand)));
  console.log(line("$GOROOT/test", gotest, tally(gotest)));
  if (other.length) console.log(line("kept fuzz cases", other, tally(other)));
  const slowRun = rows.filter((r) => r.name in SLOW);
  if (slowRun.length)
    console.log(
      line(
        "slow tier (in the rows above)",
        slowRun,
        slowRun.map((r) => `${r.name}: ${r.ok ? `${r.ops} ops` : "FAIL"}`).join(", "),
      ),
    );
  if (skipped.length)
    console.log(
      `| slow tier | skipped | ${skipped.map((f) => `${f} (${SLOW[f]!.why}; --slow)`).join(", ")} |`,
    );
  if (doSnap) console.log(line("snapshot resume", snapRows, tally(snapRows)));
  if (nFuzz > 0) console.log(line(`fuzz (seeds ${opt("--seed", 1)}..)`, fz, tally(fz as any)));
  const allOk = rows.every((r) => r.ok) && snapRows.every((r) => r.ok) && fz.every((r) => r.ok);
  process.exitCode = allOk ? 0 : 1;
}

await main();
