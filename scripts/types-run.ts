// Runs a program in types: emit (scripts/emit.ts) -> a driver that runs the
// emitted machine chunk by chunk -> tsrs (TSRS_FAST=1, through
// scripts/heavy.sh) -> the decoded result, compared with the reference.
//
//   node scripts/types-run.ts prog.json [--from snapshot.json] [--drive N]
//        [--chunks N] [--hover] [--timeout S] [--out DIR] [--json] [--expect file.out]
//
//   --from S     start from reference snapshot S (scripts/run.ts --snapshot):
//                the reference first runs on to the next point the type level
//                can start at (src/types/codec-state.ts), then the state is
//                converted; the result must equal the reference's full run.
//   --drive N    chunks (GChunk) per CLI statement (default 1)
//   --chunks N   CLI statements (default: from the reference's op count; an
//                unfinished run is retried with 4x the chunks, up to 3 times)
//   --hover      one hover of `GExec` (fuel pool) through tsrs --lsp instead
//                of the CLI
//   --timeout S  seconds per tsrs run (default 600)
//   --expect F   compare with a tests/go .out file (else with the reference)
//
// CLI form: `.run/types/<name>/run.ts` holds `type S0 = <start>;`, one
// `type Sk = GChunk<Sk-1>;` per statement (the CLI zeroes its instantiation
// counter per statement), a probe per statement (`GExit<Sk>` assigned to a
// string: the error prints -1 while running, the exit status when done, and
// nothing when the state is any or never), the printed result, and an exact
// equality with the expected result.
//
// Failure classes (TypesResult.kind): "emit" (the emitter failed), "codec"
// (the start state could not be built), "TS2589 count" / "TS2589 depth"
// (told apart by the instantiations of the failing statement: >= 4M is the
// count limit), "TS2859" (relation cache full), "broken state" (a chunk's
// state is any or never with no diagnostic), "unfinished", "timeout",
// "unsupported" (the run trapped on "X is not supported in types"), "trap"
// (any other trap the native run does not hit), "wrong output" (first
// differing line), "other" (any other diagnostic).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Program } from "../src/ir/types.ts";
import { Machine } from "../src/ref/interp.ts";
import { restore } from "../src/ref/snapshot.ts";
import { strLit } from "../src/types/codec-heap.ts";
import { startState } from "../src/types/codec-state.ts";
import { firstDiff, formatOut } from "./go-out.ts";
import { hover } from "./hover.ts";

export const repo = resolve(import.meta.dirname, "..");
const tsrsBin = join(repo, "node_modules/.bin/tsrs");
const heavy = join(repo, "scripts/heavy.sh");
const PREFIX = "G";

export interface Expected {
  stdout: string;
  stderr: string;
  exit: number;
  ops: number;
}

export interface TypesOptions {
  /** prog.json path */
  prog: string;
  /** output directory (default .run/types/<prog basename>) */
  dir?: string;
  /** reference snapshot (JSON object or file) to start from */
  from?: any;
  drive?: number;
  chunks?: number;
  hover?: boolean;
  timeoutSec?: number;
  /** expected .out text (tests/go); default: the reference's own result */
  expectOut?: string;
  /** the reference's result if known (saves a run) */
  ref?: Expected;
  /** retries with 4x the chunks when unfinished */
  retries?: number;
}

export interface TypesResult {
  pass: boolean;
  kind: string;
  detail?: string;
  stdout?: string;
  stderr?: string;
  exit?: number;
  /** statements (chunks) written, and the one the run ended at */
  chunks: number;
  endedAt?: number;
  /** the last chunk whose state resolved */
  lastGood: number;
  instantiations: number;
  checkSeconds: number;
  wallSeconds: number;
  peakBytes: number;
  refOps: number;
  /** ops the reference ran before the start state (--from) */
  startOps?: number;
  dir: string;
}

// ---------------------------------------------------------------- emit

