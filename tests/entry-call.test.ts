// A start state for an entry call on a machine at rest (codec-state
// `callState`, EMIT.md "e" continuations), with the call's string argument
// a type parameter: tests/entry/entry.go's `count(s)`, after init, in types
// for two arguments, against the reference's `callEntry`.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import type { Program } from "../src/ir/types.ts";
import { Machine } from "../src/ref/interp.ts";
import { restore, snapshot } from "../src/ref/snapshot.ts";
import { strLit } from "../src/types/codec-heap.ts";
import { callState, startState } from "../src/types/codec-state.ts";
import { diagnostics, emit, parsePrinted, runTsrs } from "../scripts/types-run.ts";
import { repo } from "./types/tsrs-harness.ts";

test("an entry call with a templated string argument, in types", async () => {
  const dir = join(repo, ".run/types-test/entry");
  mkdirSync(dir, { recursive: true });
  const progPath = join(dir, "entry.json");
  execFileSync(
    "node",
    [
      join(repo, "scripts/frontend.ts"),
      join(repo, "tests/entry/entry.go"),
      "-o",
      progPath,
      "--",
      "-entry",
      "count=command-line-arguments.count",
    ],
    { stdio: "ignore" },
  );
  const prog = JSON.parse(readFileSync(progPath, "utf8")) as Program;
  const fid = prog.funcs.findIndex((f) => f.name === "command-line-arguments.count");
  expect(fid).toBeGreaterThanOrEqual(0);
  // the machine at rest: init and main done
  const m = new Machine(prog);
  m.boot();
  m.run();
  m.out = [];
  const snap = JSON.parse(JSON.stringify(snapshot(m, progPath)));
  const args = ["hello", "x"];
  // the reference: a fresh restore of the snapshot per call
  const want = args.map((a) => {
    const mm = restore(prog, snap);
    mm.callEntry(fid, [a]);
    mm.run();
    return mm.result();
  });
  expect(want[0]!.stdout).toBe("count hello\n");
  expect(want.map((w) => w.exit)).toEqual([3772, 3772]);
  emit(progPath, dir);
  const { module, dead } = callState(prog, snap, {
    rt: "./rt",
    fid,
    args: ["Src"],
    params: "Src extends string",
  });
  expect(dead).toEqual([]);
  writeFileSync(join(dir, "start.d.ts"), module);
  // the first call paused halfway: a mid-run start whose bottom is the entry
  const mid = restore(prog, snap);
  mid.callEntry(fid, [args[0]]);
  mid.run(mid.ops + Math.floor((want[0]!.ops - mid.ops) / 2));
  const st = startState(prog, JSON.parse(JSON.stringify(snapshot(mid, progPath))), {
    rt: "./rt",
    emitted: "",
    entries: JSON.parse(readFileSync(join(dir, "prog.entries.json"), "utf8")),
  });
  expect(st.snap.frames.length).toBeGreaterThan(1);
  writeFileSync(join(dir, "mid.d.ts"), st.module.replace("export type Start", "export type Mid"));
  const lines = [
    `import type { GChunk, GOut, GErr, GExit } from "./prog.d.ts";`,
    `import type { Start } from "./start.d.ts";`,
    `import type { Mid } from "./mid.d.ts";`,
  ];
  args.forEach((a, i) => {
    lines.push(`type A${i}_0 = Start<${strLit(a)}>;`);
    for (let k = 1; k <= 20; k++) lines.push(`type A${i}_${k} = GChunk<A${i}_${k - 1}>;`);
    lines.push(
      `export const r${i}: "probe" = null! as [GOut<A${i}_20>, GErr<A${i}_20>, GExit<A${i}_20>];`,
    );
  });
  lines.push(`type M_0 = Mid;`);
  for (let k = 1; k <= 20; k++) lines.push(`type M_${k} = GChunk<M_${k - 1}>;`);
  lines.push(`export const m: "probe" = null! as [GOut<M_20>, GErr<M_20>, GExit<M_20>];`);
  writeFileSync(join(dir, "run.ts"), lines.join("\n") + "\n");
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: "nodenext",
        moduleResolution: "nodenext",
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        types: [],
      },
      files: ["run.ts"],
    }),
  );
  const t = await runTsrs(dir, 300);
  const got = diagnostics(t.out).map((d) => {
    const mm = /^Type '([\s\S]*)' is not assignable to type '"probe"'\.$/.exec(d.message);
    return mm ? parsePrinted(mm[1]!) : d.message;
  });
  expect(got).toEqual([...want, want[0]!].map((w) => [w.stdout, w.stderr, w.exit]));
}, 600_000);
