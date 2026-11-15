// Type facts the interpreter needs, derived from Program.types: underlying
// kind, zero values, slot layout, Go type strings, byte sizes (for
// growslice), comparability, equality and map-key canonicalisation.
import type { Program, Type } from "../ir/types.ts";
import type { GoMap } from "./gomap.ts";
import { bitsToF32, bitsToF64, Chan, Func, Iface, Ptr, rtError, type Kind, type Obj } from "./values.ts";

export interface TInfo {
  id: number;
  t: Type;
  /** Underlying type and its id. */
  u: Type;
  uid: number;
  k: Type["k"];
  slots: number;
  /** Struct or array: a flat value[] in registers. */
  agg: boolean;
  ik?: Kind;
  fbits?: 32 | 64;
}

export class Types {
  info: TInfo[] = [];
  private zeros: any[] = [];
  private zslotsC: any[][] = [];
  private names: (string | undefined)[] = [];
  private sizes: ([number, number] | undefined)[] = [];
  private ptrsC: (boolean | undefined)[] = [];
  private slotTypesC: (number[] | undefined)[] = [];
  private eqC: (((a: any, b: any) => boolean) | null | undefined)[] = [];
  private keyC: (((a: any) => any) | undefined)[] = [];
  private methodsC: (Record<string, number> | undefined)[] = [];
  private implC = new Map<number, boolean>();
  byName = new Map<string, number>();

  prog: Program;
  constructor(prog: Program) {
    this.prog = prog;
    const ts = prog.types;
    for (let id = 0; id < ts.length; id++) {
      const t = ts[id]!;
      let uid = id;
      while (ts[uid]!.k === "named") uid = (ts[uid] as any).underlying;
      const u = ts[uid]!;
      this.info.push({
        id,
        t,
        u,
        uid,
        k: u.k,
        slots: t.slots,
        agg: u.k === "struct" || u.k === "array",
        ik: u.k === "int" ? (u.int as Kind) : undefined,
        fbits: u.k === "float" ? u.bits : undefined,
      });
      if (t.k === "named" && !this.byName.has(t.name)) this.byName.set(t.name, id);
    }
  }

  /** Zero value in a register (aggregates: shared, never mutated). */
  zero(id: number): any {
    if (id in this.zeros) return this.zeros[id];
    const ti = this.info[id]!;
    let z: any;
    if (ti.agg) z = this.zslots(id);
    else z = this.scalarZero(ti);
    this.zeros[id] = z;
    return z;
  }

  private scalarZero(ti: TInfo): any {
    switch (ti.k) {
      case "bool":
        return false;
      case "int":
      case "float":
        return 0;
      case "string":
        return "";
      case "tuple":
        return (ti.u as any).elems.map((e: number) => this.zero(e));
      default:
        return null;
    }
  }

  /** The zero slots of a type, as stored in memory. */
  zslots(id: number): any[] {
    const c = this.zslotsC[id];
    if (c) return c;
    const ti = this.info[id]!;
    let r: any[];
    if (ti.u.k === "array") {
      const e = this.zslots(ti.u.elem);
      r = [];
      for (let i = 0; i < ti.u.len; i++) for (const x of e) r.push(x);
    } else if (ti.u.k === "struct") {
      r = [];
      for (const f of ti.u.fields) for (const x of this.zslots(f.type)) r.push(x);
    } else r = [this.scalarZero(ti)];
    this.zslotsC[id] = r;
    return r;
  }

  /** Scalar type id of every slot of an aggregate (or [id] for a scalar). */
  slotTypes(id: number): number[] {
    const c = this.slotTypesC[id];
    if (c) return c;
    const ti = this.info[id]!;
    let r: number[];
    if (ti.u.k === "array") {
      const e = this.slotTypes(ti.u.elem);
      r = [];
      for (let i = 0; i < ti.u.len; i++) r.push(...e);
    } else if (ti.u.k === "struct") {
      r = [];
      for (const f of ti.u.fields) r.push(...this.slotTypes(f.type));
    } else r = [id];
    this.slotTypesC[id] = r;
    return r;
  }

