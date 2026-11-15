// Codec for maps (src/types/map.ts): a reference GoMap (src/ref/gomap.ts)
// <-> the type literal source text of its map state, the object a map value
// points at on the heap. The state is a function of the entries (canonical
// key, key, value, sequence number) and the next sequence number, so the
// conversion is a bijection on what the reference can observe.
//
// Text is written with constructor calls (`Mk6`, `Mk5`, `Mk16`, H1 of
// docs/stage0/HEAP.md); `names` says what they are called where the text is
// used (map.ts exports them as MapMk6, MapMk5 and MapMk16).
import { GoMap } from "../ref/gomap.ts";
import {
  codecHooks,
  decNat,
  Dec,
  encNat,
  encSnapValue,
  ID_WIDTH,
  idOf,
  TypeInfo,
} from "./codec-heap.ts";
import { encodeInt64 } from "./codec-int.ts";
import { strToType } from "./codec-str.ts";
import { strHash } from "./hash-spec.ts";

/** How keys of one map type convert: the canonical form C (map.ts `Key*`) and type text of a key. */
export interface MapKeyCodec {
  /** "i" for integer keys, "s" otherwise (map.ts Mode). */
  mode: "s" | "i";
  /** C of a reference key value. */
  canon(k: unknown): string;
  /** Type text of a reference key value. */
  keyText(k: unknown): string;
  /** A reference key value from its parsed type text (see parseTypeText). */
  keyFrom(t: TypeTree): unknown;
}

export interface MapValCodec {
  valText(v: unknown): string;
  valFrom(t: TypeTree): unknown;
}

export interface CtorNames {
  mk6: string;
  mk5: string;
  mk16: string;
}
const NAMES: CtorNames = { mk6: "MapMk6", mk5: "MapMk5", mk16: "MapMk16" };

const enc = (n: number | bigint) => encodeInt64(BigInt(n));

// ---------------------------------------------------------------- canonical keys

/** Canonical forms per key kind (map.ts KeyStr, KeyBool, KeyPtr; integers and strings are themselves). */
export const canonKey = {
  str: (s: string) => s,
  int: (v: bigint | number) => enc(v),
  bool: (b: boolean) => (b ? "t" : "f"),
  /** A pointer by heap id and slot (type-level `[Id, Slot]`), or null. */
  ptr: (p: { id: string; slot: number | bigint } | null) =>
    p === null ? "nil" : `${p.id}.${enc(p.slot)}`,
  /** A string field of a struct or array key. */
  strField: (s: string) => `${enc(s.length)}:${s}`,
};

/** The index path of canonical key C (map.ts KeyPath). */
export function keyPath(mode: "s" | "i", c: string): string {
  return mode === "i" ? (c + "0000").slice(0, 4) : strHash(c);
}

/** The order trie depth for next sequence number seq (map.ts grows it on insert). */
export function orderDepth(seq: number): number {
  let d = 1;
  while (seq - 1 >= 16 ** d) d++;
  return d;
}

const seqPath = (seq: number, d: number) => seq.toString(16).padStart(d, "0");

// ---------------------------------------------------------------- to type text

type Trie = Map<string, Trie | string>;

function put(t: Trie, path: string, leaf: string): void {
  let n = t;
  for (let i = 0; i < path.length - 1; i++) {
    let c = n.get(path[i]!) as Trie | undefined;
    if (!c) n.set(path[i]!, (c = new Map()));
    n = c;
  }
  n.set(path[path.length - 1]!, leaf);
}

function printTrie(t: Trie | undefined, names: CtorNames): string {
  if (!t || t.size === 0) return "undefined";
  const cs: string[] = [];
  for (const d of "0123456789abcdef") {
    const c = t.get(d);
    cs.push(c === undefined ? "undefined" : typeof c === "string" ? c : printTrie(c, names));
  }
  return `${names.mk16}<${cs.join(", ")}>`;
}

