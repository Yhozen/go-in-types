// The types gate (vp run gate:types): Go programs through front end ->
// emitter -> tsrs (scripts/types-run.ts), compared byte for byte with the
// native output (tests/go/*.out, or a native run for fuzz programs).
//
//   node scripts/gate-types.ts                 smoke tier (SMOKE, ~10 small programs)
//   node scripts/gate-types.ts --full          every corpus program up to --max-ops
//   node scripts/gate-types.ts --full --slow   no op limit (also the reference's slow tier)
//   node scripts/gate-types.ts --fuzz N        N fuzz programs (seeds --seed S..)
//   node scripts/gate-types.ts --midrun        also start each passing program from
//                                              reference snapshots at 1/4, 1/2, 3/4
//   node scripts/gate-types.ts --jobs 2        tsrs runs at once (capped at 2: heavy.sh)
//   node scripts/gate-types.ts --resume        keep rows newer than the emitter and the program
//   node scripts/gate-types.ts --doc           write docs/GATE-TYPES.md from the results
//   node scripts/gate-types.ts --hover         run through hovers (GExec) instead of the CLI
//   node scripts/gate-types.ts --timeout S     seconds per tsrs run (default 600)
//   node scripts/gate-types.ts NAME...         only corpus programs whose path contains NAME
//
// Rows go to .run/gate-types/<name>/row.json and the summary to
// .run/gate-types/report.json; failure classes are types-run.ts's.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Machine } from "../src/ref/interp.ts";
import { snapshot } from "../src/ref/snapshot.ts";
import { corpus, corpusDir, ensureOverlay, native, pool } from "./gen-go-out.ts";
import { formatOut } from "./go-out.ts";
import { generate } from "./fuzz-gen.ts";
import { frontend, reference as refRun, StageError } from "./pipeline.ts";
import { loadProg, repo, rowText, runTypes, type TypesResult } from "./types-run.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const valued = ["--fuzz", "--seed", "--jobs", "--timeout", "--max-ops", "--drive"];
const filters = argv.filter((a, i) => !a.startsWith("--") && !valued.includes(argv[i - 1] ?? ""));

/** Smoke tier: small programs that cover each feature once. */
export const SMOKE = [
  "hello.go",
  "control_flow.go",
  "closures.go",
  "int_widths.go",
  "division.go",
  "structs_pointers.go",
  "interfaces.go",
  "defer_panic.go",
  "maps.go",
  "strings_utf8.go",
];

const full = argv.includes("--full") || filters.length > 0;
const slow = argv.includes("--slow");
const maxOps = slow ? Infinity : Number(opt("--max-ops") ?? 2_000_000);
const jobs = Math.min(2, Number(opt("--jobs") ?? 2));
const timeoutSec = Number(opt("--timeout") ?? 600);
const drive = opt("--drive") ? Number(opt("--drive")) : undefined;
const nFuzz = Number(opt("--fuzz") ?? 0);
const seed0 = Number(opt("--seed") ?? 1);
const gateDir = join(repo, ".run/gate-types");

export interface Row extends Partial<TypesResult> {
  name: string;
  set: "corpus" | "fuzz" | "midrun";
  pass: boolean;
  kind: string;
  detail?: string;
}

const emitterTime = () =>
  Math.max(
    ...["src/emit", "scripts/emit.ts", "src/types", "scripts/types-run.ts"].map((p) =>
      existsSync(join(repo, p)) ? statSync(join(repo, p)).mtimeMs : 0,
    ),
  );

interface Work {
  name: string;
  set: Row["set"];
  /** produces the prog.json, the expected .out text, and options */
  prep: () => Promise<{ prog: string; want: string; from?: any; refOps?: number } | Row>;
}

async function main() {
  await ensureOverlay();
  const t0 = emitterTime();
  const names = full ? corpus(filters) : corpus().filter((f) => SMOKE.includes(f));
  const irDir = join(gateDir, "ir");
  const work: Work[] = names.map((f) => ({
    name: f,
    set: "corpus",
    prep: async () => {
      const outFile = join(corpusDir, f.replace(/\.go$/, ".out"));
      if (!existsSync(outFile))
        return { name: f, set: "corpus", pass: false, kind: "corpus", detail: "no .out" };
      try {
        const prog = await frontend(join(corpusDir, f), join(irDir, dirname(f)));
        return { prog, want: readFileSync(outFile, "latin1") };
      } catch (e) {
        if (e instanceof StageError)
          return { name: f, set: "corpus", pass: false, kind: e.stage, detail: e.message };
        throw e;
      }
    },
  }));
  for (let s = seed0; s < seed0 + nFuzz; s++)
    work.push({
      name: `fuzz${s}`,
      set: "fuzz",
      prep: async () => {
        const dir = join(gateDir, "fuzz");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `fuzz${s}.go`);
        writeFileSync(file, generate(s));
        const nat = await native(file, join(repo, "overlay/tests.json"));
        if (nat.buildError)
          return { name: `fuzz${s}`, set: "fuzz", pass: false, kind: "generator", detail: "" };
        try {
          const prog = await frontend(file, join(dir, "ir"));
          return { prog, want: formatOut(nat.stdout, nat.stderr, nat.exit) };
        } catch (e) {
          if (e instanceof StageError)
            return { name: `fuzz${s}`, set: "fuzz", pass: false, kind: e.stage, detail: e.message };
          throw e;
        }
      },
    });

  const rows = await runAll(work, t0);
  if (argv.includes("--midrun")) {
    const mid: Work[] = [];
    for (const r of rows.filter((r) => r.pass && r.set === "corpus" && (r.refOps ?? 0) > 10)) {
      const prog = join(irDir, r.name.replace(/\.go$/, ".json"));
      const want = readFileSync(join(corpusDir, r.name.replace(/\.go$/, ".out")), "latin1");
      for (const q of [1, 2, 3]) {
        const at = Math.floor((r.refOps! * q) / 4);
        mid.push({
          name: `${r.name}@${at}`,
          set: "midrun",
          prep: async () => {
            const p = loadProg(prog);
            const m = new Machine(p);
            m.boot();
            m.run(at);
            return { prog, want, from: snapshot(m, prog), refOps: r.refOps };
          },
        });
      }
    }
    rows.push(...(await runAll(mid, t0)));
  }

  writeFileSync(join(gateDir, "report.json"), JSON.stringify(rows, null, 1) + "\n");
  for (const r of rows) if (!r.pass) console.log(`FAIL [${r.kind}] ${r.name}: ${r.detail ?? ""}`);
  console.log(summary(rows));
  if (argv.includes("--doc")) {
    writeFileSync(join(repo, "docs/GATE-TYPES.md"), gateDoc(rows));
    console.log("wrote docs/GATE-TYPES.md");
  }
  process.exitCode = rows.every((r) => r.pass) ? 0 : 1;
}