  /** Go's type string (as %T and panics print it). */
  name(id: number): string {
    const c = this.names[id];
    if (c !== undefined) return c;
    const t = this.prog.types[id]!;
    let s: string;
    switch (t.k) {
      case "named":
        s = t.name;
        break;
      case "bool":
      case "string":
        s = t.k;
        break;
      case "int":
        s = t.name ?? t.int;
        break;
      case "float":
        s = "float" + t.bits;
        break;
      case "pointer":
        s = "*" + this.name(t.elem);
        break;
      case "slice":
        s = "[]" + this.name(t.elem);
        break;
      case "array":
        s = `[${t.len}]` + this.name(t.elem);
        break;
      case "chan":
        s = "chan " + this.name(t.elem);
        break;
      case "map":
        s = `map[${this.name(t.key)}]${this.name(t.elem)}`;
        break;
      case "func": {
        const ps = t.params.map((p, i) =>
          t.variadic && i === t.params.length - 1
            ? "..." + this.name(p).slice(2)
            : this.name(p),
        );
        const rs = t.results.map((r) => this.name(r));
        s =
          `func(${ps.join(", ")})` +
          (rs.length === 0 ? "" : rs.length === 1 ? " " + rs[0] : ` (${rs.join(", ")})`);
        break;
      }
      case "interface":
        s =
          t.methods.length === 0
            ? "interface {}"
            : `interface { ${t.methods.map((m) => m.slice(m.lastIndexOf(".") + 1) + "()").join("; ")} }`;
        break;
      case "struct":
        s =
          t.fields.length === 0
            ? "struct {}"
            : `struct { ${t.fields.map((f) => (f.embedded ? this.name(f.type) : f.name + " " + this.name(f.type))).join("; ")} }`;
        break;
      case "tuple":
        s = `(${t.elems.map((e) => this.name(e)).join(", ")})`;
        break;
      case "opaque":
        s = t.what;
        break;
    }
    this.names[id] = s;
    return s;
  }

  /** [size, align] in bytes on amd64. */
  size(id: number): [number, number] {
    const c = this.sizes[id];
    if (c) return c;
    const ti = this.info[id]!;
    const u = ti.u;
    let r: [number, number];
    switch (u.k) {
      case "bool":
        r = [1, 1];
        break;
      case "int": {
        const w = Number(u.int.replace(/\D/g, "")) / 8;
        r = [w, w];
        break;
      }
      case "float":
        r = [u.bits / 8, u.bits / 8];
        break;
      case "string":
      case "interface":
        r = [16, 8];
        break;
      case "slice":
        r = [24, 8];
        break;
      case "array": {
        const [s, a] = this.size(u.elem);
        r = [s * u.len, a];
        break;
      }
      case "struct": {
        let off = 0;
        let al = 1;
        for (const f of u.fields) {
          const [s, a] = this.size(f.type);
          off = Math.ceil(off / a) * a + s;
          al = Math.max(al, a);
        }
        // A struct ending in a zero-size field gets one byte of padding.
        if (u.fields.length > 0 && this.size(u.fields[u.fields.length - 1]!.type)[0] === 0 && off > 0)
          off += 1;
        r = [Math.ceil(off / al) * al, al];
        break;
      }
      default:
        r = [8, 8];
    }
    this.sizes[id] = r;
    return r;
  }

  /** Whether values of the type contain pointers (growslice's noscan = !ptrs). */
  ptrs(id: number): boolean {
    const c = this.ptrsC[id];
    if (c !== undefined) return c;
    const u = this.info[id]!.u;
    let r: boolean;
    switch (u.k) {
      case "bool":
      case "int":
      case "float":
        r = false;
        break;
      case "array":
        r = u.len > 0 && this.ptrs(u.elem);
        break;
      case "struct":
        r = u.fields.some((f) => this.ptrs(f.type));
        break;
      default:
        r = true;
    }
    this.ptrsC[id] = r;
    return r;
  }

  /** Equality for values of a type, or null if the type is not comparable. */
  eq(id: number): ((a: any, b: any) => boolean) | null {
    const c = this.eqC[id];
    if (c !== undefined) return c;
    this.eqC[id] = null; // recursion guard
    const ti = this.info[id]!;
    let r: ((a: any, b: any) => boolean) | null;
    switch (ti.k) {
      case "bool":
      case "int":
      case "string":
        r = (a, b) => a === b;
        break;
      case "float":
        r =
          ti.fbits === 32
            ? (a, b) => bitsToF32(a) === bitsToF32(b)
            : (a, b) => bitsToF64(a) === bitsToF64(b);
        break;
      case "pointer":
        r = (a: Ptr | null, b: Ptr | null) =>
          a === b || (a !== null && b !== null && a.o === b.o && a.i === b.i);
        break;
      case "chan":
      case "opaque":
        r = (a, b) =>
          a === b ||
          (a instanceof Ptr && b instanceof Ptr && a.o === b.o && a.i === b.i);
        break;
      case "interface":
        r = (a, b) => this.ifaceEq(a, b);
        break;
      case "struct":
      case "array": {
        const st = this.slotTypes(id).map((s) => this.eq(s));
        if (st.some((f) => f === null)) r = null;
        else {
          const fs = st as ((a: any, b: any) => boolean)[];
          r = (a: any[], b: any[]) => {
            for (let i = 0; i < fs.length; i++) if (!fs[i]!(a[i], b[i])) return false;
            return true;
          };
        }
        break;
      }
      default:
        r = null;
    }
    this.eqC[id] = r;
    return r;
  }

