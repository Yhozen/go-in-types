// The types runner (scripts/types-run.ts): result decoding, diagnostics,
// driver text, and one end-to-end run of hello.go (from the start and from a
// mid-run snapshot).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { Machine } from "../src/ref/interp.ts";
import { snapshot } from "../src/ref/snapshot.ts";
import {
  cliText,
  diagnostics,
  estimateChunks,
  parsePrinted,
  runTypes,
} from "../scripts/types-run.ts";
import { program } from "./codec-state-helpers.ts";
import { repo } from "./types/tsrs-harness.ts";

test("printed results decode", () => {
  expect(parsePrinted(`["hello\\n", "", 0]`)).toEqual(["hello\n", "", 0]);
  expect(parsePrinted(`["a\\"b\\\\c\\x00\\u00e9", "x\\ty", -1]`)).toEqual([
    'a"b\\c\x00\xe9',
    "x\ty",
    -1,
  ]);
  expect(parsePrinted(`[any, never, 2]`)).toEqual([{ id: "any" }, { id: "never" }, 2]);
});

test("diagnostics keep multi-line messages and skip other files", () => {
  const out = [
    `run.ts(3,14): error TS2322: Type '"a`,
    `b"' is not assignable to type '"probe"'.`,
    `rt/rt.d.ts(1,1): error TS2590: Expression produces a union type that is too complex to represent.`,
    `run.ts(4,11): error TS2589: Type instantiation is excessively deep and possibly infinite.`,
    `Files:  12`,
  ].join("\n");
  expect(diagnostics(out)).toEqual([
    { line: 3, code: "TS2322", message: `Type '"a\nb"' is not assignable to type '"probe"'.` },
    {
      line: 4,
      code: "TS2589",
      message: "Type instantiation is excessively deep and possibly infinite.",
    },
  ]);
});

test("driver text: one statement per chunk, probes, result", () => {
  const c = cliText(false, 3, 2, { stdout: "hi\n", stderr: "", exit: 0, ops: 1 });
  const lines = c.text.split("\n");
  expect(lines[c.firstStmt - 1]).toBe("type S1 = GChunk<GChunk<S0>>;");
  expect(lines[c.probeLine - 1]).toBe(`export const p1: "probe" = null! as GExit<S1>;`);
  expect(lines[c.outLine]).toContain(`["hi\\x0a", "", 0]`);
  expect(estimateChunks(80_000, 1)).toBeGreaterThan(estimateChunks(80_000, 2));
});

test("hello.go in types, from the start and from a snapshot", async () => {
  const prog = program("hello");
  const path = join(repo, ".run/ir/hello.json");
  const want = readFileSync(join(repo, "tests/go/hello.out"), "latin1");
  const dir = join(repo, ".run/types-test/hello");
  const r = await runTypes({ prog: path, dir, expectOut: want, timeoutSec: 300 });
  expect(r.kind).toBe("pass");
  expect(r.stdout).toBe("hello, world\n");
  const m = new Machine(prog);
  m.boot();
  m.run(Math.floor(r.refOps / 2));
  const mid = await runTypes({
    prog: path,
    dir: dir + "-mid",
    expectOut: want,
    from: JSON.parse(JSON.stringify(snapshot(m, path))),
    timeoutSec: 300,
  });
  expect(mid.kind).toBe("pass");
  expect(mid.startOps).toBeGreaterThanOrEqual(Math.floor(r.refOps / 2));
}, 600_000);
