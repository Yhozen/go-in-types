// H5 cost test (docs/stage0/HEAP.md): scripts/cost-heap.ts at 0, 1k, 10k
// and 100k live objects on stock tsrs, through the machine-wide heavy-job
// lock; it exits non-zero if any primitive's cost grows with the heap.
// HEAP_COST=full also runs the 50k-write long run.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { repo } from "./tsrs-harness.ts";

test("heap primitives cost the same at 0, 1k, 10k, 100k live objects", () => {
  const out = join(repo, ".run/cost-heap-test.json");
  const args = [join(repo, "scripts/cost-heap.ts"), "--k", "40", "--out", out];
  if (process.env.HEAP_COST === "full") args.push("--long", "--k", "100");
  const r = spawnSync(join(repo, "scripts/heavy.sh"), ["node", ...args], {
    encoding: "utf8",
    timeout: 1_500_000,
  });
  expect(r.stdout, r.stderr.slice(-2000)).not.toContain("FAIL");
  expect(r.status).toBe(0);
  const res = JSON.parse(readFileSync(out, "utf8"));
  // spot values (HEAP.md targets: ~60 read, ~410 write, ~360 alloc, 11-15 pass-on)
  const at = (op: string) => res.rows.find((x: any) => x.op === op && x.n === 102400).perOp;
  expect(at("none")).toBeLessThanOrEqual(15);
  expect(at("load1")).toBeLessThan(100);
  expect(at("store1")).toBeLessThan(500);
  expect(at("alloc")).toBeLessThan(420);
}, 1_600_000);