/** Emits prog.json to `<dir>/prog.d.ts` (cached while prog.json and src/emit are older). */
export function emit(prog: string, dir: string): void {
  mkdirSync(dir, { recursive: true });
  const out = join(dir, "prog.d.ts");
  const srcTime = Math.max(
    statSync(prog).mtimeMs,
    ...["src/emit", "scripts/emit.ts", "src/types"].map((p) =>
      existsSync(join(repo, p)) ? newest(join(repo, p)) : 0,
    ),
  );
  if (existsSync(out) && statSync(out).mtimeMs > srcTime) return;
  const r = spawnSync("node", [join(repo, "scripts/emit.ts"), prog, "-o", out], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 256 << 20,
  });
  if (r.status !== 0)
    throw new StageFail(
      "emit",
      (r.stderr || r.stdout || String(r.error)).trim().split("\n").slice(-3).join(" | "),
    );
}
/** The newest modification time of a file or of any file under a directory. */
export function newest(p: string): number {
  const st = statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let t = st.mtimeMs;
  for (const e of readdirSync(p)) t = Math.max(t, newest(join(p, e)));
  return t;
}

export class StageFail extends Error {
  kind: string;
  constructor(kind: string, msg: string) {
    super(msg);
    this.kind = kind;
  }
}

// ---------------------------------------------------------------- reference

const progCache = new Map<string, Program>();
export function loadProg(p: string): Program {
  let prog = progCache.get(p);
  if (!prog) progCache.set(p, (prog = JSON.parse(readFileSync(p, "utf8")) as Program));
  return prog;
}

/** The reference's full result (from the start, or from a snapshot). */
export function reference(prog: Program, from?: any): Expected {
  const m = from ? restore(prog, from) : new Machine(prog);
  if (!from) m.boot();
  m.run();
  return m.result();
}

// ---------------------------------------------------------------- driver files

const lit = strLit;

function writeProject(dir: string, text: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.ts"), text);
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "esnext",
          lib: ["es2023"],
          module: "nodenext",
          moduleResolution: "nodenext",
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
          skipLibCheck: true,
          types: [],
        },
        files: ["run.ts"],
      },
      null,
      1,
    ) + "\n",
  );
  return join(dir, "run.ts");
}

/** The start state's declarations (the emitted GS0, or a state module from a snapshot). */
function startDecl(from: boolean): { imports: string[]; s0: string } {
  return from
    ? { imports: [`import type { Start } from "./start.d.ts";`], s0: "Start" }
    : { imports: [], s0: `${PREFIX}S0` };
}

const header = (from: boolean) => {
  const st = startDecl(from);
  const P = PREFIX;
  return [
    "// Generated by scripts/types-run.ts; do not edit.",
    `import type { ${P}S0, ${P}Chunk, ${P}Out, ${P}Err, ${P}Exit, ${P}Exec } from "./prog.d.ts";`,
    ...st.imports,
    "type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;",
    `type S0 = ${st.s0};`,
    `export type { ${P}S0, ${P}Exec };`,
  ];
};

export function cliText(from: boolean, chunks: number, drive: number, want: Expected) {
  const lines = header(from);
  const chunk = (s: string) => {
    let t = s;
    for (let i = 0; i < drive; i++) t = `${PREFIX}Chunk<${t}>`;
    return t;
  };
  const firstStmt = lines.length + 1;
  for (let k = 1; k <= chunks; k++) lines.push(`type S${k} = ${chunk(`S${k - 1}`)};`);
  const probeLine = lines.length + 1;
  for (let k = 1; k <= chunks; k++)
    lines.push(`export const p${k}: "probe" = null! as ${PREFIX}Exit<S${k}>;`);
  const outLine = lines.length + 1;
  const r = `[${PREFIX}Out<S${chunks}>, ${PREFIX}Err<S${chunks}>, ${PREFIX}Exit<S${chunks}>]`;
  lines.push(`export const out: "probe" = null! as ${r};`);
  lines.push(
    `export const ok: Equal<${r}, [${lit(want.stdout)}, ${lit(want.stderr)}, ${want.exit}]> = true;`,
  );
  return { text: lines.join("\n") + "\n", firstStmt, probeLine, outLine };
}

