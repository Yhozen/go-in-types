// Codec for heap values (src/types/heap.ts header has the encodings):
// reference values and snapshot state <-> type literal source text.
//
// - `encNat`/`decNat`: the int encoding (any width, via the 64-bit pattern).
// - `Enc`: reference values (src/ref/values.ts classes) with their IR type ->
//   type literal text; objects get ids in first-seen order unless given.
// - `encodeHeap`: objects (slot arrays with slot types) -> a `.ts` module
//   that declares `Heap` (H1: objects as literal tuples or constructor
//   instantiations, trie nodes as `Mk16<...>`, no inline aliases in tuples).
// - `parseModule` / `evalType`: our own module text back to JS structures;
//   `heapObjects`: the object table of a parsed heap.
// - `snapshotToTypes` / `typesToSnapshot`: a reference snapshot's objects,
//   globals and frame registers through the type-level form and back.
//   Objects are typed by a traversal from the typed roots (globals, frame
//   registers, defer arguments, panic values); a slot no typed path reaches
//   is dead to the program and travels as `["?", json]`.
// - `progTables`: the per-program interface tables heap.ts reads as `P`.
import type { Program } from "../ir/types.ts";
import { Types } from "../ref/types.ts";
import { Func, Iface, Ptr, Slice } from "../ref/values.ts";

const HEX = "0123456789abcdef";
/** Object id width (hex digits); matches src/types/heap.gen.ts. */
export const ID_WIDTH = 5;

/**
 * Canonical int encoding of an integer interpreted as a 64-bit two's
 * complement pattern: lowercase nibbles, least significant first, shortest
 * form that sign-extends.
 */
export function encNat(v: number | bigint): string {
  let b = BigInt.asIntN(64, BigInt(v));
  let s = "";
  for (;;) {
    const d = Number(b & 15n);
    s += HEX[d];
    b >>= 4n;
    if ((b === 0n && d < 8) || (b === -1n && d >= 8)) return s;
  }
}

/** Decodes a canonical int to a signed 64-bit bigint. */
export function decNat(s: string): bigint {
  let b = 0n;
  for (let i = s.length - 1; i >= 0; i--) b = (b << 4n) | BigInt(HEX.indexOf(s[i]!));
  return BigInt.asIntN(64, BigInt.asIntN(s.length * 4, b));
}

/** Object id text of object number k (0-based allocation order; -1 is the zero-size object). */
export function idOf(k: number): string {
  return (k + 1).toString(16).padStart(ID_WIDTH, "0");
}
export function idNum(id: string): number {
  return parseInt(id, 16) - 1;
}

/** A TS string literal for a byte string. */
export function strLit(s: string): string {
  let o = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) o += '\\"';
    else if (c === 0x5c) o += "\\\\";
    else if (c >= 0x20 && c < 0x7f) o += s[i];
    else o += "\\x" + c.toString(16).padStart(2, "0");
  }
  return o + '"';
}

const lit = (s: string) => strLit(s);

// ------------------------------------------------------------ hooks

/** Encoding of a value kind owned by another module (maps: src/types/map.ts). */
export interface ValueHook {
  /** live reference value -> text (Enc) */
  enc?: (v: any, t: number, e: Enc) => string;
  /** snapshot JSON value -> text */
  encSnap?: (v: any, t: number, ti: TypeInfo) => string;
  /** evaluated type-level value -> snapshot JSON value */
  dec?: (v: any, t: number, d: Dec) => any;
  /** a snapshot object of this kind ({ k: "m" } / { k: "c" }) -> heap object text */
  encObject?: (o: any, k: number, ti: TypeInfo) => ObjText;
  /** an evaluated heap object of this kind and its type -> snapshot object */
  decObject?: (o: any, t: number, d: Dec) => any;
}
/** Hooks for maps, channels and range iterators; codec-map fills `map`, codec-state `iter`. */
export const codecHooks: { map?: ValueHook; chan?: ValueHook; iter?: ValueHook } = {};
function iterHook(): ValueHook {
  const h = codecHooks.iter;
  if (!h?.encSnap || !h.dec) throw new Error("codec-heap: no codec for range iterators");
  return h;
}
function hook(kind: "map" | "chan"): ValueHook {
  const h = codecHooks[kind];
  if (!h) throw new Error(`codec-heap: no codec for ${kind} values (codecHooks.${kind})`);
  return h;
}