async function runAll(work: Work[], t0: number): Promise<Row[]> {
  let done = 0;
  return pool(work, jobs, async (w): Promise<Row> => {
    const rowDir = join(gateDir, w.name.replaceAll("/", "__"));
    const rowPath = join(rowDir, "row.json");
    if (argv.includes("--resume") && existsSync(rowPath) && statSync(rowPath).mtimeMs > t0) {
      const row = JSON.parse(readFileSync(rowPath, "utf8")) as Row;
      console.log(`[${++done}/${work.length}] (kept) ${rowText(w.name, row as TypesResult)}`);
      return row;
    }
    const p = await w.prep();
    let row: Row;
    if ("kind" in p) row = p;
    else {
      const ref = p.refOps === undefined ? await refRun(p.prog, 600_000) : undefined;
      const ops = p.refOps ?? ref!.ops;
      if (ops > maxOps)
        row = {
          name: w.name,
          set: w.set,
          pass: false,
          kind: "skipped",
          detail: `${ops} reference ops (over --max-ops ${maxOps}; --slow)`,
          refOps: ops,
        };
      else {
        const r = await runTypes({
          prog: p.prog,
          dir: join(rowDir, "run"),
          from: p.from,
          expectOut: p.want,
          ref: ref,
          drive,
          hover: argv.includes("--hover"),
          timeoutSec,
        });
        row = { ...r, name: w.name, set: w.set };
      }
    }
    mkdirSync(rowDir, { recursive: true });
    writeFileSync(rowPath, JSON.stringify(row, null, 1) + "\n");
    console.log(`[${++done}/${work.length}] ${rowText(w.name, row as TypesResult)}`);
    return row;
  });
}

function tally(rs: Row[]): string {
  const t: Record<string, number> = {};
  for (const r of rs) if (!r.pass) t[r.kind] = (t[r.kind] ?? 0) + 1;
  return (
    Object.entries(t)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ") || "-"
  );
}

export function summary(rows: Row[]): string {
  const out = ["| set | pass | failures |", "| --- | --- | --- |"];
  const sets: [string, (r: Row) => boolean][] = [
    ["hand-written", (r) => r.set === "corpus" && !r.name.includes("/")],
    ["$GOROOT/test", (r) => r.set === "corpus" && r.name.startsWith("gotest/")],
    [
      "other corpus",
      (r) => r.set === "corpus" && r.name.includes("/") && !r.name.startsWith("gotest/"),
    ],
    ["fuzz", (r) => r.set === "fuzz"],
    ["mid-run starts", (r) => r.set === "midrun"],
  ];
  for (const [name, f] of sets) {
    const rs = rows.filter(f);
    if (rs.length)
      out.push(`| ${name} | ${rs.filter((r) => r.pass).length}/${rs.length} | ${tally(rs)} |`);
  }
  return out.join("\n");
}

function gateDoc(rows: Row[]): string {
  const ok = rows.filter((r) => r.pass && r.instantiations);
  const med = (xs: number[]) => {
    const v = [...xs].sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)]! : NaN;
  };
  const lines = [
    "# The types gate",
    "",
    "Generated by `scripts/gate-types.ts --doc`; do not edit.",
    "",
    `Arguments: \`${argv.join(" ")}\`. Each program runs in tsrs (\`TSRS_FAST=1 tsrs --fast\`, CLI chunks unless \`--hover\`) and is compared byte for byte with its native output.`,
    "",
    summary(rows),
    "",
    `Passing runs: median ${med(ok.map((r) => r.instantiations! / Math.max(1, r.refOps! - (r.startOps ?? 0)))).toFixed(0)} instantiations per reference op, median check time ${med(ok.map((r) => r.checkSeconds!)).toFixed(1)} s.`,
    "",
    "| program | set | result | ref ops | chunks | instantiations | inst/op | check s | peak GB | detail |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const r of rows)
    lines.push(
      `| ${r.name} | ${r.set} | ${r.pass ? "pass" : r.kind} | ${r.refOps ?? ""} | ${r.endedAt ?? r.lastGood ?? ""} | ${r.instantiations ?? ""} | ${r.instantiations && r.refOps ? Math.round(r.instantiations / Math.max(1, r.refOps - (r.startOps ?? 0))) : ""} | ${r.checkSeconds?.toFixed(1) ?? ""} | ${r.peakBytes ? (r.peakBytes / 2 ** 30).toFixed(2) : ""} | ${(r.detail ?? "").replaceAll("|", "\\|")} |`,
    );
  return lines.join("\n") + "\n";
}

if (import.meta.main) await main();