  ifaceEq(a: Iface | null, b: Iface | null): boolean {
    if (a === null || b === null) return a === b;
    if (a.t !== b.t) return false;
    const e = this.eq(a.t);
    if (e === null) throw rtError("comparing uncomparable type " + this.name(a.t));
    return e(a.v, b.v);
  }

  /** Map-key canonicaliser: a primitive (or identity object) per key value. */
  key(id: number): (a: any) => any {
    const c = this.keyC[id];
    if (c) return c;
    const ti = this.info[id]!;
    let r: (a: any) => any;
    switch (ti.k) {
      case "bool":
      case "int":
      case "string":
        r = (a) => a;
        break;
      case "float":
        r =
          ti.fbits === 32
            ? (a) => floatKey(bitsToF32(a))
            : (a) => floatKey(bitsToF64(a));
        break;
      case "chan":
        r = (a) => a;
        break;
      case "pointer":
      case "opaque":
        r = (a) => (a === null ? null : objKey(a));
        break;
      case "interface":
        r = (a: Iface | null) => {
          if (a === null) return null;
          if (this.eq(a.t) === null) throw rtError("hash of unhashable type " + this.name(a.t));
          const k = this.key(a.t)(a.v);
          return typeof k === "string" ? a.t + "#s" + k : a.t + "#" + keyStr(k);
        };
        break;
      case "struct":
      case "array": {
        const ks = this.slotTypes(id).map((s) => this.key(s));
        r = (a: any[]) => {
          let s = "";
          for (let i = 0; i < ks.length; i++) {
            const k = ks[i]!(a[i]);
            s += typeof k === "string" ? k.length + "'" + k : keyStr(k) + ",";
          }
          return s;
        };
        break;
      }
      default:
        r = () => {
          throw rtError("hash of unhashable type " + this.name(id));
        };
    }
    this.keyC[id] = r;
    return r;
  }

  /** Method table of a dynamic type (named T, or *T for named T). */
  methods(t: number): Record<string, number> {
    const c = this.methodsC[t];
    if (c) return c;
    const ty = this.prog.types[t]!;
    let r: Record<string, number> = {};
    if (ty.k === "named") r = ty.methods;
    else if (ty.k === "pointer") {
      const e = this.prog.types[ty.elem]!;
      if (e.k === "named") r = e.ptrMethods;
    }
    this.methodsC[t] = r;
    return r;
  }

  /** Whether dynamic type t implements interface type iface; returns missing method or null. */
  missing(t: number, iface: number): string | null {
    const it = this.info[iface]!.u as any;
    const ms = it.methods as string[];
    const sigs = it.sigs as number[] | undefined;
    const tab = this.methods(t);
    const T = this.prog.types;
    for (let i = 0; i < ms.length; i++) {
      const fid = tab[ms[i]!];
      if (fid === undefined) return ms[i]!;
      if (!sigs) continue;
      const want = T[sigs[i]!] as any;
      const have = T[this.prog.funcs[fid]!.sig] as any;
      if (
        have.variadic !== want.variadic ||
        have.params.length !== want.params.length + 1 ||
        have.results.length !== want.results.length ||
        want.params.some((p: number, j: number) => have.params[j + 1] !== p) ||
        want.results.some((p: number, j: number) => have.results[j] !== p)
      )
        return ms[i]!;
    }
    return null;
  }

  implements(t: number, iface: number): boolean {
    const k = t * 1048576 + iface;
    let r = this.implC.get(k);
    if (r === undefined) {
      r = this.missing(t, iface) === null;
      this.implC.set(k, r);
    }
    return r;
  }
}

let nanCount = 0;
function floatKey(f: number): any {
  if (f !== f) return "NaN#" + nanCount++;
  return f === 0 ? 0 : f;
}

/** Object identities for pointer keys (assigned on first use). */
const objIds = new WeakMap<object, number>();
let nextObjKey = 1;
export function objKey(p: Ptr | Func | Chan | GoMap | Obj | any): string {
  if (p instanceof Ptr) return objIdent(p.o) + ":" + p.i;
  return "o" + objIdent(p);
}
function objIdent(o: object): number {
  let id = objIds.get(o);
  if (id === undefined) {
    id = nextObjKey++;
    objIds.set(o, id);
  }
  return id;
}
function keyStr(k: any): string {
  if (k === null) return "nil";
  if (typeof k === "object") return objKey(k);
  return typeof k + String(k);
}
