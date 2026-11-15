// Runs a program on the reference interpreter (src/ref).
//   node scripts/run.ts prog.json [--json] [--ops] [--pause-at N --snapshot out.json]
//   node scripts/run.ts --resume snap.json [--json] [--ops] [--pause-at N --snapshot out.json]
// Without --json: writes the program's stdout/stderr (bytes) and exits with
// its status. With --json: prints { stdout, stderr, exit, ops } (byte
// strings), plus { byFunc, byKind } op counts with --ops. --pause (alias of
// --pause-at) stops after N total ops and writes the snapshot; the printed
// result then has "paused": true.
//   --check "ARGS"  instead of main, call the tsgo harness's
//                   `check(files map[string]string, args []string) int`
//                   (overlay/tsgo/cmd/tsgo/main.go) with the space-separated
//                   ARGS; each *.ts argument is read from disk as /p/<base>.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { Program } from "../src/ir/types.ts";
import { Machine } from "../src/ref/interp.ts";
import { restore, snapshot } from "../src/ref/snapshot.ts";
import { GoMap } from "../src/ref/gomap.ts";
import { Slice, utf8Bytes } from "../src/ref/values.ts";

function bootCheck(m: Machine, args: string[]) {
  const fid = m.prog.funcs.findIndex((f) => f.name.endsWith("/cmd/tsgo.check"));
  if (fid < 0) throw new Error("no cmd/tsgo.check in the program");
  const sig = m.prog.types[m.prog.funcs[fid]!.sig] as any;
  const [mapT] = sig.params as number[];
  const files = new GoMap(mapT!, m.types.key((m.types.info[mapT!]!.u as any).key));
  for (const a of args)
    if (!a.startsWith("-") && a.endsWith(".ts"))
      files.set(utf8Bytes("/p/" + basename(a)), readFileSync(a, "latin1"));
  const as = args.map(utf8Bytes);
  m.bootEntry(fid, [files, new Slice(as, 0, as.length, as.length)]);
}

const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(k);
const opt = (...ks: string[]) => {
  for (const k of ks) {
    const i = argv.indexOf(k);
    if (i >= 0) return argv[i + 1];
  }
  return undefined;
};
const json = flag("--json");
const resumeFile = opt("--resume");
const pauseAt = opt("--pause-at", "--pause");
const snapFile = opt("--snapshot");
const valued = new Set(["--resume", "--pause-at", "--pause", "--snapshot", "--check"]);
const checkArgs = opt("--check");
const progFile = argv.find((a, i) => !a.startsWith("--") && !valued.has(argv[i - 1] ?? ""));

const progCache = new Map<string, Program>();
function loadProg(p: string): Program {
  let prog = progCache.get(p);
  if (!prog) {
    prog = JSON.parse(readFileSync(p, "utf8")) as Program;
    progCache.set(p, prog);
  }
  return prog;
}

let m: Machine;
let progPath: string;
const t0 = performance.now();
if (resumeFile) {
  const snap = JSON.parse(readFileSync(resumeFile, "utf8"));
  progPath = progFile ? resolve(progFile) : snap.program.path;
  m = restore(loadProg(progPath), snap);
} else {
  if (!progFile) {
    console.error("usage: node scripts/run.ts prog.json [--json] [--pause-at N --snapshot f]");
    process.exit(64);
  }
  progPath = resolve(progFile);
  m = new Machine(loadProg(progPath));
  if (checkArgs !== undefined) bootCheck(m, checkArgs.split(/\s+/).filter(Boolean));
  else m.boot();
}
const state = m.run(pauseAt !== undefined ? Number(pauseAt) : Infinity);
const secs = (performance.now() - t0) / 1000;
if (state === "paused" || (pauseAt !== undefined && snapFile)) {
  if (snapFile) {
    mkdirSync(dirname(resolve(snapFile)), { recursive: true });
    writeFileSync(snapFile, JSON.stringify(snapshot(m, progPath)));
  }
}
const r = m.result();
if (json) {
  const o: any = { ...r, paused: state === "paused" };
  if (flag("--ops")) {
    const s = m.opStats();
    o.byFunc = s.byFunc;
    o.byKind = s.byKind;
    o.seconds = secs;
  }
  process.stdout.write(JSON.stringify(o) + "\n");
  process.exitCode = state === "paused" ? 0 : r.exit;
} else {
  process.stdout.write(Buffer.from(r.stdout, "latin1"));
  process.stderr.write(Buffer.from(r.stderr, "latin1"));
  if (flag("--ops")) {
    const s = m.opStats();
    const top = (o: Record<string, number>, n: number) =>
      Object.entries(o)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([k, v]) => `  ${v}\t${k}`)
        .join("\n");
    process.stderr.write(
      `ops ${s.total} in ${secs.toFixed(3)}s (${((s.total / secs) | 0).toLocaleString()} ops/s)\n` +
        `by kind:\n${top(s.byKind, 40)}\nby function:\n${top(s.byFunc, 30)}\n`,
    );
  }
  if (state === "paused") process.stderr.write(`paused after ${r.ops} ops\n`);
  process.exitCode = state === "paused" ? 0 : r.exit;
}