/** The map state of m as type text. */
export function mapStateToType(
  m: GoMap,
  kc: MapKeyCodec,
  vc: MapValCodec,
  names: CtorNames = NAMES,
): string {
  const live = m.es.filter((e) => e.alive).sort((a, b) => a.seq - b.seq);
  const buckets = new Map<string, string[]>();
  const ord: Trie = new Map();
  const d = orderDepth(m.nextSeq);
  for (const e of live) {
    const c = kc.canon(e.k);
    const p = keyPath(kc.mode, c);
    const ent = [strToType(c), kc.keyText(e.k), vc.valText(e.v), JSON.stringify(enc(e.seq))];
    let b = buckets.get(p);
    if (!b) buckets.set(p, (b = []));
    b.push(ent.join(", "));
    put(ord, seqPath(e.seq, d), strToType(p + c));
  }
  const idx: Trie = new Map();
  for (const [p, b] of buckets) {
    let chain = "undefined";
    for (let i = b.length - 1; i >= 0; i--) chain = `${names.mk5}<${b[i]}, ${chain}>`;
    put(idx, p, chain);
  }
  return `${names.mk6}<${[
    JSON.stringify(enc(live.length)),
    JSON.stringify(enc(m.nextSeq)),
    JSON.stringify(kc.mode),
    printTrie(idx, names),
    JSON.stringify(String(d)),
    printTrie(ord, names),
  ].join(", ")}>`;
}

// ---------------------------------------------------------------- from type text

/** A parsed type: string literal, boolean, null, undefined, a tuple, or a constructor call (by name). */
export type TypeTree =
  | string
  | boolean
  | null
  | undefined
  | TypeTree[]
  | { call: string; args: TypeTree[] };

/**
 * Parse type text made of string literals, `true`/`false`/`null`/`undefined`,
 * tuples `[a, b]` and generic calls `Name<a, b>` (what the codecs print and
 * what a hover shows for these values).
 */
export function parseTypeText(src: string): TypeTree {
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };
  const value = (): TypeTree => {
    ws();
    const c = src[i]!;
    if (c === '"') {
      let j = i + 1;
      while (src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      const lit = src.slice(i, j + 1);
      i = j + 1;
      return JSON.parse(lit.replace(/\\x([0-9a-fA-F]{2})/g, "\\u00$1")) as string;
    }
    if (c === "[") {
      i++;
      const xs: TypeTree[] = [];
      ws();
      while (src[i] !== "]") {
        xs.push(value());
        ws();
        if (src[i] === ",") i++;
        ws();
      }
      i++;
      return xs;
    }
    const m = /^[A-Za-z_$][\w$.]*/.exec(src.slice(i));
    if (!m)
      throw new SyntaxError(`parseTypeText: unexpected ${JSON.stringify(src.slice(i, i + 20))}`);
    i += m[0].length;
    const w = m[0];
    ws();
    if (src[i] === "<") {
      i++;
      const args: TypeTree[] = [];
      ws();
      while (src[i] !== ">") {
        args.push(value());
        ws();
        if (src[i] === ",") i++;
        ws();
      }
      i++;
      return { call: w, args };
    }
    if (w === "true") return true;
    if (w === "false") return false;
    if (w === "null") return null;
    if (w === "undefined") return undefined;
    throw new SyntaxError(`parseTypeText: unknown name ${w}`);
  };
  const r = value();
  ws();
  if (i !== src.length) throw new SyntaxError("parseTypeText: trailing text");
  return r;
}

/** Elements of a tuple or a constructor call. */
const elems = (t: TypeTree): TypeTree[] => {
  if (Array.isArray(t)) return t;
  if (t && typeof t === "object") return t.args;
  throw new TypeError("not a tuple: " + JSON.stringify(t));
};

/** The reference map (with type id `typeId` and key canonicaliser keyOf) of a map state. */
export function mapStateFromType(
  src: string | TypeTree,
  typeId: number,
  keyOf: (k: unknown) => unknown,
  kc: MapKeyCodec,
  vc: MapValCodec,
): GoMap {
  const ms = elems(typeof src === "string" ? parseTypeText(src) : src);
  const num = (t: TypeTree) => {
    if (typeof t !== "string") throw new TypeError("not an int");
    let u = 0n;
    for (let j = t.length - 1; j >= 0; j--) u = (u << 4n) | BigInt(parseInt(t[j]!, 16));
    return Number(BigInt.asIntN(4 * t.length, u));
  };
  const entries: { k: unknown; v: unknown; seq: number }[] = [];
  const walk = (n: TypeTree, depth: number) => {
    if (n === undefined) return;
    if (depth === 0) {
      for (let e: TypeTree = n; e !== undefined;) {
        const f = elems(e);
        entries.push({ k: kc.keyFrom(f[1]), v: vc.valFrom(f[2]), seq: num(f[3]!) });
        e = f[4];
      }
      return;
    }
    for (const c of elems(n)) walk(c, depth - 1);
  };
  walk(ms[3], 4);
  entries.sort((a, b) => a.seq - b.seq);
  const m = new GoMap(typeId, keyOf);
  for (const e of entries) m.restore(e.k, e.v, e.seq);
  m.nextSeq = num(ms[1]!);
  return m;
}

