// The engine pipeline as the gate and the fuzzer drive it:
//   Go file --front end--> prog.json --reference--> {stdout, stderr, exit, ops}
// Front end: `node scripts/frontend.ts` (branch stage2-frontend); before it
// exists, the frontend/ binary directly. Reference: `node scripts/run.ts`
// (branch stage2-ref), expected interface (see tests/go/README.md):
//   node scripts/run.ts <prog.json> --json                 -> result JSON on stdout
//   node scripts/run.ts <prog.json> --json --pause-at N --snapshot <file>
//                                                          -> pauses after N ops, writes the snapshot
//   node scripts/run.ts --resume <file> --json            -> resumes in a fresh process
// Result JSON: { stdout, stderr, exit, ops } with stdout/stderr as byte
// strings (one char per byte). If the reference's flags differ, adapt
// `reference`/`snapshot` here only.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
export const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface EngineResult {
  stdout: string;
  stderr: string;
  exit: number;
  ops: number;
}

export class StageError extends Error {
  stage: "front end" | "reference";
  constructor(stage: "front end" | "reference", msg: string) {
    super(msg);
    this.stage = stage;
  }
}

let feBin: Promise<string> | undefined;
function frontendBinary(): Promise<string> {
  feBin ??= (async () => {
    const bin = join(repo, ".run/gate-frontend");
    await run("go", ["build", "-o", bin, "."], { cwd: join(repo, "frontend") });
    return bin;
  })();
  return feBin;
}

/** Compiles a Go file to IR; returns the prog.json path. */
export async function frontend(file: string, outDir: string): Promise<string> {
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, basename(file).replace(/\.go$/, ".json"));
  try {
    if (existsSync(join(repo, "scripts/frontend.ts"))) {
      await run("node", [join(repo, "scripts/frontend.ts"), file, "-o", out, "--config", "tests"], {
        cwd: repo,
        maxBuffer: 64 << 20,
      });
    } else {
      const bin = await frontendBinary();
      await run(
        bin,
        [
          "-C",
          dirname(file),
          "-overlay",
          join(repo, "overlay/tests.json"),
          "-o",
          out,
          basename(file),
        ],
        {
          maxBuffer: 64 << 20,
        },
      );
    }
  } catch (e: any) {
    throw new StageError(
      "front end",
      String(e.stderr || e.message)
        .trim()
        .split("\n")
        .slice(-3)
        .join(" | "),
    );
  }
  return out;
}

async function ref(args: string[], timeoutMs: number): Promise<EngineResult> {
  if (!existsSync(join(repo, "scripts/run.ts")))
    throw new StageError("reference", "scripts/run.ts missing (merge stage2-ref)");
  let stdout: string;
  try {
    ({ stdout } = await run("node", [join(repo, "scripts/run.ts"), ...args], {
      cwd: repo,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 256 << 20,
    }));
  } catch (e: any) {
    // A non-zero exit is fine when the JSON result was printed (Go exit status).
    stdout = e.stdout ?? "";
    if (!stdout.trim().startsWith("{"))
      throw new StageError(
        "reference",
        (e.killed ? "timeout " : "") +
          String(e.stderr || e.message)
            .trim()
            .split("\n")
            .slice(-3)
            .join(" | "),
      );
  }
  try {
    const r = JSON.parse(stdout.slice(stdout.indexOf("{")));
    return { stdout: r.stdout, stderr: r.stderr, exit: r.exit, ops: Number(r.ops?.total ?? r.ops) };
  } catch {
    throw new StageError("reference", "unparsable result: " + stdout.slice(0, 200));
  }
}

export function reference(prog: string, timeoutMs = 120_000): Promise<EngineResult> {
  return ref([prog, "--json"], timeoutMs);
}

/** Pause after `at` ops, then resume from the snapshot in a fresh process. */
export async function snapshot(
  prog: string,
  at: number,
  snap: string,
  timeoutMs = 120_000,
): Promise<EngineResult> {
  await ref([prog, "--json", "--pause-at", String(at), "--snapshot", snap], timeoutMs);
  return ref(["--resume", snap, "--json"], timeoutMs);
}
