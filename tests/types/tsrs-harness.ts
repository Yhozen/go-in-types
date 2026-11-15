// Runs type-level checks on stock tsrs: writes a .ts file of cases
// `type C_i = <actual>; type X_i = <expected>;` with an exact-equality
// assertion each, runs `tsrs --noEmit`, and maps errors back to cases.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const tsrsBin = join(repo, "node_modules/.bin/tsrs");
export const scratch = join(repo, ".run/types-tests");

export interface Case {
  name: string;
  actual: string;
  expected: string;
}

export interface RunResult {
  /** names of failing cases with the checker's message */
  failures: { name: string; msg: string }[];
  /** errors not attributable to a case */
  other: string[];
  inst: number;
  out: string;
}

/** Imports for a generated file at `.run/types-tests/<file>` of modules under src/types. */
export function importLine(names: string[], mod: string, dir = scratch): string {
  const p = relative(dir, join(repo, "src/types", mod)).replaceAll("\\", "/");
  return `import type { ${names.join(", ")} } from "${p.startsWith(".") ? p : "./" + p}";`;
}

export function runCases(
  file: string,
  header: string,
  cases: Case[],
  opts: { timeoutMs?: number } = {},
): RunResult {
  mkdirSync(scratch, { recursive: true });
  const lines: string[] = [header];
  lines.push(
    "type Eq_<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;",
  );
  lines.push("type NotAny<T> = 0 extends 1 & T ? false : [T] extends [never] ? false : true;");
  const lineOf = new Map<number, string>();
  cases.forEach((c, i) => {
    lines.push(`type C_${i} = ${c.actual};`);
    lines.push(`type X_${i} = ${c.expected};`);
    lineOf.set(lines.length + 1, c.name);
    lines.push(`export const ok_${i}: [Eq_<C_${i}, X_${i}>, NotAny<C_${i}>] = [true, true];`);
  });
  const path = join(scratch, file);
  writeFileSync(path, lines.join("\n") + "\n");
  const r = spawnSync(
    tsrsBin,
    [
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
      "--module",
      "nodenext",
      "--allowImportingTsExtensions",
      path,
    ],
    {
      env: { ...process.env, TSRS_FAST: "1" },
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 600_000,
    },
  );
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const failures: { name: string; msg: string }[] = [];
  const other: string[] = [];
  for (const l of out.split("\n")) {
    const m = l.match(/\((\d+),\d+\): error (TS\d+: .*)$/);
    if (!m) continue;
    const name = lineOf.get(Number(m[1]));
    if (name !== undefined && l.includes(file)) failures.push({ name, msg: m[2]! });
    else other.push(l);
  }
  const inst = Number(out.match(/^Instantiations:\s+(\d+)/m)?.[1] ?? NaN);
  if (Number.isNaN(inst))
    other.push("tsrs did not finish: " + (r.error?.message ?? out.slice(-500)));
  return { failures, other, inst, out };
}