// ------------------------------------------------------------ values

type Kind =
  | "bool"
  | "int"
  | "float"
  | "string"
  | "pointer"
  | "slice"
  | "iface"
  | "func"
  | "agg"
  | "map"
  | "chan"
  | "opaque";

export class TypeInfo {
  readonly T: Types;
  readonly prog: Program;
  constructor(prog: Program) {
    this.prog = prog;
    this.T = new Types(prog);
  }
  kind(t: number): Kind {
    const k = this.T.info[t]!.k;
    switch (k) {
      case "struct":
      case "array":
        return "agg";
      case "interface":
        return "iface";
      case "tuple":
        return "agg";
      default:
        return k as Kind;
    }
  }
  width(t: number): number {
    const ti = this.T.info[t]!;
    if (ti.ik) return Number(ti.ik.replace(/\D/g, ""));
    return ti.fbits ?? 64;
  }
  slotTypes(t: number): number[] {
    if (this.T.info[t]!.k === "tuple") throw new Error("tuple has no slots");
    return this.T.slotTypes(t);
  }
  /** Element type of a slice / pointer type. */
  elem(t: number): number {
    return (this.T.info[t]!.u as any).elem as number;
  }
  /** Is t the opaque type of `range` iterators (go/ssa's rangeIter)? */
  isIter(t: number): boolean {
    const x = this.prog.types[t] as any;
    return x.k === "named" && x.name === "ssa.rangeIter";
  }
  private iters = new Map<number, Map<number, number>>();
  /** Registers of function fn that hold `range` iterators -> the ranged operand's type. */
  iterSources(fn: number): Map<number, number> {
    let m = this.iters.get(fn);
    if (m) return m;
    m = new Map();
    const f = this.prog.funcs[fn]!;
    for (const b of f.blocks ?? [])
      for (const ins of b.instrs)
        if (ins.op === "range") {
          const x = ins.x as any;
          m.set(ins.dst, "r" in x ? f.regTypes[x.r]! : x.t);
        }
    this.iters.set(fn, m);
    return m;
  }
  /** Key and element types of a map type. */
  mapTypes(t: number): [number, number] {
    const u = this.T.info[t]!.u as any;
    return [u.key as number, u.elem as number];
  }
  /** Free-variable types of a closure function. */
  envTypes(fn: number): number[] {
    const f = this.prog.funcs[fn]!;
    return f.regTypes.slice(f.params, f.params + f.freeVars);
  }
  /** Zero slots of a type, encoded. */
  zeroText(t: number): string[] {
    const st = this.slotTypes(t);
    return this.T.zslots(t).map((z, i) => new Enc(this).value(z, st[i]!));
  }
}

/** Encodes reference values (live JS objects) as type literal text. */
export class Enc {
  ids = new Map<object, string>();
  order: object[] = [];
  readonly ti: TypeInfo;
  readonly zerobase?: object;
  constructor(ti: TypeInfo, zerobase?: object) {
    this.ti = ti;
    this.zerobase = zerobase;
  }
  id(o: object): string {
    if (o === this.zerobase) return "0".repeat(ID_WIDTH);
    let id = this.ids.get(o);
    if (id === undefined) {
      id = idOf(this.order.length);
      this.ids.set(o, id);
      this.order.push(o);
    }
    return id;
  }
  int(v: any, t: number): string {
    return lit(encNat(BigInt.asIntN(this.ti.width(t), BigInt(v))));
  }
  value(v: any, t: number): string {
    const ti = this.ti;
    switch (ti.kind(t)) {
      case "bool":
        return v ? "true" : "false";
      case "int":
      case "float":
        return this.int(v, t);
      case "string":
        return lit(v);
      case "pointer":
      case "opaque":
        if (v === null) return "null";
        return `[${lit(this.id((v as Ptr).o))}, ${lit(encNat((v as Ptr).i))}]`;
      case "slice": {
        if (v === null) return "null";
        const s = v as Slice;
        return `[${lit(this.id(s.o))}, ${lit(encNat(s.i))}, ${lit(encNat(s.len))}, ${lit(encNat(s.cap))}]`;
      }
      case "iface": {
        if (v === null) return "null";
        const x = v as Iface;
        return `[${lit(encNat(x.t))}, ${this.value(x.v, x.t)}]`;
      }
      case "func": {
        if (v === null) return "null";
        const f = v as Func;
        const et = ti.envTypes(f.fn);
        return `[${lit(encNat(f.fn))}, [${f.env.map((e, i) => this.value(e, et[i]!)).join(", ")}]]`;
      }
      case "agg": {
        const info = ti.T.info[t]!;
        if (info.k === "tuple") {
          const es = (info.u as any).elems as number[];
          return `[${(v as any[]).map((x, i) => this.value(x, es[i]!)).join(", ")}]`;
        }
        const st = ti.slotTypes(t);
        return `[${(v as any[]).map((x, i) => this.value(x, st[i]!)).join(", ")}]`;
      }
      case "map":
      case "chan": {
        if (v === null) return "null";
        const h = hook(ti.kind(t) as "map" | "chan");
        if (!h.enc) throw new Error("codec-heap: hook without enc");
        return h.enc(v, t, this);
      }
    }
  }
}