export function hoverText(from: boolean, want: Expected) {
  const lines = header(from);
  lines.push(`type Run = ${PREFIX}Exec<S0, "0">;`);
  lines.push(`type Result = [${PREFIX}Out<Run>, ${PREFIX}Err<Run>, ${PREFIX}Exit<Run>];`);
  lines.push(`type Ok = Equal<Result, [${lit(want.stdout)}, ${lit(want.stderr)}, ${want.exit}]>;`);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------- tsrs

export interface TsrsRun {
  out: string;
  wall: number;
  peak: number;
  timedOut: boolean;
}

/** `tsrs --noEmit -p dir` in a heavy slot, with a timeout (kills the process group). */
export function runTsrs(dir: string, timeoutSec: number): Promise<TsrsRun> {
  const t0 = performance.now();
  return new Promise((done, fail) => {
    const p = spawn(
      heavy,
      [
        "/usr/bin/time",
        "-l",
        tsrsBin,
        "--noEmit",
        "--fast",
        "--singleThreaded",
        "--extendedDiagnostics",
        "--pretty",
        "false",
        "--noErrorTruncation",
        "-p",
        dir,
      ],
      { env: { ...process.env, TSRS_FAST: "1" }, detached: true },
    );
    let timedOut = false;
    let started = 0;
    // the timeout counts from when the slot is held (heavy.sh may wait)
    const poll = setInterval(() => {
      if (started === 0 && hasChild(p.pid!)) started = performance.now();
      if (started > 0 && performance.now() - started > timeoutSec * 1000) {
        timedOut = true;
        try {
          process.kill(-p.pid!, "SIGKILL");
        } catch {
          // gone
        }
      }
    }, 500);
    let out = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString("latin1")));
    p.stderr.on("data", (d: Buffer) => (out += d.toString("latin1")));
    p.on("error", fail);
    p.on("close", () => {
      clearInterval(poll);
      const peak = Number(/(\d+)\s+maximum resident set size/.exec(out)?.[1] ?? 0);
      done({ out, wall: (performance.now() - t0) / 1000, peak, timedOut });
    });
  });
}
function hasChild(pid: number): boolean {
  const r = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  return r.stdout.trim() !== "";
}

