// Random Go program generator for scripts/fuzz-go.ts. Programs are
// well-typed, deterministic (no map-order dependence, no goroutines) and
// terminating (bounded loops, calls only to earlier functions). They cover
// integer widths and wraparound, shifts, division (incl. by zero, recovered),
// strings, slices, maps, structs, pointers, interfaces, closures,
// defer/panic/recover and floats (printed through the fmt overlay).

export class Rng {
  private s: bigint;
  constructor(seed: number) {
    this.s = BigInt(seed) * 0x9e3779b97f4a7c15n + 1n;
  }
  next(): number {
    // xorshift64*
    let x = this.s & 0xffffffffffffffffn;
    x ^= x >> 12n;
    x ^= (x << 25n) & 0xffffffffffffffffn;
    x ^= x >> 27n;
    this.s = x;
    return Number(((x * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn) >> 33n) / 2 ** 31;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

const INTS = [
  "int8",
  "int16",
  "int32",
  "int64",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "int",
  "uint",
] as const;
const FLOATS = ["float64", "float32"] as const;
type T = (typeof INTS)[number] | (typeof FLOATS)[number] | "string" | "bool";

const bits: Record<string, number> = {
  int8: 8,
  int16: 16,
  int32: 32,
  int64: 64,
  int: 64,
  uint8: 8,
  uint16: 16,
  uint32: 32,
  uint64: 64,
  uint: 64,
};
const isInt = (t: T) => (INTS as readonly string[]).includes(t);
const isFloat = (t: T) => (FLOATS as readonly string[]).includes(t);
const signed = (t: T) => t.startsWith("int");

interface Expr {
  s: string;
  c: boolean; // constant expression
}

class Scope {
  vars: { name: string; t: T; ro?: boolean }[] = [];
  readonly parent?: Scope;
  constructor(parent?: Scope) {
    this.parent = parent;
  }
  all(): { name: string; t: T; ro?: boolean }[] {
    return [...(this.parent?.all() ?? []), ...this.vars];
  }
  of(t: T): string[] {
    return this.all()
      .filter((v) => v.t === t)
      .map((v) => v.name);
  }
}

interface Fn {
  name: string;
  params: T[];
  result: T;
}

export function generate(seed: number): string {
  const r = new Rng(seed);
  let uid = 0;
  const fresh = (p: string) => `${p}${uid++}`;
  const fns: Fn[] = [];
  const out: string[] = [];

  function lit(t: T): Expr {
    if (isInt(t)) {
      const b = bits[t]!;
      const max = 2 ** Math.min(b - (signed(t) ? 1 : 0), 52);
      const special = signed(t) ? [0, 1, -1, max - 1, -max] : [0, 1, max - 1];
      const v = r.chance(0.3)
        ? r.pick(special)
        : r.int(Math.min(max, 1000)) * (signed(t) && r.chance(0.3) ? -1 : 1);
      // k() makes literals non-constant: no compile-time overflow errors.
      return { s: `k(${t}(${v}))`, c: false };
    }
    if (isFloat(t))
      return {
        s: `k(${t}(${r.pick(["0.5", "1.25", "-3.75", "100", "1e10", "0.1", "-0", "3"])}))`,
        c: false,
      };
    if (t === "string")
      return {
        s: JSON.stringify(r.pick(["", "a", "héllo", "go", "xyz", "世界", "abcdef"])),
        c: true,
      };
    return { s: r.pick(["true", "false"]), c: true };
  }

  function leaf(t: T, sc: Scope): Expr {
    const vs = sc.of(t);
    if (vs.length > 0 && r.chance(0.75)) return { s: r.pick(vs), c: false };
    return lit(t);
  }

  /** A non-constant expression of type t (forces a variable somewhere). */
  function varExpr(t: T, sc: Scope, d: number): Expr {
    const e = expr(t, sc, d);
    if (!e.c) return e;
    const vs = sc.of(t);
    if (vs.length > 0) return { s: r.pick(vs), c: false };
    return e;
  }

  function expr(t: T, sc: Scope, d: number): Expr {
    if (d <= 0 || r.chance(0.3)) return leaf(t, sc);
    if (isInt(t)) {
      switch (r.int(9)) {
        case 0:
        case 1: {
          const op = r.pick(["+", "-", "*", "&", "|", "^", "&^"]);
          const a = expr(t, sc, d - 1);
          const b = expr(t, sc, d - 1);
          if (a.c && b.c) return { s: `(${leaf(t, sc).s} ${op} ${b.s})`, c: false };
          return { s: `(${a.s} ${op} ${b.s})`, c: a.c && b.c };
        }
        case 2: {
          // Division by a non-zero, non-constant divisor (x|1).
          const a = expr(t, sc, d - 1);
          const b = varExpr(t, sc, d - 1);
          if (b.c) return a;
          return { s: `(${a.s} ${r.pick(["/", "%"])} (${b.s} | 1))`, c: false };
        }
        case 3: {
          const a = varExpr(t, sc, d - 1);
          if (a.c) return a;
          const cnt = varExpr("uint8", sc, d - 1);
          const count = cnt.c ? `${r.int(70)}` : `(${cnt.s} % 70)`;
          return { s: `(${a.s} ${r.pick(["<<", ">>"])} ${count})`, c: false };
        }
        case 4: {
          const from = r.pick(INTS);
          const a = varExpr(from, sc, d - 1);
          if (a.c) return leaf(t, sc);
          return { s: `${t}(${a.s})`, c: false };
        }
        case 5: {
          const a = varExpr(t, sc, d - 1);
          if (a.c) return a;
          return { s: `(${r.pick(signed(t) ? ["-", "^"] : ["^", "-"])}${a.s})`, c: false };
        }
        case 6: {
          const s = varExpr("string", sc, d - 1);
          if (s.c) return leaf(t, sc);
          return { s: `${t}(len(${s.s}))`, c: false };
        }
        case 7: {
          const f = fns.filter((f) => f.result === t);
          if (f.length > 0) {
            const g = r.pick(f);
            return {
              s: `${g.name}(${g.params.map((p) => expr(p, sc, d - 2).s).join(", ")})`,
              c: false,
            };
          }
          return leaf(t, sc);
        }
        default: {
          const a = varExpr("float64", sc, d - 1);
          if (a.c) return leaf(t, sc);
          return { s: `${t}(f2i(${a.s}))`, c: false };
        }
      }
    }
    if (isFloat(t)) {
      switch (r.int(4)) {
        case 0:
        case 1: {
          const a = expr(t, sc, d - 1);
          const b = expr(t, sc, d - 1);
          const op = r.pick(["+", "-", "*", "/"]);
          if (a.c && b.c) return { s: `(${leaf(t, sc).s} ${op} ${b.s})`, c: false };
          return { s: `(${a.s} ${op} ${b.s})`, c: a.c && b.c };
        }
        case 2: {
          const from = r.pick(INTS);
          const a = varExpr(from, sc, d - 1);
          if (a.c) return leaf(t, sc);
          return { s: `${t}(${a.s})`, c: false };
        }
        default: {
          const a = varExpr(t === "float64" ? "float32" : "float64", sc, d - 1);
          if (a.c) return leaf(t, sc);
          return { s: `${t}(${a.s})`, c: false };
        }
      }
    }
    if (t === "string") {
      switch (r.int(4)) {
        case 0: {
          const a = expr("string", sc, d - 1);
          const b = expr("string", sc, d - 1);
          return { s: `(${a.s} + ${b.s})`, c: a.c && b.c };
        }
        case 1: {
          const a = varExpr("int64", sc, d - 1);
          return { s: `strconv.FormatInt(int64(${a.s}), ${r.pick([2, 10, 16, 36])})`, c: false };
        }
        case 2: {
          const a = varExpr("string", sc, d - 1);
          if (a.c) return a;
          return { s: `sub(${a.s}, ${expr("int", sc, d - 1).s})`, c: false };
        }
        default: {
          const a = varExpr("int32", sc, d - 1);
          if (a.c) return leaf(t, sc);
          return { s: `string(rune(${a.s}))`, c: false };
        }
      }
    }
    // bool
    switch (r.int(3)) {
      case 0: {
        const ct = r.pick([...INTS, "string", "float64"] as T[]);
        const a = expr(ct, sc, d - 1);
        const b = varExpr(ct, sc, d - 1);
        return {
          s: `(${a.s} ${r.pick(["==", "!=", "<", "<=", ">", ">="])} ${b.s})`,
          c: a.c && b.c,
        };
      }
      case 1: {
        const a = expr("bool", sc, d - 1);
        const b = expr("bool", sc, d - 1);
        return { s: `(${a.s} ${r.pick(["&&", "||"])} ${b.s})`, c: a.c && b.c };
      }
      default: {
        const a = expr("bool", sc, d - 1);
        return { s: `(!${a.s})`, c: a.c };
      }
    }
  }

  const ALL: T[] = [...INTS, ...FLOATS, "string", "bool"];

  function show(name: string, t: T): string {
    if (isFloat(t))
      return r.chance(0.5) ? `fmt.Printf("%v ", ${name})` : `fmt.Printf("%.4g ", ${name})`;
    if (t === "string") return `fmt.Printf("%q ", ${name})`;
    if (isInt(t) && r.chance(0.3)) return `fmt.Printf("%x ", ${name})`;
    return `fmt.Print(${name}, " ")`;
  }

  function block(sc: Scope, d: number, n: number, ind: string, inLoop: boolean): string[] {
    const lines: string[] = [];
    for (let k = 0; k < n; k++) lines.push(...stmt(sc, d, ind, inLoop));
    // Every variable declared here is used (Go rejects unused locals).
    if (sc.vars.length > 0) lines.push(`${ind}${sc.vars.map((v) => `_ = ${v.name}`).join("; ")}`);
    return lines;
  }

  function stmt(sc: Scope, d: number, ind: string, inLoop: boolean): string[] {
    const kind = d <= 0 ? r.int(3) : r.int(14);
    const vars = sc.all();
    switch (kind) {
      case 0:
      case 1: {
        const t = r.pick(ALL);
        const name = fresh("v");
        const e = expr(t, sc, 3);
        sc.vars.push({ name, t });
        return [`${ind}var ${name} ${t} = ${e.s}`];
      }
      case 2: {
        const rw = vars.filter((v) => !v.ro);
        if (rw.length === 0) return [];
        const v = r.pick(rw);
        if (isInt(v.t) || isFloat(v.t)) {
          const op = r.pick(isInt(v.t) ? ["+=", "-=", "*=", "^=", "|="] : ["+=", "-=", "*="]);
          return [`${ind}${v.name} ${op} ${expr(v.t, sc, 2).s}`];
        }
        return [`${ind}${v.name} = ${expr(v.t, sc, 2).s}`];
      }
      case 3: {
        const inner = new Scope(sc);
        const els = new Scope(sc);
        return [
          `${ind}if ${expr("bool", sc, 2).s} {`,
          ...block(inner, d - 1, 1 + r.int(3), ind + "\t", inLoop),
          `${ind}} else {`,
          ...block(els, d - 1, 1 + r.int(2), ind + "\t", inLoop),
          `${ind}}`,
        ];
      }
      case 4: {
        const i = fresh("i");
        const inner = new Scope(sc);
        inner.vars.push({ name: i, t: "int", ro: true }); // never assigned: loops terminate
        const body = block(inner, d - 1, 1 + r.int(3), ind + "\t", true);
        if (r.chance(0.3))
          body.push(`${ind}\tif ${i} == ${r.int(4)} { ${r.pick(["break", "continue"])} }`);
        return [`${ind}for ${i} := 0; ${i} < ${1 + r.int(6)}; ${i}++ {`, ...body, `${ind}}`];
      }
      case 5: {
        // slices: append, index, copy, aliasing
        const s = fresh("s");
        const t = r.pick([...INTS, "string"] as T[]);
        const n = r.int(5);
        const lines = [`${ind}${s} := make([]${t}, ${n}, ${n + r.int(4)})`];
        for (let k = 0; k < 1 + r.int(4); k++)
          lines.push(`${ind}${s} = append(${s}, ${expr(t, sc, 2).s})`);
        const al = fresh("al");
        lines.push(`${ind}${al} := ${s}[:len(${s})/2]`);
        lines.push(`${ind}${al} = append(${al}, ${expr(t, sc, 1).s})`);
        lines.push(`${ind}${s}[len(${s})-1] = ${expr(t, sc, 1).s}`);
        lines.push(
          `${ind}fmt.Println(len(${s}), cap(${s}) >= len(${s}), len(${al}), ${s}[0] == ${al}[0])`,
        );
        lines.push(`${ind}for _, e := range ${s} { ${show("e", t)} }`);
        lines.push(`${ind}fmt.Println()`);
        return lines;
      }
      case 6: {
        // map with order-independent output
        const m = fresh("m");
        const kt = r.pick(["int", "string", "uint8"] as T[]);
        const lines = [`${ind}${m} := map[${kt}]int64{}`];
        const i = fresh("i");
        lines.push(`${ind}for ${i} := 0; ${i} < ${2 + r.int(10)}; ${i}++ {`);
        const key = kt === "string" ? `strconv.Itoa(${i} % 5)` : `${kt}(${i} * 7 % 6)`;
        lines.push(`${ind}\t${m}[${key}] += int64(${i})`);
        lines.push(`${ind}}`);
        if (r.chance(0.5))
          lines.push(`${ind}delete(${m}, ${kt === "string" ? '"1"' : `${kt}(1)`})`);
        lines.push(
          `${ind}fmt.Println(len(${m}), sumMap${kt === "string" ? "S" : kt === "int" ? "I" : "U"}(${m}))`,
        );
        return lines;
      }
      case 7: {
        // panic and recover around something that may fail
        const v = fresh("p");
        const t = r.pick(INTS);
        const a = varExpr(t, sc, 2);
        const b = varExpr(t, sc, 2);
        const risky = r.pick([
          `fmt.Println(${a.s} / ${b.s})`,
          `fmt.Println(${a.s} % ${b.s})`,
          `arr := []int{1, 2, 3}; fmt.Println(arr[int(${a.s}) & 7])`,
          `var np *box; fmt.Println(np.v)`,
          `var x any = ${a.s}; fmt.Println(x.(string))`,
          `panic(fmt.Sprint("custom ", ${a.s}))`,
          `fmt.Println(${b.s} << (uint(${a.s}) % 8))`,
        ]);
        return [
          `${ind}${v} := func() (res string) {`,
          `${ind}\tdefer func() {`,
          `${ind}\t\tif rec := recover(); rec != nil { res = fmt.Sprint("recovered: ", rec) }`,
          `${ind}\t}()`,
          `${ind}\t${risky}`,
          `${ind}\treturn "ok"`,
          `${ind}}()`,
          `${ind}fmt.Println(${v})`,
        ];
      }
      case 8: {
        // closure capturing and mutating a variable
        const ints = vars.filter((v) => isInt(v.t) && !v.ro);
        if (ints.length === 0) return [];
        const v = r.pick(ints);
        const f = fresh("cl");
        return [
          `${ind}${f} := func(k ${v.t}) ${v.t} { ${v.name} += k; return ${v.name} * 3 }`,
          `${ind}fmt.Println(${f}(${expr(v.t, sc, 1).s}), ${f}(${lit(v.t).s}), ${v.name})`,
        ];
      }
      case 9: {
        // structs, pointers, interfaces
        const b = fresh("b");
        return [
          `${ind}${b} := &box{v: ${expr("int64", sc, 2).s}, s: ${expr("string", sc, 1).s}}`,
          `${ind}${b}.bump(${expr("int64", sc, 1).s})`,
          `${ind}var ${b}i shape = ${r.chance(0.5) ? b : `*${b}`}`,
          `${ind}if ${b}i != nil { fmt.Println(${b}i.area(), describe(${b}i), describe(${expr("int64", sc, 1).s}), describe(${b}.s)) }`,
          `${ind}${b}c := *${b}`,
          `${ind}${b}c.v++`,
          `${ind}fmt.Println(${b}.v == ${b}c.v, ${b}c.String())`,
        ];
      }
      case 10: {
        const t = r.pick(INTS);
        const e = varExpr(t, sc, 2);
        const lines = [`${ind}switch ${e.c ? `${t}(len(${JSON.stringify("ab")}))` : e.s} % 4 {`];
        for (const c of [0, 1, 2])
          lines.push(`${ind}case ${c}:`, ...block(new Scope(sc), d - 1, 1, ind + "\t", inLoop));
        lines.push(`${ind}default:`, `${ind}\tfmt.Println("default")`, `${ind}}`);
        return lines;
      }
      case 11: {
        // strings: range over bytes/runes
        const s = varExpr("string", sc, 2);
        const n = fresh("n");
        return [
          `${ind}${n} := 0`,
          `${ind}for i, c := range ${s.s} { ${n} += i * int(c) % 1000 }`,
          `${ind}fmt.Println(${n}, len([]rune(${s.s})), []byte(${s.s + ' + "!"'})[0])`,
        ];
      }
      case 12: {
        // defer order
        const v = fresh("d");
        return [
          `${ind}func() {`,
          `${ind}\tfor ${v} := 0; ${v} < 3; ${v}++ { defer fmt.Print(${v}, ";") }`,
          `${ind}\tdefer fmt.Println()`,
          `${ind}}()`,
        ];
      }
      default: {
        // print everything in scope
        return vars.length === 0
          ? []
          : [`${ind}${vars.map((v) => show(v.name, v.t)).join("; ")}`, `${ind}fmt.Println()`];
      }
    }
  }

  const nf = 2 + r.int(4);
  for (let k = 0; k < nf; k++) {
    const f: Fn = {
      name: `f${k}`,
      params: Array.from({ length: r.int(3) }, () => r.pick(ALL)),
      result: r.pick(ALL),
    };
    const sc = new Scope();
    const ps = f.params.map((t, i) => {
      sc.vars.push({ name: `a${i}`, t });
      return `a${i} ${t}`;
    });
    const body = block(sc, 2, 3 + r.int(5), "\t", false);
    body.push(
      `\t${
        sc
          .all()
          .map((v) => `_ = ${v.name}`)
          .join("; ") || "_ = 0"
      }`,
    );
    body.push(`\treturn ${expr(f.result, sc, 3).s}`);
    out.push(`func ${f.name}(${ps.join(", ")}) ${f.result} {`, ...body, "}", "");
    fns.push(f);
  }
  const main = new Scope();
  const mbody = block(main, 2, 4 + r.int(6), "\t", false);
  for (const f of fns) {
    const res = fresh("r");
    mbody.push(`\t${res} := ${f.name}(${f.params.map((p) => expr(p, main, 2).s).join(", ")})`);
    mbody.push(`\t${show(res, f.result)}`);
  }
  mbody.push(`\tfmt.Println()`);
  mbody.push(
    `\t${
      main
        .all()
        .map((v) => `_ = ${v.name}`)
        .join("; ") || "_ = 0"
    }`,
  );

  return `// Code generated by scripts/fuzz-go.ts (seed ${seed}); DO NOT EDIT.
package main

import (
	"fmt"
	"strconv"
)

type box struct {
	v int64
	s string
}

func (b *box) bump(k int64) { b.v += k }
func (b box) area() int64   { return b.v * int64(len(b.s)+1) }
func (b box) String() string { return "box(" + strconv.FormatInt(b.v, 10) + "," + b.s + ")" }

type shape interface{ area() int64 }

func describe(x any) string {
	switch v := x.(type) {
	case *box:
		return "*box " + v.String()
	case box:
		return "box " + v.s
	case int64:
		return "int64 " + strconv.FormatInt(v, 10)
	case string:
		return "string " + strconv.Quote(v)
	}
	return "?"
}

func k[T any](x T) T { return x }

func f2i(f float64) int64 {
	if f != f || f > 1e15 || f < -1e15 {
		return 0
	}
	return int64(f)
}

func sub(s string, i int) string {
	if len(s) == 0 {
		return s
	}
	i %= len(s)
	if i < 0 {
		i = -i
	}
	return s[i:]
}

func sumMapS(m map[string]int64) (t int64) {
	for k, v := range m {
		t += int64(len(k)) * 31 + v*v
	}
	return
}

func sumMapI(m map[int]int64) (t int64) {
	for k, v := range m {
		t += int64(k)*31 + v*v
	}
	return
}

func sumMapU(m map[uint8]int64) (t int64) {
	for k, v := range m {
		t += int64(k)*31 + v*v
	}
	return
}

${out.join("\n")}
func main() {
${mbody.join("\n")}
}
`;
}