// ------------------------------------------------------------ heap module

export interface ObjText {
  /** slot texts (type literal); `undefined` slots are absent */
  slots: (string | undefined)[];
  /** the whole object's text instead of slots (a map state, src/types/map.ts) */
  text?: string;
  /** lazy: zero pattern texts */
  zero?: string[];
  lazy: boolean;
}

/** Number of hex digits of n - 1 (lazy depth), at least 1. */
export function lazyDepth(n: number): number {
  let d = 1;
  while (16 ** d < n) d++;
  return d;
}

/**
 * A `.ts` module declaring `export type Heap` for the given objects
 * (object k at id idOf(k)), plus the zero-size object at id 0.
 * `imp` is the import path of src/types/heap.gen.ts.
 */
export function encodeHeap(objs: ObjText[], imp: string, name = "Heap"): string {
  const out: string[] = [];
  out.push(`import type { E0, E1, E2, E3, E4, E5, E6, Mk16, Mk19 } from "${imp}";`);
  if (objs.some((o) => o.text !== undefined))
    out.push(
      `import type { MapMk5, MapMk6, MapMk16 } from "${imp.replace(/heap\.gen\.ts$/, "map.ts")}";`,
    );
  out.push(`type Z_ = Mk16<${Array(16).fill("E0").join(", ")}>;`);
  const leafName = (k: number) => `O_${idOf(k)}`;
  objs.forEach((o, k) => {
    const nm = leafName(k);
    if (o.text !== undefined) {
      out.push(`type ${nm} = ${o.text};`);
      return;
    }
    if (!o.lazy) {
      if (o.slots.length > 16) throw new Error("flat object over 16 slots");
      const s = o.slots.map((x) => x ?? "undefined");
      while (s.length < 16) s.push("undefined");
      out.push(`type ${nm} = [${s.join(", ")}];`);
      return;
    }
    const n = o.slots.length;
    const D = lazyDepth(n);
    // node at path p (MSB-first digits) of depth level L (0 = root's children...)
    const node = (prefix: number, level: number): string => {
      // level: number of digits fixed so far (prefix has `level` digits); leaves at level D
      if (level === D) return o.slots[prefix] ?? "undefined";
      const span = 16 ** (D - level);
      if (prefix * span >= n) return `E${D - level}`;
      const kids = Array.from({ length: 16 }, (_, d) => node(prefix * 16 + d, level + 1));
      if (level + 1 === D) {
        // children are slots: literal-only node
        const alias = `${nm}_${prefix.toString(16)}_${level}`;
        out.push(`type ${alias} = Mk16<${kids.join(", ")}>;`);
        return alias;
      }
      const alias = `${nm}_${prefix.toString(16)}_${level}`;
      out.push(`type ${alias} = Mk16<${kids.join(", ")}>;`);
      return alias;
    };
    const kids = Array.from({ length: 16 }, (_, d) => node(d, 1));
    const zp = `[${(o.zero ?? []).join(", ")}]`;
    out.push(`type ${nm} = Mk19<${kids.join(", ")}, "${D}", ${lit(encNat(n))}, ${zp}>;`);
  });
  // trie over ids 0..objs.length (id 0 = zerobase; object k at id k+1)
  const total = objs.length + 1;
  const W = ID_WIDTH;
  const tnode = (prefix: number, level: number): string => {
    if (level === W) return prefix === 0 ? "Z_" : prefix < total ? leafName(prefix - 1) : "E0";
    const span = 16 ** (W - level);
    if (prefix * span >= total) return `E${W - level}`;
    const kids = Array.from({ length: 16 }, (_, d) => tnode(prefix * 16 + d, level + 1));
    const alias = `T_${level}_${prefix.toString(16)}`;
    out.push(`type ${alias} = Mk16<${kids.join(", ")}>;`);
    return alias;
  };
  const root = tnode(0, 0);
  out.push(`export type ${name} = [${lit(idOf(objs.length))}, ${root}];`);
  return out.join("\n") + "\n";
}

