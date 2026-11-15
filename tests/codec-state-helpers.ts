// Shared by the codec-state and types-run tests: corpus programs through the
// front end (cached under .run/ir) and reference snapshots.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Program } from "../src/ir/types.ts";
import { Machine } from "../src/ref/interp.ts";
import { snapshot } from "../src/ref/snapshot.ts";
import { repo } from "./types/tsrs-harness.ts";

export function program(name: string): Program {
  const out = join(repo, ".run/ir", `${name}.json`);
  if (!existsSync(out))
    execFileSync(
      "node",
      [join(repo, "scripts/frontend.ts"), join(repo, "tests/go", `${name}.go`), "-o", out],
      { stdio: "ignore" },
    );
  return JSON.parse(readFileSync(out, "utf8")) as Program;
}

export function snapAt(prog: Program, ops: number): any {
  const m = new Machine(prog);
  m.boot();
  m.run(ops);
  return JSON.parse(JSON.stringify(snapshot(m, "prog.json")));
}
