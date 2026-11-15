// Codec round trip of real reference snapshots: a corpus program paused at
// several op counts -> type-level heap module + registers -> back -> equal.
// Then tsrs reads some objects of the encoded heap through LoadK and gets
// the encoded slots back.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import type { Program } from "../../src/ir/types.ts";
import { Machine } from "../../src/ref/interp.ts";
import { snapshot } from "../../src/ref/snapshot.ts";
import {
  encNat,
  idOf,
  snapshotToTypes,
  TypeInfo,
  typeSnapshot,
  typesToSnapshot,
  encSnapValue,
  decNat,
} from "../../src/types/codec-heap.ts";
import { repo, runCases, scratch, type Case } from "./tsrs-harness.ts";

function program(name: string): Program {
  const out = join(repo, ".run/ir", `${name}.json`);
  if (!existsSync(out))
    execFileSync(
      "node",
      [join(repo, "scripts/frontend.ts"), join(repo, "tests/go", `${name}.go`), "-o", out],
      {
        stdio: "ignore",
      },
    );
  return JSON.parse(readFileSync(out, "utf8")) as Program;
}

function snapAt(prog: Program, ops: number): any {
  const m = new Machine(prog);
  m.boot();
  m.run(ops);
  return JSON.parse(JSON.stringify(snapshot(m, "prog.json")));
}

test("encNat / decNat", () => {
  for (const v of [0n, 1n, 7n, 8n, 15n, 16n, -1n, -8n, -9n, 2n ** 63n - 1n, -(2n ** 63n), 255n])
    expect(decNat(encNat(v))).toBe(v);
  expect(encNat(8)).toBe("80");
  expect(encNat(-1)).toBe("f");
  expect(encNat(BigInt.asIntN(8, 255n))).toBe("f");
});

for (const name of ["structs_pointers", "slices_growth"]) {
  test(`snapshot round trip: ${name}`, () => {
    const prog = program(name);
    for (const ops of [500, 2000, 6000, 12000]) {
      const snap = snapAt(prog, ops);
      if (snap.objects.some((o: any) => o.k !== "o")) continue; // maps: src/types/map.ts
      const st = snapshotToTypes(prog, snap, "../../src/types/heap.gen.ts");
      const back = typesToSnapshot(prog, st, snap);
      expect(back.frames).toEqual(snap.frames);
      expect(back.objects).toEqual(snap.objects);
    }
  }, 120_000);
}

test("tsrs reads the encoded heap", () => {
  const prog = program("structs_pointers");
  const snap = snapAt(prog, 2000);
  const ti = new TypeInfo(prog);
  const st = snapshotToTypes(prog, snap, "../../src/types/heap.gen.ts");
  const types = typeSnapshot(ti, snap);
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, "codec-heap.gen.ts"), st.heap);
  // objects whose slots are all typed: LoadK of the whole object = its encoded slots
  const cases: Case[] = [];
  snap.objects.forEach((o: any, k: number) => {
    const m = types.get(k);
    if (!m || m.size !== o.s.length || o.s.length === 0 || o.s.length > 256 || cases.length >= 60)
      return;
    const slots = (o.s as any[]).map((v, i) => encSnapValue(ti, v, m.get(i)!));
    const zero = slots.map(() => `"zz"`);
    cases.push({
      name: `object ${k} (${o.s.length} slots)`,
      actual: `H.LoadK<Heap, [${JSON.stringify(idOf(k))}, "0"], [${zero.join(", ")}]>`,
      expected: `[${slots.join(", ")}]`,
    });
  });
  expect(cases.length).toBeGreaterThan(10);
  const res = runCases(
    "codec-read.ts",
    `import type * as H from "../../src/types/heap.ts";\nimport type { Heap } from "./codec-heap.gen.ts";`,
    cases,
  );
  expect(res.other).toEqual([]);
  expect(res.failures).toEqual([]);
}, 300_000);