// ------------------------------------------------------------ parsing our own text

export type TV = string | boolean | null | undefined | TV[] | { ref: string; args: TV[] };

/** Parses `type X = ...;` declarations (our own output and literal type text). */
export function parseModule(src: string): Map<string, TV> {
  const decls = new Map<string, TV>();
  const re = /(?:export )?type ([A-Za-z_$][\w$]*)\s*=\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const p = new Parser(src, re.lastIndex);
    decls.set(m[1]!, p.expr());
    re.lastIndex = p.i;
  }
  return decls;
}

class Parser {
  readonly s: string;
  i: number;
  constructor(s: string, i: number) {
    this.s = s;
    this.i = i;
  }
  ws() {
    while (/\s/.test(this.s[this.i] ?? "")) this.i++;
  }
  expr(): TV {
    this.ws();
    const c = this.s[this.i]!;
    if (c === '"') return this.str();
    if (c === "[") {
      this.i++;
      const xs: TV[] = [];
      this.ws();
      if (this.s[this.i] === "]") {
        this.i++;
        return xs;
      }
      for (;;) {
        xs.push(this.expr());
        this.ws();
        const d = this.s[this.i++];
        if (d === "]") return xs;
        if (d !== ",") throw new Error("parse: expected , or ] at " + this.i);
      }
    }
    const id = /^[A-Za-z_$][\w$.]*/.exec(this.s.slice(this.i, this.i + 200))?.[0];
    if (!id) throw new Error("parse: unexpected " + this.s.slice(this.i, this.i + 20));
    this.i += id.length;
    if (id === "true") return true;
    if (id === "false") return false;
    if (id === "null") return null;
    if (id === "undefined") return undefined;
    this.ws();
    const args: TV[] = [];
    if (this.s[this.i] === "<") {
      this.i++;
      for (;;) {
        args.push(this.expr());
        this.ws();
        const d = this.s[this.i++];
        if (d === ">") break;
        if (d !== ",") throw new Error("parse: expected , or > at " + this.i);
      }
    }
    return { ref: id, args };
  }
  str(): string {
    let o = "";
    this.i++;
    for (;;) {
      const c = this.s[this.i++]!;
      if (c === '"') return o;
      if (c === "\\") {
        const e = this.s[this.i++]!;
        if (e === "x") {
          o += String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 2), 16));
          this.i += 2;
        } else if (e === "u") {
          o += String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 4), 16));
          this.i += 4;
        } else o += e === "n" ? "\n" : e === "t" ? "\t" : e;
      } else o += c;
    }
  }
}

/** Evaluates a parsed type to plain data: tuples as arrays (constructors applied). */
export function evalType(t: TV, decls: Map<string, TV>, memo = new Map<string, any>()): any {
  if (t === null || t === undefined || typeof t !== "object") return t;
  if (Array.isArray(t)) return t.map((x) => evalType(x, decls, memo));
  const { ref, args } = t;
  if (args.length === 0) {
    if (memo.has(ref)) return memo.get(ref);
    const e = /^E(\d)$/.exec(ref);
    let v: any;
    if (e) v = emptyNode(Number(e[1]));
    else {
      const d = decls.get(ref);
      if (d === undefined) throw new Error("evalType: unknown alias " + ref);
      v = evalType(d, decls, memo);
    }
    memo.set(ref, v);
    return v;
  }
  const a = args.map((x) => evalType(x, decls, memo));
  if (
    ref === "Mk16" ||
    ref === "Mk19" ||
    ref === "HeapMk" ||
    ref.endsWith("Mk2") ||
    ref.endsWith("Mk4") ||
    ref.endsWith("Mk5") ||
    ref.endsWith("Mk6") ||
    ref.endsWith("Mk16")
  )
    return a;
  throw new Error("evalType: unknown constructor " + ref);
}
const emptyMemo: any[] = [undefined];
function emptyNode(d: number): any {
  while (emptyMemo.length <= d) emptyMemo.push(Array(16).fill(emptyMemo[emptyMemo.length - 1]));
  return emptyMemo[d];
}

