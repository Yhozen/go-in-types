// Intrinsics: functions whose body the runtime provides, by name. Mirrors
// frontend/intrinsics.go (the specification). Every intrinsic call costs
// 1 op (the call instruction) and nothing more.
import type { DFunc, Machine } from "./interp.ts";
import { bytesToString } from "./interp.ts";
import { GoMap } from "./gomap.ts";
import {
  add64s,
  add64u,
  and64,
  Exit,
  Iface,
  norm,
  or64,
  Ptr,
  roundupsize,
  Slice,
  Trap,
  utf8Bytes,
} from "./values.ts";

export type Intrinsic = (m: Machine, a: any[], d: DFunc) => any;

const bytes = (s: Slice | null): string => (s === null ? "" : bytesToString(s.o, s.i, s.len));
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const count = (s: string, c: number) => {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === c) n++;
  return n;
};
const noop: Intrinsic = () => undefined;
const ret =
  (v: any): Intrinsic =>
  () =>
    v;
const fatal: Intrinsic = (_m, a) => {
  throw new Exit(2, `fatal error: ${a[0]}\n\ngoroutine 1 [running]:\n`);
};
const exit: Intrinsic = (_m, a) => {
  throw new Exit(Number(a[0]));
};

const ptrEq = (a: any, b: any) =>
  a === b || (a instanceof Ptr && b instanceof Ptr && a.o === b.o && a.i === b.i);

export const intrinsics: Record<string, Intrinsic> = {
  "internal/bytealg.Compare": (_m, a) => cmp(bytes(a[0]), bytes(a[1])),
  "internal/bytealg.Count": (_m, a) => count(bytes(a[0]), a[1]),
  "internal/bytealg.CountString": (_m, a) => count(a[0], a[1]),
  "internal/bytealg.Equal": (_m, a) => bytes(a[0]) === bytes(a[1]),
  "internal/bytealg.Index": (_m, a) => bytes(a[0]).indexOf(bytes(a[1])),
  "internal/bytealg.IndexString": (_m, a) => (a[0] as string).indexOf(a[1]),
  "internal/bytealg.IndexByte": (_m, a) => bytes(a[0]).indexOf(String.fromCharCode(a[1])),
  "internal/bytealg.IndexByteString": (_m, a) =>
    (a[0] as string).indexOf(String.fromCharCode(a[1])),
  "internal/bytealg.MakeNoZero": (_m, a) => {
    const n = Number(a[0]);
    const cap = roundupsize(n, true);
    return new Slice(new Array(cap).fill(0), 0, n, cap);
  },
  "internal/bytealg.abigen_runtime_cmpstring": (_m, a) => cmp(a[0], a[1]),
  "internal/bytealg.abigen_runtime_memequal": () => {
    throw new Trap("runtime.memequal");
  },
  "internal/bytealg.abigen_runtime_memequal_varlen": () => {
    throw new Trap("runtime.memequal_varlen");
  },

  "sync/atomic.runtime_procPin": ret(0),
  "sync/atomic.runtime_procUnpin": noop,
  "sync/atomic.CompareAndSwapPointer": (_m, [p, o, n]) => {
    if (p === null) throw nilPtr();
    if (!ptrEq(p.o[p.i], o)) return false;
    p.o[p.i] = n;
    return true;
  },
  "sync/atomic.LoadPointer": (_m, [p]) => load(p),
  "sync/atomic.StorePointer": (_m, [p, v]) => store(p, v),
  "sync/atomic.SwapPointer": (_m, [p, v]) => {
    const o = load(p);
    p.o[p.i] = v;
    return o;
  },

  "strings.(*Builder).String": (m, [b]) => {
    if (b === null) throw nilPtr();
    const s = b.o[b.i + 1] as Slice | null;
    void m;
    return bytes(s);
  },
  "internal/abi.NoEscape": (_m, a) => a[0],
  "slices.overlaps": (m, [a, b], d) => {
    if (a === null || b === null || a.len === 0 || b.len === 0) return false;
    if (a.o !== b.o) return false;
    const st = m.types.info[m.prog.funcs[d.id]!.regTypes[0]!]!.u as any;
    const es = m.types.info[st.elem]!.slots || 1;
    return a.i < b.i + b.len * es && b.i < a.i + a.len * es;
  },

  "runtime.KeepAlive": noop,
  "runtime.SetFinalizer": noop,
  "runtime.GC": noop,
  "runtime.Gosched": noop,
  "runtime.GOMAXPROCS": ret(1),
  "runtime.NumCPU": ret(1),
  "runtime.NumGoroutine": ret(1),
  "time.runtimeNano": ret(0),
  "time.runtimeNow": () => [0, 0, 0],
  "time.runtimeIsBubbled": ret(false),
  "os.runtime_beforeExit": noop,
  "syscall.Exit": exit,
  "maps.clone": (_m, [x]) => {
    if (x === null) return null;
    const src = (x as Iface).v as GoMap | null;
    if (src === null) return x;
    const c = new GoMap(src.t, src.keyOf);
    for (const e of src.es) if (e.alive) c.set(e.k, e.v);
    return new Iface((x as Iface).t, c);
  },
  "os.runtime_args": (m) => {
    const a = m.args.map(utf8Bytes);
    return new Slice(a, 0, a.length, a.length);
  },
  "syscall.runtime_envs": ret(null),
  "internal/godebug.setUpdate": noop,
  "internal/godebug.setNewIncNonDefault": noop,
  "internal/godebug.registerMetric": noop,
  "internal/chacha8rand.block": () => {
    throw new Trap("internal/chacha8rand.block not implemented");
  },
  "sync.runtime_canSpin": ret(false),
  "sync.runtime_doSpin": noop,
  "sync.runtime_nanotime": ret(0),
  "sync.runtime_notifyListCheck": noop,
  "sync.runtime_registerPoolCleanup": noop,
  "sync.runtime_procPin": ret(0),
  "sync.runtime_procUnpin": noop,
  "sync.throw": fatal,
  "sync.fatal": fatal,
  "internal/sync.throw": fatal,
  "internal/sync.fatal": fatal,

  "gointypes/rt.Write": (m, [fd, b]) => {
    m.write(Number(fd), bytes(b));
  },
  "gointypes/rt.Exit": exit,
  noop,
};

