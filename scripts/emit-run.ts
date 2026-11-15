// Minimal stage 5 driver: runs a program in types (CLI chunks) and compares
// with the reference interpreter.
//   node scripts/emit-run.ts prog.json|file.go... [--chunks N] [--timeout s] [--show]
// Writes .run/emit/<name>/{prog.d.ts,main.ts}; runs tsrs through
// scripts/heavy.sh. Prints one line per program: ok / FAIL with details.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Program } from "../src/ir/types.ts";
import { emit } from "../src/emit/emit.ts";
import { writeRuntime } from "../src/emit/runtime.ts";
import { Machine } from "../src/ref/interp.ts";
import { strLit } from "../src/types/codec-heap.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1]! : d;
};
const valued = new Set(["--chunks", "--timeout", "--per", "--fuel"]);
const inputs = argv.filter((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1] ?? ""));
const timeout = Number(opt("--timeout", "300"));
const show = argv.includes("--show");

export interface RunOut {
  name: string;
  ok: boolean;
  inst: number;
  secs: number;
  chunks: number;
  ops: number;
  msg: string;
}

function irOf(input: string): string {
  if (input.endsWith(".json")) return input;
  const out = join(repo, ".run/ir", basename(input).replace(/\.go$/, ".json"));
  mkdirSync(dirname(out), { recursive: true });
  execFileSync(
    "node",
    [join(repo, "scripts/frontend.ts"), input, "-o", out, "--", "-tags", "purego,gointypes"],
    {
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  return out;
}

let runtimeDone = false;
export function runOne(input: string): RunOut {
  if (!runtimeDone) writeRuntime(join(repo, ".run/emit/rt"));
  runtimeDone = true;
  const irPath = irOf(input);
  const name = basename(irPath).replace(/\.json$/, "");
  const prog = JSON.parse(readFileSync(irPath, "utf8")) as Program;
  const m = new Machine(prog);
  m.boot();
  m.run(5e7);
  const ref = m.result();
  const dir = join(repo, ".run/emit", name);
  mkdirSync(dir, { recursive: true });
  const text = emit(prog, {
    rt: "../rt",
    fuel: argv.includes("--fuel") ? Number(opt("--fuel", "900")) : undefined,
  });
  writeFileSync(join(dir, "prog.d.ts"), text);
  const chunks = Number(
    opt("--chunks", String(Math.ceil(ref.ops / Number(opt("--per", "150"))) + 4)),
  );
  const L: string[] = [`import type { GS0, GChunk, GOut, GErr, GExit } from "./prog.d.ts";`];
  for (let i = 1; i <= chunks; i++)
    L.push(`type S${i} = GChunk<S${i - 1 || "0"}>;`.replace("S0>", "GS0>"));
  const last = `S${chunks}`;
  L.push(`type Res = [GOut<${last}>, GErr<${last}>, GExit<${last}>];`);
  L.push(`type Want = [${strLit(ref.stdout)}, ${strLit(ref.stderr)}, ${ref.exit}];`);
  L.push(
    "type Eq_<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;",
  );
  L.push(`export const ok: Eq_<Res, Want> = true;`);
  L.push(
    `export const show: 0 = null as any as [[GOut<${last}>, GErr<${last}>, GExit<${last}>], ${last}[0], ${last}[1]];`,
  );
  writeFileSync(join(dir, "main.ts"), L.join("\n") + "\n");
  const t0 = performance.now();
  const r = spawnSync(
    "sh",
    [
      join(repo, "scripts/heavy.sh"),
      "perl",
      "-e",
      "alarm shift; exec @ARGV",
      String(timeout),
      join(repo, "node_modules/.bin/tsrs"),
      "--ignoreConfig",
      "--fast",
      "--singleThreaded",
      "--extendedDiagnostics",
      "--noEmit",
      "--types",
      "",
      "--lib",
      "es2023",
      "--strict",
      "--skipLibCheck",
      "--noErrorTruncation",
      "--module",
      "nodenext",
      "--allowImportingTsExtensions",
      join(dir, "main.ts"),
    ],
    { env: { ...process.env, TSRS_FAST: "1" }, encoding: "utf8", maxBuffer: 1 << 30 },
  );
  const secs = (performance.now() - t0) / 1000;
  const outText = (r.stdout ?? "") + (r.stderr ?? "");
  writeFileSync(join(dir, "tsrs.out"), outText);
  const inst = Number(outText.match(/^Instantiations:\s+(\d+)/m)?.[1] ?? NaN);
  const errs = outText
    .split("\n")
    .filter((l) => /error TS/.test(l) && !/main\.ts\(\d+,\d+\): error TS2322: Type '\[\[/.test(l));
  const shown = outText.match(/error TS2322: Type '(\[\[.*)' is not assignable to type '0'/)?.[1];
  const ok = errs.length === 0 && !Number.isNaN(inst);
  let msg = "";
  if (!ok)
    msg = errs.length
      ? errs.slice(0, 3).join(" | ").slice(0, 2000)
      : "no result: " + outText.slice(-300);
  return { name, ok, inst, secs, chunks, ops: ref.ops, msg };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let pass = 0;
  for (const input of inputs) {
    if (!existsSync(input)) throw new Error("missing " + input);
    const r = runOne(input);
    if (r.ok) pass++;
    console.log(
      `${r.ok ? "ok  " : "FAIL"} ${r.name}: ${r.ops} ops, ${r.chunks} chunks, ${r.inst} inst (${(r.inst / r.ops).toFixed(0)}/op), ${r.secs.toFixed(1)} s${r.msg ? "\n     " + r.msg : ""}`,
    );
  }
  console.log(`${pass}/${inputs.length} ok`);
}