/** The objects of an evaluated heap `[next, root]`: id -> object tuple. */
export function heapObjects(h: any[]): Map<string, any[]> {
  const [next, root] = h as [string, any];
  const n = parseInt(next, 16);
  const out = new Map<string, any[]>();
  for (let k = 0; k < n; k++) {
    const id = k.toString(16).padStart(ID_WIDTH, "0");
    let node = root;
    for (const d of id) node = node[parseInt(d, 16)];
    out.set(id, node);
  }
  return out;
}

/** Slot s of an evaluated object tuple (flat or lazy); `undefined` if never written. */
export function objSlot(o: any[], s: number): any {
  if (o.length !== 19) return o[s];
  const D = Number(o[16]);
  let node: any = o;
  for (let l = D - 1; l >= 0; l--) node = node[Math.floor(s / 16 ** l) % 16];
  return node;
}
/** Number of slots of an evaluated object (flat: up to the padding). */
export function objSize(o: any[]): number {
  if (o.length === 19) return Number(decNat(o[17]));
  let n = 0;
  while (n < 16 && o[n] !== undefined) n++;
  return n;
}

// ------------------------------------------------------------ decoding values

/** Decodes evaluated type-level values to snapshot-format JSON values. */
export class Dec {
  readonly ti: TypeInfo;
  constructor(ti: TypeInfo) {
    this.ti = ti;
  }
  int(s: string, t: number): any {
    const w = this.ti.width(t);
    const info = this.ti.T.info[t]!;
    const signed = info.ik ? info.ik[0] === "i" : false;
    const b = signed ? BigInt.asIntN(w, decNat(s)) : BigInt.asUintN(w, decNat(s));
    return b >= -(2n ** 53n) + 1n && b <= 2n ** 53n - 1n ? Number(b) : { n: b.toString() };
  }
  obj(id: string): number {
    return idNum(id);
  }
  value(v: any, t: number): any {
    const ti = this.ti;
    switch (ti.kind(t)) {
      case "bool":
        return v;
      case "int":
      case "float":
        return this.int(v, t);
      case "string":
        return v;
      case "pointer":
      case "opaque":
        if (ti.isIter(t)) return iterHook().dec!(v, t, this);
        return v === null ? null : { p: this.obj(v[0]), i: Number(decNat(v[1])) };
      case "slice":
        return v === null
          ? null
          : {
              s: this.obj(v[0]),
              i: Number(decNat(v[1])),
              l: Number(decNat(v[2])),
              c: Number(decNat(v[3])),
            };
      case "iface": {
        if (v === null) return null;
        const dt = Number(decNat(v[0]));
        return { t: dt, v: this.value(v[1], dt) };
      }
      case "func": {
        if (v === null) return null;
        const fn = Number(decNat(v[0]));
        const et = ti.envTypes(fn);
        return { f: fn, e: (v[1] as any[]).map((x, i) => this.value(x, et[i]!)) };
      }
      case "agg": {
        const info = ti.T.info[t]!;
        const st = info.k === "tuple" ? ((info.u as any).elems as number[]) : ti.slotTypes(t);
        return (v as any[]).map((x, i) => this.value(x, st[i]!));
      }
      case "map":
      case "chan": {
        if (v === null) return null;
        const h = hook(ti.kind(t) as "map" | "chan");
        if (!h.dec) throw new Error("codec-heap: hook without dec");
        return h.dec(v, t, this);
      }
    }
  }
}

// ------------------------------------------------------------ snapshots

/**
 * Slot types of snapshot objects from the typed roots: obj index -> slot ->
 * type id. Pointers type the pointee's slots, slices the elements up to cap,
 * interfaces their payload, funcs their environment.
 */