function nilPtr() {
  return new Trap("nil pointer in atomic operation");
}
function load(p: Ptr | null) {
  if (p === null) throw nilPtr();
  return p.o[p.i];
}
function store(p: Ptr | null, v: any) {
  if (p === null) throw nilPtr();
  p.o[p.i] = v;
}

// sync/atomic integer families.
for (const [suffix, kind] of [
  ["Int32", "int32"],
  ["Uint32", "uint32"],
  ["Int64", "int64"],
  ["Uint64", "uint64"],
  ["Uintptr", "uint64"],
] as const) {
  const w64 = kind.endsWith("64");
  const signed = kind[0] === "i";
  const add = w64
    ? signed
      ? add64s
      : add64u
    : (
        (n) => (a: any, b: any) =>
          n(a + b)
      )(norm(kind));
  const and = w64
    ? and64(signed)
    : (
        (n) => (a: any, b: any) =>
          n(a & b)
      )(norm(kind));
  const or = w64
    ? or64(signed)
    : (
        (n) => (a: any, b: any) =>
          n(a | b)
      )(norm(kind));
  const P = "sync/atomic.";
  intrinsics[P + "Add" + suffix] = (_m, [p, d]) => {
    const v = add(load(p), d);
    p.o[p.i] = v;
    return v;
  };
  intrinsics[P + "And" + suffix] = (_m, [p, x]) => {
    const o = load(p);
    p.o[p.i] = and(o, x);
    return o;
  };
  intrinsics[P + "Or" + suffix] = (_m, [p, x]) => {
    const o = load(p);
    p.o[p.i] = or(o, x);
    return o;
  };
  intrinsics[P + "CompareAndSwap" + suffix] = (_m, [p, o, n]) => {
    if (load(p) !== o) return false;
    p.o[p.i] = n;
    return true;
  };
  intrinsics[P + "Load" + suffix] = (_m, [p]) => load(p);
  intrinsics[P + "Store" + suffix] = (_m, [p, v]) => store(p, v);
  intrinsics[P + "Swap" + suffix] = (_m, [p, v]) => {
    const o = load(p);
    p.o[p.i] = v;
    return o;
  };
}
