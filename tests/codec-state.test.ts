// Round trips of whole reference snapshots (maps included) through the
// type-level heap form and back.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { Machine } from "../src/ref/interp.ts";
import {
  callSites,
  decodeStart,
  entryLayouts,
  startState,
  encNat,
  encSnapValue,
  idOf,
  snapKeyCanon,
  snapshotToTypes,
  strToType,
  TypeInfo,
  typeSnapshot,
  typesToSnapshot,
} from "../src/types/codec.ts";
import { program, snapAt } from "./codec-state-helpers.ts";
import { repo, runCases, scratch, type Case } from "./types/tsrs-harness.ts";

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

// ---------------------------------------------------------------- start states

const hasEmitter = existsSync(join(repo, "src/emit/emit.ts"));

/** A snapshot's frames with only the registers in `keep` (fn -> set), for comparison. */
function liveOnly(snap: any, keep: (fn: number, pc: number) => Set<number>): any[] {
  return snap.frames.map((fr: any) => {
    const k = keep(fr.fn, fr.pc);
    return {
      fn: fr.fn,
      pc: fr.pc,
      dm: fr.dm,
      df: fr.df?.length ? fr.df.map((d: any) => ({ fn: d.fn, env: d.env, a: d.a })) : null,
      r: fr.r.map((v: any, i: number) => (k.has(i) ? v : { u: 1 })),
    };
  });
}

for (const name of ["closures", "defer_panic", "maps", "interfaces", "structs_pointers"])
  test.skipIf(!hasEmitter)(
    `start state round trip: ${name}`,
    async () => {
      const { emit } = await import("../src/emit/emit.ts");
      const prog = program(name);
      const emitted = emit(prog, { rt: "./rt" });
      const lays = entryLayouts(emitted);
      const m0 = new Machine(prog);
      m0.boot();
      m0.run();
      const total = m0.ops;
      let n = 0;
      for (const q of [0, 1, 2, 3, 5, 7]) {
        const snap = snapAt(prog, Math.floor((total * q) / 8));
        const st = startState(prog, snap, { rt: "./rt", emitted });
        const back = decodeStart(prog, st.module, emitted, st.snap);
        // objects: every slot the decoded state reaches by a typed path
        const maps = new Map<number, number>();
        const types = typeSnapshot(new TypeInfo(prog), back, maps);
        const pick = (objs: any[]) =>
          objs.map((o: any, k: number) =>
            maps.has(k)
              ? o
              : o.k === "o"
                ? o.s.filter((_: any, i: number) => types.get(k)?.has(i))
                : [],
          );
        expect(pick(back.objects)).toEqual(pick(st.snap.objects));
        expect(back.stdout).toBe(st.snap.stdout);
        expect(back.stderr).toBe(st.snap.stderr);
        // registers the entries keep
        const keep = (fn: number, pc: number, top: boolean): Set<number> => {
          if (top) {
            let p = 0;
            const f = prog.funcs[fn]!;
            for (let b = 0; b < f.blocks.length; b++) {
              if (p === pc) return new Set(lays.get(`b${fn}_${b}`)!.regs);
              p += f.blocks[b]!.instrs.length;
            }
          }
          const c = callSites(prog, fn).get(pc - 1);
          return new Set(c === undefined ? [] : lays.get(`c${fn}_${c}`)!.regs);
        };
        const nf = st.snap.frames.length;
        let idx = 0;
        expect(back.frames).toEqual(liveOnly(st.snap, (fn, pc) => keep(fn, pc, ++idx === nf)));
        n += st.snap.frames.length;
      }
      expect(n).toBeGreaterThan(0);
    },
    300_000,
  );

test("opaque deferstack values (stack indices) encode as ints", () => {
  const prog = program("range_func_defer");
  const ti = new TypeInfo(prog);
  const t = prog.types.findIndex((x: any) => x.k === "opaque" && x.what === "deferstack");
  if (t >= 0) expect(encSnapValue(ti, 2, t)).toBe('"2"');
}, 120_000);