export function typeSnapshot(
  ti: TypeInfo,
  snap: any,
  maps = new Map<number, number>(),
): Map<number, Map<number, number>> {
  const types = new Map<number, Map<number, number>>();
  const work: [any, number][] = [];
  const setSlot = (o: number, i: number, t: number) => {
    if (o < 0) return;
    let m = types.get(o);
    if (!m) types.set(o, (m = new Map()));
    if (m.has(i)) return;
    m.set(i, t);
    const so = snap.objects[o];
    if (so?.k === "o") work.push([so.s[i], t]);
  };
  const region = (o: number, i: number, t: number) => {
    const st = ti.slotTypes(t);
    for (let k = 0; k < st.length; k++) setSlot(o, i + k, st[k]!);
  };
  const visit = (v: any, t: number) => {
    if (v === null || v === undefined || typeof v !== "object" || "u" in v) return;
    switch (ti.kind(t)) {
      case "pointer": {
        const e = ti.elem(t);
        // pointer to a zero-size or bodyless type types nothing
        if (ti.T.info[e]!.slots > 0) region(v.p, v.i, e);
        return;
      }
      case "slice": {
        const e = ti.elem(t);
        const es = ti.T.info[e]!.slots;
        for (let k = 0; k < v.c; k++) region(v.s, v.i + k * es, e);
        return;
      }
      case "iface":
        return visit(v.v, v.t);
      case "func": {
        const et = ti.envTypes(v.f);
        (v.e as any[]).forEach((x, i) => visit(x, et[i]!));
        return;
      }
      case "map": {
        const o = v.m as number;
        if (maps.has(o)) return;
        maps.set(o, t);
        const so = snap.objects[o];
        if (so?.k !== "m") return;
        const [kt, vt] = ti.mapTypes(t);
        for (const [k, x] of so.e) work.push([k, kt], [x, vt]);
        return;
      }
      case "agg": {
        const info = ti.T.info[t]!;
        const st = info.k === "tuple" ? ((info.u as any).elems as number[]) : ti.slotTypes(t);
        (v as any[]).forEach((x, i) => visit(x, st[i]!));
        return;
      }
    }
  };
  const prog = ti.prog;
  snap.globals.forEach((g: number, k: number) => region(g, 0, prog.globals[k]!.type));
  for (const fr of snap.frames) {
    const rt = prog.funcs[fr.fn]!.regTypes;
    const its = ti.iterSources(fr.fn);
    fr.r.forEach((v: any, i: number) => {
      // a map iterator { mi, q } holds its map (type: the range operand's)
      if (v && typeof v === "object" && "mi" in v) {
        if (v.mi !== null) visit({ m: v.mi }, its.get(i)!);
      } else visit(v, rt[i]!);
    });
    for (const d of fr.df ?? []) {
      const sig = prog.types[prog.funcs[d.fn]!.sig] as any;
      (d.a as any[]).forEach((x, i) => visit(x, sig.params[i]));
      if (d.env) ti.envTypes(d.fn).forEach((et, i) => visit(d.env[i], et));
    }
  }
  for (const p of snap.panics)
    if (p.v && typeof p.v === "object" && "t" in p.v) visit(p.v.v, p.v.t);
  while (work.length > 0) {
    const [v, t] = work.pop()!;
    visit(v, t);
  }
  return types;
}

/** Encodes a snapshot JSON value of type t (ids: snapshot object k -> idOf(k)). */
export function encSnapValue(ti: TypeInfo, v: any, t: number): string {
  if (v !== null && typeof v === "object" && "u" in v) return "undefined";
  switch (ti.kind(t)) {
    case "bool":
      return v ? "true" : "false";
    case "int":
    case "float": {
      const b = typeof v === "object" ? BigInt(v.n) : BigInt(v);
      return lit(encNat(BigInt.asIntN(ti.width(t), b)));
    }
    case "string":
      return lit(v);
    case "pointer":
    case "opaque":
      if (v !== null && ("mi" in v || "si" in v)) return iterHook().encSnap!(v, t, ti);
      return v === null ? "null" : `[${lit(snapId(v.p))}, ${lit(encNat(v.i))}]`;
    case "slice":
      return v === null
        ? "null"
        : `[${lit(snapId(v.s))}, ${lit(encNat(v.i))}, ${lit(encNat(v.l))}, ${lit(encNat(v.c))}]`;
    case "iface":
      return v === null ? "null" : `[${lit(encNat(v.t))}, ${encSnapValue(ti, v.v, v.t)}]`;
    case "func": {
      if (v === null) return "null";
      const et = ti.envTypes(v.f);
      return `[${lit(encNat(v.f))}, [${(v.e as any[]).map((x, i) => encSnapValue(ti, x, et[i]!)).join(", ")}]]`;
    }
    case "agg": {
      const info = ti.T.info[t]!;
      const st = info.k === "tuple" ? ((info.u as any).elems as number[]) : ti.slotTypes(t);
      return `[${(v as any[]).map((x, i) => encSnapValue(ti, x, st[i]!)).join(", ")}]`;
    }
    case "map":
    case "chan": {
      if (v === null) return "null";
      const h = hook(ti.kind(t) as "map" | "chan");
      if (!h.encSnap) throw new Error("codec-heap: hook without encSnap");
      return h.encSnap(v, t, ti);
    }
  }
}
const snapId = (k: number) => (k < 0 ? "0".repeat(ID_WIDTH) : idOf(k));
const deadSlot = (v: any) => `["?", ${lit(JSON.stringify(v))}]`;

