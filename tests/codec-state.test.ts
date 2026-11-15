// Round trips of whole reference snapshots (maps included) through the
// type-level heap form and back.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import type { Program } from "../src/ir/types.ts";
import { Machine } from "../src/ref/interp.ts";
import { snapshot } from "../src/ref/snapshot.ts";
import {
  encNat,
  encSnapValue,
  idOf,
  snapKeyCanon,
  snapshotToTypes,
  strToType,
  TypeInfo,
  typesToSnapshot,
} from "../src/types/codec.ts";
import { repo, runCases, scratch, type Case } from "./types/tsrs-harness.ts";

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

for (const name of ["maps", "sorting", "interfaces"])
  test(`heap round trip with maps: ${name}`, () => {
    const prog = program(name);
    let maps = 0;
    for (const ops of [300, 1500, 5000, 20000, 60000]) {
      const snap = snapAt(prog, ops);
      maps += snap.objects.filter((o: any) => o.k === "m").length;
      const st = snapshotToTypes(prog, snap, "../src/types/heap.gen.ts");
      const back = typesToSnapshot(prog, st, snap);
      expect(back.objects).toEqual(snap.objects);
      expect(back.frames).toEqual(snap.frames);
    }
    if (name === "maps") expect(maps).toBeGreaterThan(0);
  }, 120_000);

test("tsrs reads encoded maps: len and every key's value", () => {
  const prog = program("maps");
  const snap = snapAt(prog, 20000);
  const ti = new TypeInfo(prog);
  const st = snapshotToTypes(prog, snap, "../../src/types/heap.gen.ts");
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, "codec-maps.gen.ts"), st.heap);
  const cases: Case[] = [];
  snap.objects.forEach((o: any, k: number) => {
    if (o.k !== "m") return;
    const id = JSON.stringify(idOf(k));
    cases.push({
      name: `len ${k}`,
      actual: `M.MapLen<Heap, ${id}>`,
      expected: `"${encNat(o.e.length)}"`,
    });
    const [kt, vt] = ti.mapTypes(o.t);
    for (const [key, v] of o.e.slice(0, 8))
      cases.push({
        name: `map ${k} key ${JSON.stringify(key)}`,
        actual: `M.MapLookup<Heap, ${id}, ${strToType(snapKeyCanon(ti, key, kt))}, "zz">`,
        expected: encSnapValue(ti, v, vt),
      });
  });
  expect(cases.length).toBeGreaterThan(5);
  const res = runCases(
    "codec-maps.ts",
    `import type * as M from "../../src/types/map.ts";\nimport type { Heap } from "./codec-maps.gen.ts";`,
    cases,
  );
  expect(res.other).toEqual([]);
  expect(res.failures).toEqual([]);
}, 300_000);
