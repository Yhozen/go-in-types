// Cost per op kind of emitted code (docs/EMIT.md "Cost"): each case is a Go
// loop whose body does one kind of work; it runs at two iteration counts
// and the difference gives instantiations per iteration (and per reference
// op), minus the empty loop's cost for the op's own share.
//   node scripts/bench-emit.ts [case...] [--n 200,600]
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runOne } from "./emit-run.ts";

const repo = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const ni = argv.indexOf("--n");
const [n1, n2] = (ni >= 0 ? argv[ni + 1]! : "200,600").split(",").map(Number) as [number, number];
const pick = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--n");

/** name -> [globals/funcs, loop body, epilogue] */
const CASES: Record<string, [string, string, string?]> = {
  empty: ["", ""],
  add: ["", "s += i"],
  mul: ["", "s = s*3 + i"],
  call: ["func add(a, b int) int { return a + b }", "s = add(s, i)"],
  call0: ["func nop() {}", "nop()"],
  load: ["var g [8]int", "s += g[i&7]"],
  store: ["var g [8]int", "g[i&7] = i"],
  field: ["type T struct{ a, b, c int }\nvar t = &T{1, 2, 3}", "s += t.b"],
  alloc: ["type T struct{ a, b int }\nvar sinkp *T", "sinkp = &T{i, s}"],
  slice: ["var sl = make([]int, 16)", "sl[i&15] += i"],
  append: ["var sl []int", "sl = append(sl, i)"],
  iface: [
    "type I interface{ M(int) int }\ntype T struct{ k int }\nfunc (t *T) M(x int) int { return x + t.k }\nvar it I = &T{1}",
    "s = it.M(s)",
  ],
  closure: ["var fn = func(x int) int { return x + 1 }", "s = fn(s)"],
  mapset: ["var m = map[int]int{}", "m[i&63] = i"],
  mapget: ["var m = map[int]int{1: 2, 3: 4}", "s += m[i&3]"],
  strindex: ['var str = "hello, world, this is a string"', "s += int(str[i&15])"],
  strcat: ["var str string", 'if len(str) > 64 { str = "" }; str += "ab"'],
  defer: ["func d(p *int) { defer func() { *p++ }() }", "d(&s)"],
};

const out: string[] = [];
mkdirSync(join(repo, ".run/bench"), { recursive: true });
const base: Record<number, number> = {};
for (const [name, [decls, body, epi]] of Object.entries(CASES)) {
  if (pick.length && !pick.includes(name) && name !== "empty") continue;
  const res: { inst: number; ops: number }[] = [];
  for (const n of [n1, n2]) {
    const src = `package main

import "gointypes/rt"

${decls}

var sink int

func main() {
	s := 0
	for i := 0; i < ${n}; i++ {
		${body}
	}
	sink = s
	${epi ?? ""}
	rt.Exit(0)
}
`;
    const f = join(repo, ".run/bench", `b_${name}_${n}.go`);
    writeFileSync(f, src);
    const r = runOne(f);
    if (!r.ok) {
      console.log(`${name}: FAIL ${r.msg.slice(0, 300)}`);
      break;
    }
    res.push({ inst: r.inst, ops: r.ops });
  }
  if (res.length < 2) continue;
  const it = n2 - n1;
  const perIt = (res[1]!.inst - res[0]!.inst) / it;
  const opsIt = (res[1]!.ops - res[0]!.ops) / it;
  if (name === "empty") base[0] = perIt;
  const own = perIt - (base[0] ?? 0);
  const line = `${name.padEnd(9)} ${perIt.toFixed(0).padStart(7)} inst/iter  ${opsIt.toFixed(1).padStart(5)} ops/iter  ${(perIt / opsIt).toFixed(0).padStart(5)} inst/op  own ${own.toFixed(0)}`;
  console.log(line);
  out.push(line);
}
