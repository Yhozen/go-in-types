// Front end: every program in tests/frontend (no overlay) and tests/go
// (overlay/tests.json) compiles to IR that validates; together they cover
// every IR instruction kind; output is deterministic.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { buildFrontend, runFrontend } from "../scripts/frontend.ts";
import type { Program } from "../src/ir/types.ts";
import { validate } from "../src/ir/validate.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = (name: string) => join(repo, ".run", "ir-test", `${name}.json`);
const goFiles = (dir: string) =>
  readdirSync(join(repo, dir))
    .filter((f) => f.endsWith(".go"))
    .sort();

const ALL_OPS = [
  "alloc",
  "load",
  "store",
  "fieldAddr",
  "field",
  "indexAddr",
  "index",
  "binop",
  "unop",
  "convert",
  "changeType",
  "makeSlice",
  "slice",
  "sliceToArrayPtr",
  "makeMap",
  "lookup",
  "mapUpdate",
  "makeChan",
  "send",
  "recv",
  "makeInterface",
  "changeInterface",
  "typeAssert",
  "makeClosure",
  "call",
  "extract",
  "range",
  "next",
  "phi",
  "jump",
  "if",
  "return",
  "panic",
  "defer",
  "runDefers",
  "trap",
];

function load(path: string): Program {
  return JSON.parse(readFileSync(path, "utf8")) as Program;
}

/** Instructions of the program's own package (not std). */
function ownInstrs(p: Program) {
  return p.funcs
    .filter((f) => f.name.includes("command-line-arguments"))
    .flatMap((f) => f.blocks.flatMap((b) => b.instrs));
}

describe("frontend", { timeout: 120_000 }, () => {
  test("builds", () => {
    buildFrontend();
  });

  const seen = new Set<string>();
  for (const file of goFiles("tests/frontend")) {
    test(`tests/frontend/${file}`, () => {
      const r = runFrontend(join(repo, "tests/frontend", file), out(file), "none");
      expect(r.errors).toEqual([]);
      for (const i of ownInstrs(load(r.out))) seen.add(i.op);
    });
  }

  test("covers every instruction kind", () => {
    expect(ALL_OPS.filter((op) => !seen.has(op))).toEqual([]);
  });

  test("lowering details", () => {
    const p = load(out("traps_floats.go"));
    const main = p.funcs.find((f) => f.name === "command-line-arguments.main")!;
    const instrs = main.blocks.flatMap((b) => b.instrs);
    const traps = instrs.filter((i) => i.op === "trap").map((i) => (i as { what: string }).what);
    expect(traps).toEqual(
      expect.arrayContaining([
        "goroutine not supported",
        "select not supported",
        "complex numbers not supported",
        "unsafe pointer arithmetic not supported",
      ]),
    );
    const callees = new Set(
      instrs.flatMap((i) =>
        i.op === "call" && "static" in i.callee ? [p.funcs[i.callee.static]!.name] : [],
      ),
    );
    for (const f of [
      "Mul32",
      "Div64",
      "Sub64",
      "Lt64",
      "F64toInt64",
      "F64toUint64",
      "Int64to64",
      "Neg64",
      "Min64",
      "F64to32",
    ])
      expect(callees).toContain(`gointypes/softfloat.${f}`);
    // unsafe.String / unsafe.Slice views become slice + convert; Sizeof a constant.
    expect(traps.filter((t) => t.startsWith("unsafe."))).toEqual([]);
    // No float binop survives in the program's own code.
    const floatTypes = new Set(p.types.flatMap((t, i) => (t.k === "float" ? [i] : [])));
    expect(instrs.filter((i) => i.op === "binop" && floatTypes.has(i.t))).toEqual([]);
  });

  test("named types carry method sets", () => {
    const p = load(out("all_instrs.go"));
    const rect = p.types.find((t) => t.k === "named" && t.name === "main.Rect");
    expect(rect?.k).toBe("named");
    if (rect?.k !== "named") return;
    expect(Object.keys(rect.methods)).toEqual(["Area"]);
    expect(Object.keys(rect.ptrMethods).sort()).toEqual(["Area", "Name"]);
    expect(p.types.find((t) => t.k === "int" && t.name === "int")).toBeTruthy();
    expect(p.funcs[p.init]!.name).toBe("gointypes.init");
    expect(p.funcs[p.main!]!.name).toBe("command-line-arguments.main");
  });

  test("deterministic", () => {
    const file = join(repo, "tests/frontend/all_instrs.go");
    const a = readFileSync(runFrontend(file, out("det-a"), "none").out, "utf8");
    const b = readFileSync(runFrontend(file, out("det-b"), "none").out, "utf8");
    expect(a === b).toBe(true);
  });

  for (const file of goFiles("tests/go")) {
    test(`tests/go/${file}`, () => {
      const r = runFrontend(join(repo, "tests/go", file), out(`go-${file}`), "tests");
      expect(r.errors).toEqual([]);
    });
  }

  test("validator rejects broken IR", () => {
    const p = load(out("all_instrs.go"));
    const f = p.funcs[p.main!]!;
    (f.blocks[0]!.instrs[0] as { op: string }).op = "bogus";
    (p.types[0] as { slots: number }).slots = 7;
    expect(validate(p).length).toBeGreaterThan(0);
  });
});