export interface Diag {
  line: number;
  code: string;
  message: string;
}
/** run.ts diagnostics; a message may span lines (a printed type with raw newlines). */
export function diagnostics(out: string): Diag[] {
  const ds: Diag[] = [];
  let cur: Diag | null = null;
  for (const l of out.split("\n")) {
    const m = /^(\S+)\((\d+),\d+\): error (TS\d+): (.*)$/.exec(l);
    if (m) {
      cur = m[1]!.endsWith("run.ts") ? { line: Number(m[2]), code: m[3]!, message: m[4]! } : null;
      if (cur) ds.push(cur);
    } else if (
      /^(Files|Lines|Identifiers|Symbols|Types|Instantiations|Memory used|\s+\d+ maximum)/.test(l)
    )
      cur = null;
    else if (cur) cur.message += "\n" + l;
  }
  return ds;
}
/** Errors reported in files other than run.ts (the emitted module, the runtime). */
export const foreignErrors = (out: string): string[] =>
  out
    .split("\n")
    .filter((l) => /error TS\d+/.test(l) && !/run\.ts\(/.test(l))
    .map((l) => l.trim().slice(0, 300));
export const instCount = (out: string) => Number(/Instantiations:\s+(\d+)/.exec(out)?.[1] ?? NaN);

/** A printed type literal (string, number, tuple of those) back to plain values. */
export function parsePrinted(t: string): any {
  let i = 0;
  const ws = () => {
    while (/\s/.test(t[i] ?? "")) i++;
  };
  const val = (): any => {
    ws();
    const c = t[i];
    if (c === "[") {
      i++;
      const xs: any[] = [];
      ws();
      while (t[i] !== "]") {
        xs.push(val());
        ws();
        if (t[i] === ",") i++;
        ws();
      }
      i++;
      return xs;
    }
    if (c === '"' || c === "'") {
      let o = "";
      i++;
      while (t[i] !== c) {
        let ch = t[i++]!;
        if (ch === "\\") {
          const e = t[i++]!;
          if (e === "x") {
            ch = String.fromCharCode(parseInt(t.slice(i, i + 2), 16));
            i += 2;
          } else if (e === "u") {
            if (t[i] === "{") {
              const j = t.indexOf("}", i);
              ch = String.fromCodePoint(parseInt(t.slice(i + 1, j), 16));
              i = j + 1;
            } else {
              ch = String.fromCharCode(parseInt(t.slice(i, i + 4), 16));
              i += 4;
            }
          } else
            ch =
              (
                { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" } as Record<
                  string,
                  string
                >
              )[e] ?? e;
        }
        o += ch;
      }
      i++;
      return o;
    }
    const m = /^-?[\w.]+/.exec(t.slice(i))!;
    i += m[0].length;
    return /^-?\d/.test(m[0]) ? Number(m[0]) : { id: m[0] };
  };
  return val();
}

/** Printed byte strings may carry chars >= 0x100 if the printer decoded UTF-8; we only print bytes. */
const assignMsg = /^Type '([\s\S]*)' is not assignable to type '"probe"'\.$/;

// ---------------------------------------------------------------- one run

export async function runTypes(o: TypesOptions): Promise<TypesResult> {
  const prog = loadProg(o.prog);
  const name = basename(o.prog).replace(/\.json$/, "");
  const dir = o.dir ?? join(repo, ".run/types", name);
  const timeoutSec = o.timeoutSec ?? 600;
  const drive = o.drive ?? 1;
  const ref = o.ref ?? reference(prog);
  const base: TypesResult = {
    pass: false,
    kind: "",
    chunks: 0,
    lastGood: 0,
    instantiations: 0,
    checkSeconds: 0,
    wallSeconds: 0,
    peakBytes: 0,
    refOps: ref.ops,
    dir,
  };
  try {
    emit(o.prog, dir);
  } catch (e) {
    if (e instanceof StageFail) return { ...base, kind: e.kind, detail: e.message };
    throw e;
  }
  let startOps = 0;
  if (o.from) {
    try {
      const snap = typeof o.from === "string" ? JSON.parse(readFileSync(o.from, "utf8")) : o.from;
      const st = startState(prog, snap, {
        rt: "./rt",
        emitted: readFileSync(join(dir, "prog.d.ts"), "utf8"),
        entries: existsSync(join(dir, "prog.entries.json"))
          ? JSON.parse(readFileSync(join(dir, "prog.entries.json"), "utf8"))
          : undefined,
      });
      writeFileSync(join(dir, "start.d.ts"), st.module);
      startOps = st.ops;
    } catch (e: any) {
      return { ...base, kind: "codec", detail: String(e?.message ?? e).split("\n")[0] };
    }
  }
  const want: Expected = ref;
  const wantOut = o.expectOut ?? formatOut(ref.stdout, ref.stderr, ref.exit);
  if (o.hover) return hoverRun(o, dir, want, wantOut, { ...base, startOps });

  let chunks = o.chunks ?? estimateChunks(ref.ops - startOps, drive);
  for (let attempt = 0; ; attempt++) {
    const r = await cliRun(dir, !!o.from, chunks, drive, want, wantOut, timeoutSec, {
      ...base,
      startOps,
    });
    if (r.kind !== "unfinished" || o.chunks || attempt >= (o.retries ?? 3)) return r;
    chunks *= 4;
  }
}

/** CLI statements for a run of n reference ops: a guess with headroom (a finished state stays put). */
export function estimateChunks(ops: number, drive: number): number {
  return Math.ceil(ops / 800 / drive) + 8;
}

async function cliRun(
  dir: string,
  from: boolean,
  chunks: number,
  drive: number,
  want: Expected,
  wantOut: string,
  timeoutSec: number,
  base: TypesResult,
): Promise<TypesResult> {
  const c = cliText(from, chunks, drive, want);
  writeProject(dir, c.text);
  const t = await runTsrs(dir, timeoutSec);
  writeFileSync(join(dir, "tsrs.log"), t.out);
  const row: TypesResult = {
    ...base,
    chunks,
    instantiations: instCount(t.out),
    checkSeconds: Number(/Check time:\s+([\d.]+)s/.exec(t.out)?.[1] ?? NaN),
    wallSeconds: t.wall,
    peakBytes: t.peak,
  };
  const exits = new Map<number, number>();
  let printed: any;
  let okFailed = false;
  const other: Diag[] = [];
  for (const d of diagnostics(t.out)) {
    const m = assignMsg.exec(d.message);
    if (d.line >= c.probeLine && d.line < c.outLine && m)
      exits.set(d.line - c.probeLine + 1, Number(m[1]));
    else if (d.line === c.outLine && m) printed = parsePrinted(m[1]!);
    else if (d.line === c.outLine + 1) okFailed = true;
    else other.push(d);
  }
  for (let k = 1; k <= chunks; k++) {
    const x = exits.get(k);
    if (x === undefined || Number.isNaN(x)) break;
    row.lastGood = k;
    if (x !== -1) {
      row.endedAt = k;
      break;
    }
  }
  setResult(row, printed);
  if (t.timedOut) return { ...row, kind: "timeout", detail: `killed after ${timeoutSec} s` };
  const stmtOf = (line: number) => line - c.firstStmt + 1;
  const deep = other.find((d) => d.code === "TS2589");
  if (deep) {
    const k = stmtOf(deep.line);
    const cls = await classify2589(dir, from, k, drive, want, timeoutSec);
    return { ...row, kind: cls.kind, detail: cls.detail };
  }
  const full = other.find((d) => d.code === "TS2859");
  if (full) return { ...row, kind: "TS2859", detail: `statement ${stmtOf(full.line)}` };
  const foreign = foreignErrors(t.out);
  if (foreign.length > 0 && other.length === 0)
    return { ...row, kind: "other", detail: `${foreign.length} errors elsewhere; ${foreign[0]}` };
  if (other.length > 0)
    return {
      ...row,
      kind: "other",
      detail: `${other.length} diagnostics; ${other[0]!.line}: ${other[0]!.code} ${other[0]!.message.slice(0, 200)}`,
    };
  if (row.endedAt === undefined) {
    if (row.lastGood < chunks)
      return {
        ...row,
        kind: "broken state",
        detail: `statement ${row.lastGood + 1} is any or never`,
      };
    return { ...row, kind: "unfinished", detail: `still running after ${chunks} statements` };
  }
  const got = formatOut(row.stdout ?? "", row.stderr ?? "", row.exit ?? -1);
  // the Equal check is authoritative; the printed result explains a failure
  const gap = /trap: (.*?) is not supported in types/.exec(row.stderr ?? "");
  if (okFailed && gap && !wantOut.includes(gap[0]))
    return { ...row, kind: "unsupported", detail: gap[1] };
  const trap = /trap: [^\n]*/.exec(row.stderr ?? "");
  if (okFailed && trap && !wantOut.includes(trap[0]))
    return { ...row, kind: "trap", detail: trap[0].slice(0, 200) };
  if (okFailed)
    return {
      ...row,
      kind: "wrong output",
      detail: got !== wantOut ? firstDiff(wantOut, got) : "printed output matches; Equal failed",
    };
  return { ...row, pass: true, kind: "pass" };
}

/**
 * A TS2589 at statement k: the instantiations of statements 1..k minus
 * those of 1..k-1 (two CLI runs). >= 4.9M: the count limit; fewer: depth.
 */
async function classify2589(
  dir: string,
  from: boolean,
  k: number,
  drive: number,
  want: Expected,
  timeoutSec: number,
): Promise<{ kind: string; detail: string }> {
  const sub = async (n: number) => {
    const d = join(dir, `k${n}`);
    const c = cliText(from, n, drive, want);
    // the probes and result lines are dropped: only the statements count
    const text =
      c.text
        .split("\n")
        .slice(0, c.probeLine - 1)
        .join("\n") + "\n";
    writeProject(d, text.replace(/"\.\/(prog|start)\.d\.ts"/g, '"../$1.d.ts"'));
    return runTsrs(d, timeoutSec);
  };
  const [a, b] = await Promise.all([sub(k - 1), sub(k)]);
  if (a.timedOut || b.timedOut)
    return { kind: "TS2589 (unclassified)", detail: `statement ${k}; the rerun timed out` };
  const cost = instCount(b.out) - instCount(a.out);
  // a statement stopped by the count limit has counted most of its 5M before
  // the error (the CLI also zeroes the counter at a type node's first
  // resolution, so the difference can fall short of 5M)
  return cost >= 4_000_000
    ? {
        kind: "TS2589 count",
        detail: `statement ${k} costs ${(cost / 1e6).toFixed(1)}M instantiations`,
      }
    : {
        kind: "TS2589 depth",
        detail: `statement ${k} fails after ${(cost / 1e6).toFixed(2)}M instantiations`,
      };
}

async function hoverRun(
  o: TypesOptions,
  dir: string,
  want: Expected,
  wantOut: string,
  base: TypesResult,
): Promise<TypesResult> {
  const file = writeProject(dir, hoverText(!!o.from, want));
  const t0 = performance.now();
  let h;
  try {
    h = await hover(file, "Result", { timeoutMs: (o.timeoutSec ?? 600) * 1000 });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    return {
      ...base,
      kind: msg.startsWith("timeout") ? "timeout" : "other",
      detail: msg,
      wallSeconds: (performance.now() - t0) / 1000,
    };
  }
  const row: TypesResult = { ...base, wallSeconds: h.seconds, peakBytes: h.peakBytes };
  const text = h.text.replace(/^type Result = /, "");
  let printed: any;
  try {
    printed = parsePrinted(text);
  } catch {
    return { ...row, kind: "other", detail: `unparsable hover ${text.slice(0, 100)}` };
  }
  if (!Array.isArray(printed) || printed.some((x) => typeof x === "object"))
    return { ...row, kind: "broken state", detail: `hover shows ${text.slice(0, 100)}` };
  setResult(row, printed);
  if (row.exit === -1) return { ...row, kind: "unfinished", detail: "GExec ended unfinished" };
  const got = formatOut(row.stdout ?? "", row.stderr ?? "", row.exit ?? -1);
  if (got !== wantOut) return { ...row, kind: "wrong output", detail: firstDiff(wantOut, got) };
  return { ...row, pass: true, kind: "pass" };
}

/** The printed [Out, Err, Exit] into the row (elements that are not literals stay unset). */
function setResult(row: TypesResult, printed: any): void {
  if (!Array.isArray(printed)) return;
  const [o, e, x] = printed;
  if (typeof o === "string") row.stdout = o;
  if (typeof e === "string") row.stderr = e;
  if (typeof x === "number") row.exit = x;
}

export const rowText = (name: string, r: Partial<TypesResult> & { kind: string }): string => {
  const n = (x: number | undefined, d = 1) => (x ?? 0).toFixed(d);
  if (r.chunks === undefined) return `FAIL  ${name}  ${r.kind}: ${r.detail ?? ""}`;
  return [
    r.pass ? "PASS" : "FAIL",
    name,
    r.endedAt !== undefined
      ? `ended at ${r.endedAt}/${r.chunks}`
      : `reached ${r.lastGood}/${r.chunks}`,
    `${n((r.instantiations ?? 0) / 1e6)}M inst`,
    `check ${n(r.checkSeconds)} s (wall ${n(r.wallSeconds)} s)`,
    `peak ${n((r.peakBytes ?? 0) / 2 ** 30, 2)} GB`,
    `ref ${r.refOps} ops${r.startOps ? ` (from ${r.startOps})` : ""}`,
    ...(r.pass ? [] : [`${r.kind}: ${r.detail ?? ""}`]),
  ].join("  ");
};

// ---------------------------------------------------------------- CLI

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
  const valued = ["--from", "--drive", "--chunks", "--timeout", "--out", "--expect"];
  const progFile = argv.find((a, i) => !a.startsWith("--") && !valued.includes(argv[i - 1] ?? ""));
  if (!progFile) {
    console.error(
      "usage: node scripts/types-run.ts prog.json [--from snap.json] [--drive N] [--chunks N] [--hover] [--timeout S] [--out DIR] [--expect file.out] [--json]",
    );
    process.exit(64);
  }
  const prog = resolve(progFile);
  const from = opt("--from");
  const r = await runTypes({
    prog,
    from: from ? resolve(from) : undefined,
    drive: opt("--drive") ? Number(opt("--drive")) : undefined,
    chunks: opt("--chunks") ? Number(opt("--chunks")) : undefined,
    hover: argv.includes("--hover"),
    timeoutSec: opt("--timeout") ? Number(opt("--timeout")) : undefined,
    dir: opt("--out") ? resolve(opt("--out")!) : undefined,
    expectOut: opt("--expect") ? readFileSync(opt("--expect")!, "latin1") : undefined,
  });
  if (argv.includes("--json")) console.log(JSON.stringify(r));
  else {
    if (r.stdout !== undefined) process.stdout.write(Buffer.from(r.stdout, "latin1"));
    if (r.stderr !== undefined) process.stderr.write(Buffer.from(r.stderr, "latin1"));
    console.error(rowText(basename(dirname(prog)) + "/" + basename(prog), r));
  }
  process.exitCode = r.pass ? 0 : 1;
}