export interface TypesState {
  /** the heap module (declares `Heap`) */
  heap: string;
  /** per frame: register texts (type literals) */
  frames: string[][];
}

/** A reference snapshot's objects and frame registers in type-level form. */
export function snapshotToTypes(prog: Program, snap: any, imp: string): TypesState {
  const ti = new TypeInfo(prog);
  const maps = new Map<number, number>();
  const types = typeSnapshot(ti, snap, maps);
  const objs: ObjText[] = snap.objects.map((o: any, k: number) => {
    if (o.k === "m") {
      const h = hook("map");
      if (!h.encObject) throw new Error("codec-heap: map hook without encObject");
      return h.encObject(o, k, ti);
    }
    if (o.k !== "o") throw new Error(`codec-heap: object ${k} is a channel (no codec)`);
    const st = types.get(k);
    const slots = (o.s as any[]).map((v, i) => {
      const t = st?.get(i);
      return t === undefined ? deadSlot(v) : encSnapValue(ti, v, t);
    });
    const lazy = slots.length > 16;
    return { slots, lazy, zero: lazy ? ["undefined"] : undefined };
  });
  const frames = snap.frames.map((fr: any) => {
    const rt = prog.funcs[fr.fn]!.regTypes;
    return (fr.r as any[]).map((v, i) => encSnapValue(ti, v, rt[i]!));
  });
  return { heap: encodeHeap(objs, imp), frames };
}

/** The objects and frame registers of a snapshot from type-level form (other fields from `base`). */
export function typesToSnapshot(prog: Program, st: TypesState, base: any): any {
  const ti = new TypeInfo(prog);
  const decls = parseModule(st.heap);
  const h = evalType({ ref: "Heap", args: [] }, decls);
  const objs = heapObjects(h);
  const dec = new Dec(ti);
  const frames = base.frames.map((fr: any, k: number) => {
    const rt = prog.funcs[fr.fn]!.regTypes;
    const regs = st.frames[k]!.map((txt, i) => {
      const v = evalType(new Parser(txt, 0).expr(), decls);
      return v === undefined ? { u: 1 } : dec.value(v, rt[i]!);
    });
    return { ...fr, r: regs };
  });
  const partial = { ...base, frames, objects: [] as any[] };
  // decode objects: slot types from a traversal of the decoded roots
  const n = parseInt(h[0], 16) - 1;
  const raw: any[][] = [];
  const isMap: boolean[] = [];
  for (let k = 0; k < n; k++) {
    const o = objs.get(idOf(k))!;
    // a map state is a 6-tuple (map.ts Mk6); objects are 16- or 19-tuples
    isMap.push(o.length === 6);
    if (o.length === 6) {
      raw.push(o);
      continue;
    }
    const size = objSize(o);
    // lazy objects: an unwritten slot reads as the zero pattern's slot
    const z = o.length === 19 ? (o[18] as any[]) : [];
    raw.push(
      Array.from({ length: size }, (_, s) => {
        const v = objSlot(o, s);
        return v === undefined && z.length > 0 ? z[s % z.length] : v;
      }),
    );
  }
  // first pass: decode with types found so far, iterate to a fixpoint
  const decoded: any[][] = raw.map((r, k) => (isMap[k] ? [] : r.map(() => null)));
  partial.objects = decoded.map((s, k) =>
    isMap[k] ? { k: "m", t: -1, e: [], n: 0 } : { k: "o", s },
  );
  let types = new Map<number, Map<number, number>>();
  const mapsDone = new Set<number>();
  for (;;) {
    const maps = new Map<number, number>();
    const t2 = typeSnapshot(ti, partial, maps);
    let grew = false;
    for (const [o, t] of maps) {
      if (mapsDone.has(o)) continue;
      if (!isMap[o]) throw new Error(`codec-heap: object ${o} is typed as a map but is not one`);
      const h = hook("map");
      if (!h.decObject) throw new Error("codec-heap: map hook without decObject");
      partial.objects[o] = h.decObject(raw[o], t, dec);
      mapsDone.add(o);
      grew = true;
    }
    for (const [o, m] of t2)
      for (const [i, t] of m) {
        if (types.get(o)?.has(i)) continue;
        grew = true;
        const v = raw[o]![i];
        decoded[o]![i] = v === undefined ? null : dec.value(v, t);
      }
    types = t2;
    if (!grew) break;
  }
  isMap.forEach((m, o) => {
    if (m && !mapsDone.has(o))
      throw new Error(`codec-heap: map object ${o} is reached by no typed path`);
  });
  raw.forEach(
    (r, o) =>
      isMap[o] ||
      r.forEach((v, i) => {
        if (types.get(o)?.has(i)) return;
        decoded[o]![i] =
          Array.isArray(v) && v[0] === "?" ? JSON.parse(v[1]) : v === undefined ? null : v;
      }),
  );
  return partial;
}