// ---------------------------------------------------------------- maps on the heap

/**
 * Canonical key C (map.ts) of a snapshot-format key value of type t: strings,
 * integers (their type-level int) and bools as map.ts's Key*; pointers
 * `${id}.${slot}` or "nil"; structs and arrays slot by slot, each string
 * slot as `${Len}:${S}` (KeyStr) and every other slot as its form followed
 * by ",". Float and interface keys trap at the type level (DESIGN.md).
 */
export function snapKeyCanon(ti: TypeInfo, k: any, t: number): string {
  const one = (v: any, s: number): string => {
    switch (ti.kind(s)) {
      case "string":
        return v as string;
      case "int":
        return encNat(BigInt.asIntN(ti.width(s), typeof v === "object" ? BigInt(v.n) : BigInt(v)));
      case "bool":
        return canonKey.bool(v as boolean);
      case "pointer":
      case "chan":
        return v === null ? "nil" : `${v.p < 0 ? "0".repeat(ID_WIDTH) : idOf(v.p)}.${encNat(v.i)}`;
      default:
        throw new Error(`codec-map: ${ti.T.name(s)} keys are not supported at the type level`);
    }
  };
  if (ti.kind(t) !== "agg") return one(k, t);
  const st = ti.slotTypes(t);
  let c = "";
  st.forEach((s, i) => {
    c += ti.kind(s) === "string" ? canonKey.strField(k[i] as string) : one(k[i], s) + ",";
  });
  return c;
}

/** map.ts Mode of a map type: "i" for integer keys. */
export function mapMode(ti: TypeInfo, t: number): "i" | "s" {
  return ti.kind(ti.mapTypes(t)[0]) === "int" ? "i" : "s";
}

/** Key and value codecs of a map type for snapshot-format values. */
export function snapMapCodecs(ti: TypeInfo, t: number): [MapKeyCodec, MapValCodec] {
  const [kt, vt] = ti.mapTypes(t);
  return [
    {
      mode: mapMode(ti, t),
      canon: (k) => snapKeyCanon(ti, k, kt),
      keyText: (k) => encSnapValue(ti, k, kt),
      keyFrom: (x) => x,
    },
    { valText: (v) => encSnapValue(ti, v, vt), valFrom: (x) => x },
  ];
}

/** Text of a snapshot map object `{ k: "m", t, e: [[k, v, seq]...], n }`. */
export function snapMapToType(ti: TypeInfo, o: any, names: CtorNames = NAMES): string {
  const [kc, vc] = snapMapCodecs(ti, o.t);
  const m = new GoMap(o.t, (k) => kc.canon(k));
  for (const [k, v, seq] of o.e) m.restore(k, v, seq);
  m.nextSeq = o.n;
  return mapStateToType(m, kc, vc, names);
}

/** A snapshot map object from an evaluated map state (codec-heap's evalType form). */
export function snapMapFromState(ms: any[], t: number, d: Dec): any {
  const [kt, vt] = d.ti.mapTypes(t);
  const e: [any, any, number][] = [];
  const walk = (node: any, depth: number) => {
    if (node === undefined) return;
    if (depth === 0) {
      for (let x = node; x !== undefined; x = x[4])
        e.push([d.value(x[1], kt), d.value(x[2], vt), Number(decNat(x[3]))]);
      return;
    }
    for (const c of node as any[]) walk(c, depth - 1);
  };
  walk(ms[3], 4);
  e.sort((a, b) => a[2] - b[2]);
  return { k: "m", t, e, n: Number(decNat(ms[1])) };
}

codecHooks.map = {
  enc: (v, _t, e) => strToType(e.id(v as object)),
  encSnap: (v) => strToType(v.m < 0 ? "0".repeat(ID_WIDTH) : idOf(v.m)),
  dec: (v, _t, d) => ({ m: d.obj(v as string) }),
  encObject: (o, _k, ti) => ({ slots: [], lazy: false, text: snapMapToType(ti, o) }),
  decObject: (o, t, d) => snapMapFromState(o, t, d),
};