// ------------------------------------------------------------ globals

/**
 * Object id of every global (heap.ts header): non-zero-size globals get
 * ids 1, 2, ... in `Program.globals` order, zero-size ones the zero-size
 * object "00000". A global's address is `[id, "0"]`.
 */
export function globalIds(prog: Program): string[] {
  let k = 0;
  return prog.globals.map((g) =>
    prog.types[g.type]!.slots === 0 ? "0".repeat(ID_WIDTH) : idOf(k++),
  );
}

/** The heap at program start: every global zeroed (flat up to 16 slots, else lazy). */
export function initialHeap(prog: Program, imp: string, name = "Heap"): string {
  const ti = new TypeInfo(prog);
  const objs: ObjText[] = [];
  for (const g of prog.globals) {
    const n = prog.types[g.type]!.slots;
    if (n === 0) continue;
    if (n <= 16) objs.push({ slots: ti.zeroText(g.type), lazy: false });
    else objs.push({ slots: Array(n).fill(undefined), lazy: true, zero: ti.zeroText(g.type) });
  }
  return encodeHeap(objs, imp, name);
}

// ------------------------------------------------------------ program tables

/**
 * The per-program tables heap.ts reads as `P` (H1: non-generic interfaces):
 * implements pairs, type names, first missing methods and equality kinds,
 * for the given dynamic types and interfaces. Declares `interface <name>`.
 */
export function progTables(prog: Program, dyn: number[], ifaces: number[], name = "P"): string {
  const ti = new TypeInfo(prog);
  const T = ti.T;
  const impl: string[] = [];
  const missing: string[] = [];
  for (const t of dyn)
    for (const i of ifaces) {
      const key = lit(`${encNat(t)}:${encNat(i)}`);
      const mm = T.missing(t, i);
      if (mm === null) impl.push(`${key}: true;`);
      else missing.push(`${key}: ${lit(mm.slice(mm.lastIndexOf(".") + 1))};`);
    }
  const all = [...new Set([...dyn, ...ifaces, ...prog.types.map((_, i) => i)])];
  const names = all.map((t) => `${lit(encNat(t))}: ${lit(T.name(t))};`);
  const eqk = dyn.map((t) => `${lit(encNat(t))}: ${eqKind(ti, t)};`);
  return [
    `interface ${name}Impl { ${impl.join(" ")} }`,
    `interface ${name}Names { ${names.join(" ")} }`,
    `interface ${name}Missing { ${missing.join(" ")} }`,
    `interface ${name}Eqk { ${eqk.join(" ")} }`,
    `interface ${name} { impl: ${name}Impl; names: ${name}Names; missing: ${name}Missing; eqk: ${name}Eqk; }`,
  ].join("\n");
}

/** The equality kind `Eq` takes for values of type t (text), or `"unc"`. */
export function eqKind(ti: TypeInfo, t: number): string {
  const T = ti.T;
  if (T.eq(t) === null) return lit("unc");
  const one = (s: number): string => {
    const k = T.info[s]!;
    if (k.k === "float") return lit(k.fbits === 32 ? "f32" : "f64");
    if (k.k === "interface") return lit("i");
    return lit("=");
  };
  if (T.info[t]!.agg) return `[${ti.slotTypes(t).map(one).join(", ")}]`;
  return one(t);
}
