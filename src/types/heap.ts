// The type-level memory model (docs/DESIGN.md "Type level", candidate A of
// docs/stage0/HEAP.md): heap, objects, pointers, slices, interfaces, func
// values. Rules H1-H5 of HEAP.md apply to every alias here and to callers.
//
// ## Encodings (the "Type-level encodings" contract for heap values)
//
// Ints are the stage 4 int encoding (nibble strings, src/types/nat.ts for
// the non-negative arithmetic used here). Slot indices, lengths and
// capacities are ints in that encoding.
//
// - **Heap** `[Next, Root]` (built by `HeapMk`): Root is a 16-wide trie of
//   tuples of depth W (= `IdWidth`, 5 by default, heap.gen.ts), Next the id
//   the next allocation gets. Only ever passed as an alias argument (H2).
// - **Object id** `Id`: W lowercase hex digits, most significant first
//   ("0002a"). Id "00000" is the zero-size object (Go's runtime.zerobase:
//   zero-size allocations and zero-size globals point at it). Conversion to
//   an int (e.g. for map keys): reverse the digits and add a sign nibble
//   (`IdInt`); ints never convert back to ids.
// - **Object**, one of:
//   - flat (static size <= 16 slots): a 16-tuple of its slots, padded with
//     `undefined` past the object's size (built by `Mk16`, so a flat object
//     is a trie node and shares its setter);
//   - lazy (more than 16 slots, and every slice backing array): a 19-tuple
//     `[c0..c15, D, N, Z]`: D = depth "1".."6", N = slot count (int), Z = the
//     zero pattern (tuple of P slot values; slot s's zero is Z[s mod P]).
//     Children c0..c15 are subtrees of depth D-1 (at depth 1, slots); slot s
//     lives at the D hex digits of s, most significant first. A slot never
//     written is `undefined` and reads as the zero value of the static type
//     the reader passes (memory is typed), so allocation is O(depth) at any
//     size. Growing a slice whose backing is lazy, starts at slot 0 and has
//     exactly cap*es slots reuses the old tree (appends never copy it).
//   An object's kind is its tuple length (16 or 19).
// - **Slot values**: bool `true`/`false`; ints and floats nibble strings;
//   string a string literal of bytes; nil `null`; pointer `[Id, Slot]`;
//   slice `[Id, Off, Len, Cap]` (elements at slot Off + k*es); interface
//   `[T, V]` (T = dynamic TypeId as an int, V its value in register form);
//   func `[F, Env]` (F = FuncId as an int, Env = tuple of the free-variable
//   values in register form, `[]` for none: closures are immutable, so the
//   environment is a value, not an object, and makeClosure allocates
//   nothing); map: owned by src/types/map.ts (stage4-strmap), an object on
//   this heap; chan: not implemented in stage 4 (tsgo runs
//   --singleThreaded and makes no channels).
// - **Registers**: scalars as above; struct/array values are flat tuples of
//   their slots (a struct field at offset o of k slots is elements o..o+k-1).
// - **Globals**: one object each, allocated first, in `Program.globals`
//   order: global g has id 1 + (number of non-zero-size globals before it),
//   or "00000" when zero-size; its address is `[id, "0"]`. The snapshot
//   format numbers globals first in the same order, so the codec keeps this.
// - **Panics** are `Panic<K, M>` (K "e": runtime.errorString, "p":
//   runtime.plainError; M: message parts, string literals and `[int]`
//   1-tuples the caller formats in decimal), detected with `IsPanic`.
//   Checks that can panic are separate aliases returning `true` or a Panic
//   (`NilCk`, `IndexCk`, `MakeSliceCk`); ops that return a heap never panic,
//   so the heap is never a conditional's check type (H2).
// - **Program tables** (H1: one non-generic interface per program, passed
//   as the `P` argument): `P["impl"]`: keys `${T}:${I}` present when dynamic
//   type T implements interface I; `P["names"]`: T -> Go type string;
//   `P["missing"]`: `${T}:${I}` -> first missing method (unqualified) for
//   pairs that fail; `P["eqk"]`: T -> equality kind of T (see `Eq`) or
//   "unc" when uncomparable. Members are named interfaces, never inline
//   object literals.
//
// Every multi-result op returns a tuple read by indexed access (`R["0"]`),
// never by a pattern: `Append` gives `[Heap, Slice]`.
//
// The emitter supplies static facts: element slots `Es`, zero slots `Z` /
// `Ze` (tuples of slot values, emitted once per type as top-level
// aliases), element byte size and noscan for append, the equality kind for
// `Eq`, field offsets. Index operands are signed ints; an unsigned index of
// a narrower type is zero-extended first (`ZExt` in nat.ts).
//
// Costs (stock tsrs, instantiations, flat from 0 to 100k live objects;
// scripts/cost-heap.ts): Load1 76, Store1 446, Alloc 377, pass-on 11, lazy
// slot read 114 / write 644, append in place 934, makeSlice 487, copy of 4
// slots 1511; `LoadK`/`StoreK` of 1000 slots of a lazy object ~10k / ~70k
// (linear: whole subtrees and leaves at once). Limits: the heap holds 16^W
// objects; a lazy object 16^6 slots; loops restart every 256 steps outside
// tail position (depth limit: ~25k steps per op); a bulk store of more than
// 4096 slots goes slot by slot (quadratic).
import type {
  Ch,
  E0,
  EChild,
  EDepth,
  ERoot,
  Id0,
  IncId,
  IncD,
  DecNib,
  IxS,
  SetS,
  LPath,
  Mk16,
  Mk19,
  NibDec,
  DInc,
  NodeOfRoot,
  RootOfNode,
  SetC,
  SetR,
  TGet,
  TPut,
} from "./heap.gen.ts";
import type { Add, Dec, Digits16, GrowCap, Inc, IsNeg, Le, Lt, Min, Mul, Sub } from "./nat.ts";

export type { IdWidth } from "./heap.gen.ts";

// ------------------------------------------------------------ constructors

/** 2-tuple constructor (pointers, interfaces, funcs, op results). */
export type Mk2<A, B> = A extends unknown ? [A, B] : never;
/** 4-tuple constructor (slice headers). */
export type Mk4<A, B, C, D> = A extends unknown ? [A, B, C, D] : never;
/** Push one element onto a value tuple. */
type Push<T, V> = T extends unknown[] ? [...T, V] : never;

// ------------------------------------------------------------ panics

/** A Go runtime panic: K "e" runtime.errorString, "p" runtime.plainError; M message parts. */
export interface Panic<K, M> {
  "!panic": K;
  m: M;
}
interface PanicAny {
  "!panic": unknown;
}
export type IsPanic<R> = [R] extends [PanicAny] ? true : false;
type NilDeref = Panic<"e", ["invalid memory address or nil pointer dereference"]>;

// ------------------------------------------------------------ heap

/** The heap box. */
export type HeapMk<Nx, R> = Nx extends unknown ? [Nx, R] : never;
type RootOf<H> = H["1" & keyof H];
type NextOf<H> = H["0" & keyof H];

/** The zero-size object (also an empty flat object). */
export type ZeroObj = Mk16<E0, E0, E0, E0, E0, E0, E0, E0, E0, E0, E0, E0, E0, E0, E0, E0>;
/** An empty heap: only the zero-size object, at "00000". */
export type HeapEmpty = HeapMk<IncId<Id0>, TPut<ERoot, Id0, ZeroObj>>;

/** The id the next allocation returns. */
export type NextId<H> = NextOf<H>;
/** Object Id of heap H. */
export type GetObj<H, Id> = TGet<RootOf<H>, Id>;
/** H with object Id replaced by O. */
export type PutObj<H, Id, O> = HeapMk<NextOf<H>, TPut<RootOf<H>, Id, O>>;
/** H with O stored at NextId<H>, Next bumped. */
export type AllocObj<H, O> = HeapMk<IncId<NextOf<H>>, TPut<RootOf<H>, NextOf<H>, O>>;

/**
 * Allocate a flat object: Z is the zero object (a 16-tuple from `Flat`,
 * emitted once per type as a top-level alias). Its id is `NextId<H>`.
 */
export type Alloc<H, Z> = AllocObj<H, Z>;
/** Allocate a lazy object of N slots (int) with zero pattern Z (tuple). Its id is `NextId<H>`. */
export type AllocLazy<H, N extends string, Z> = AllocObj<H, NewLazy<N, Z>>;

/** A flat object (16-tuple) from up to 16 slot values (for zero objects and boot images). */
export type Flat<
  A0 = E0,
  A1 = E0,
  A2 = E0,
  A3 = E0,
  A4 = E0,
  A5 = E0,
  A6 = E0,
  A7 = E0,
  A8 = E0,
  A9 = E0,
  A10 = E0,
  A11 = E0,
  A12 = E0,
  A13 = E0,
  A14 = E0,
  A15 = E0,
> = Mk16<A0, A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15>;

/** A lazy object of N slots, all zero. */
export type NewLazy<N extends string, Z> =
  LazyDepth<N> extends infer D extends keyof EChild ? LazyRoot<EChild[D], D, N, Z> : never;
type LazyDepth<N extends string> = N extends "0" ? "1" : Digits16<Dec<N>>;
type LazyRoot<C, D, N, Z> = Mk19<C, C, C, C, C, C, C, C, C, C, C, C, C, C, C, C, D, N, Z>;

// ------------------------------------------------------------ objects

type IsLazy<O> = O["length" & keyof O] extends 19 ? true : false;
type LGet<N, P> = P extends `${infer d}${infer R}` ? LGet<Ch<N, d>, R> : N;
type LSetN<N, P, V> = P extends `${infer d}${infer R}` ? SetC<N, d, LSetN<Ch<N, d>, R, V>> : V;
type LSet<O, P, V> = P extends `${infer d}${infer R}` ? SetR<O, d, LSetN<Ch<O, d>, R, V>> : never;

/** Slot S (int) of object O (`undefined` when never written in a lazy object). */
export type OGet<O, S extends string> = O["length" & keyof O] extends 19
  ? LGet<O, LPath<S, O["16" & keyof O]>>
  : O[IxS[S & keyof IxS] & keyof O];
/** O with slot S set to V. */
export type OSet<O, S extends string, V> = O["length" & keyof O] extends 19
  ? LSet<O, LPath<S, O["16" & keyof O]>, V>
  : SetS<O, S, V>;
/** V, or the zero Z when V is an unwritten slot. */
type Dflt<V, Z> = [V] extends [undefined] ? Z : V;

// ------------------------------------------------------------ pointers

/** A pointer value. */
export type PtrMk<Id, S> = Mk2<Id, S>;
/** `true`, or the nil-dereference panic. */
export type NilCk<P> = P extends null ? NilDeref : true;
/** Address of the field at slot offset Off (int) of *P (P non-nil). */
export type FieldAddr<P, Off extends string> = PtrMk<
  P["0" & keyof P],
  Add<P["1" & keyof P] & string, Off>
>;

/** *P for a 1-slot type with zero value Z0 (P non-nil). */
export type Load1<H, P, Z0> = Load1O<GetObj<H, P["0" & keyof P]>, P["1" & keyof P] & string, Z0>;
type Load1O<O, S extends string, Z0> = O["length" & keyof O] extends 19
  ? Dflt<LGet<O, LPath<S, O["16" & keyof O]>>, Z0>
  : O[IxS[S & keyof IxS] & keyof O];
/** *P for an aggregate type with zero slots Z (a tuple; result has as many slots). */
export type LoadK<H, P, Z> = LoadKO<GetObj<H, P["0" & keyof P]>, P["1" & keyof P] & string, Z>;
type LoadKI<O, S extends string, Z, Acc, F extends 0[] = []> = Z extends [infer z, ...infer ZR]
  ? F["length"] extends Fuel
    ? Restart<LoadKI<O, S, Z, Acc>>
    : LoadKI<O, Inc<S>, ZR, Push<Acc, Dflt<OGet<O, S>, z>>, [...F, 0]>
  : Acc;
/** *P = V for a 1-slot type (P non-nil). */
export type Store1<H, P, V> = StoreAt<H, P["0" & keyof P], P["1" & keyof P] & string, V>;
type StoreAt<H, Id, S extends string, V> = PutObj<H, Id, OSet<GetObj<H, Id>, S, V>>;
/** *P = V for an aggregate (V a tuple of its slots). */
export type StoreK<H, P, V> = StoreKAt<H, P["0" & keyof P], P["1" & keyof P] & string, V>;
type StoreKAt<H, Id, S extends string, V> = PutObj<H, Id, StoreKO<GetObj<H, Id>, S, V>>;
type StoreKI<O, S extends string, V, F extends 0[] = []> = V extends [infer x, ...infer R]
  ? F["length"] extends Fuel
    ? Restart<StoreKI<O, S, V>>
    : StoreKI<OSet<O, S, x>, Inc<S>, R, [...F, 0]>
  : O;

// Bulk loads and stores of big aggregates in lazy objects. A load reads
// the slot range as whole subtrees (`ReadAll` concatenates 16 children at
// once) and fills unwritten slots from Z in one mapped pass; a store writes
// whole 16-slot leaves where aligned, reading V by index (never peeling it:
// a rest pattern on an n-tuple costs O(n) per step). 1000 slots: load
// ~10k instantiations (was 1.1M at top level, 4.1M inside a segment), store
// ~70k (was 1.9M).
type Cat3<A extends unknown[], B extends unknown[], C extends unknown[]> = [...A, ...B, ...C];
type Cat16<
  A0 extends unknown[],
  A1 extends unknown[],
  A2 extends unknown[],
  A3 extends unknown[],
  A4 extends unknown[],
  A5 extends unknown[],
  A6 extends unknown[],
  A7 extends unknown[],
  A8 extends unknown[],
  A9 extends unknown[],
  A10 extends unknown[],
  A11 extends unknown[],
  A12 extends unknown[],
  A13 extends unknown[],
  A14 extends unknown[],
  A15 extends unknown[],
> = [
  ...A0,
  ...A1,
  ...A2,
  ...A3,
  ...A4,
  ...A5,
  ...A6,
  ...A7,
  ...A8,
  ...A9,
  ...A10,
  ...A11,
  ...A12,
  ...A13,
  ...A14,
  ...A15,
];
type Fs<S> = S extends `${string}${infer R}` ? `f${Fs<R>}` : "";
type Zs<S> = S extends `${string}${infer R}` ? `0${Zs<R>}` : "";
/** The slots of the subtree N whose paths have the length of P, in order. */
type ReadAll<N, P> = P extends `${string}${infer R}`
  ? R extends ""
    ? N["length" & keyof N] extends 16
      ? N
      : NodeOfRoot<N>
    : Cat16<
        ReadAll<N["0" & keyof N], R>,
        ReadAll<N["1" & keyof N], R>,
        ReadAll<N["2" & keyof N], R>,
        ReadAll<N["3" & keyof N], R>,
        ReadAll<N["4" & keyof N], R>,
        ReadAll<N["5" & keyof N], R>,
        ReadAll<N["6" & keyof N], R>,
        ReadAll<N["7" & keyof N], R>,
        ReadAll<N["8" & keyof N], R>,
        ReadAll<N["9" & keyof N], R>,
        ReadAll<N["10" & keyof N], R>,
        ReadAll<N["11" & keyof N], R>,
        ReadAll<N["12" & keyof N], R>,
        ReadAll<N["13" & keyof N], R>,
        ReadAll<N["14" & keyof N], R>,
        ReadAll<N["15" & keyof N], R>
      >
  : [];
type Has<M, d extends string> = M extends `${string}${d}${string}` ? true : false;
type Between<
  a extends string,
  b extends string,
> = "0123456789abcdef" extends `${string}${a}${infer M}${b}${string}` ? M : "";
type Mid<N, M, R> = Cat16<
  Has<M, "0"> extends true ? ReadAll<N["0" & keyof N], R> : [],
  Has<M, "1"> extends true ? ReadAll<N["1" & keyof N], R> : [],
  Has<M, "2"> extends true ? ReadAll<N["2" & keyof N], R> : [],
  Has<M, "3"> extends true ? ReadAll<N["3" & keyof N], R> : [],
  Has<M, "4"> extends true ? ReadAll<N["4" & keyof N], R> : [],
  Has<M, "5"> extends true ? ReadAll<N["5" & keyof N], R> : [],
  Has<M, "6"> extends true ? ReadAll<N["6" & keyof N], R> : [],
  Has<M, "7"> extends true ? ReadAll<N["7" & keyof N], R> : [],
  Has<M, "8"> extends true ? ReadAll<N["8" & keyof N], R> : [],
  Has<M, "9"> extends true ? ReadAll<N["9" & keyof N], R> : [],
  Has<M, "a"> extends true ? ReadAll<N["10" & keyof N], R> : [],
  Has<M, "b"> extends true ? ReadAll<N["11" & keyof N], R> : [],
  Has<M, "c"> extends true ? ReadAll<N["12" & keyof N], R> : [],
  Has<M, "d"> extends true ? ReadAll<N["13" & keyof N], R> : [],
  Has<M, "e"> extends true ? ReadAll<N["14" & keyof N], R> : [],
  Has<M, "f"> extends true ? ReadAll<N["15" & keyof N], R> : []
>;
/** The slots Lp..Hp (paths of equal length, MSB first) of subtree N. */
type RangeR<N, Lp, Hp> =
  Lp extends Zs<Lp> ? (Hp extends Fs<Hp> ? ReadAll<N, Lp> : RangeP<N, Lp, Hp>) : RangeP<N, Lp, Hp>;
type RangeP<N, Lp, Hp> = Lp extends `${infer a}${infer LR}`
  ? Hp extends `${infer b}${infer HR}`
    ? LR extends ""
      ? SliceL<N, a, b, []>
      : a extends b
        ? RangeR<Ch<N, a>, LR, HR>
        : Cat3<
            RangeR<Ch<N, a>, LR, Fs<LR>>,
            Mid<N, Between<a, b>, LR>,
            RangeR<Ch<N, b>, Zs<HR>, HR>
          >
    : never
  : never;
type SliceL<N, a, b, Acc> = a extends b
  ? Push<Acc, Ch<N, a>>
  : SliceL<N, IncD[a & keyof IncD], b, Push<Acc, Ch<N, a>>>;
type MapDflt<R, Z> = {
  [K in keyof R]: [R[K]] extends [undefined] ? (K extends keyof Z ? Z[K] : never) : R[K];
};
type FixZ<R, Z> = undefined extends R[number & keyof R] ? MapDflt<R, Z> : R;
type LoadKO<O, S extends string, Z> = O["length" & keyof O] extends 19
  ? Z["length" & keyof Z] extends Small
    ? LoadKI<O, S, Z, []>
    : LoadL<O, O["16" & keyof O], S, Add<S, Dec<TLen<Z>>>, Z>
  : LoadKI<O, S, Z, []>;
/** Aggregates up to this many slots go slot by slot (cheaper than the bulk paths). */
type Small =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20
  | 21
  | 22
  | 23
  | 24
  | 25
  | 26
  | 27
  | 28
  | 29
  | 30
  | 31;
/** A tuple's length as an int. */
type TLen<T> = `${T["length" & keyof T] & number}` extends infer L extends string
  ? string extends DecNib[L & keyof DecNib]
    ? DecInt<L, "0">
    : DecNib[L & keyof DecNib]
  : never;
type DecInt<S, Acc extends string> = S extends `${infer d extends keyof DecDig}${infer R}`
  ? DecInt<R, Add<Mul<Acc, "a0">, DecDig[d]>>
  : Acc;
interface DecDig {
  "0": "0";
  "1": "1";
  "2": "2";
  "3": "3";
  "4": "4";
  "5": "5";
  "6": "6";
  "7": "7";
  "8": "80";
  "9": "90";
}
type LoadL<O, D, S extends string, E extends string, Z> = FixZ<
  RangeR<O, LPath<S, D>, LPath<E, D>>,
  Z
>;

type StoreKO<O, S extends string, V> = O["length" & keyof O] extends 19
  ? V["length" & keyof V] extends Small
    ? StoreKI<O, S, V>
    : O["16" & keyof O] extends "1"
      ? StoreKI<O, S, V>
      : StoreL<O, O["16" & keyof O], S, V>
  : StoreKI<O, S, V>;
type StoreL<O, D, S extends string, V> =
  TLen<V> extends infer N extends string
    ? Le<N, "0001"> extends true
      ? StoreLI<O, D, S, V, "0", N>
      : StoreKI<O, S, V>
    : never;
/** Slots S.. := V[J..], N slots left (ints); leaf by leaf where aligned. */
type StoreLI<
  O,
  D,
  S extends string,
  V,
  J extends string,
  N extends string,
  F extends 0[] = [],
> = N extends "0"
  ? O
  : F["length"] extends Fuel
    ? Restart<StoreLI<O, D, S, V, J, N>>
    : S extends "0" | `0${string}`
      ? Lt<"f", N> extends true
        ? StoreLI<
            LSetLeaf<O, LPath<S, D>, Leaf16V<V, J, []>>,
            D,
            Add<S, "01">,
            V,
            Add<J, "01">,
            Sub<N, "01">,
            [...F, 0]
          >
        : StoreLI<LSet<O, LPath<S, D>, VAt<V, J>>, D, Inc<S>, V, Inc<J>, Dec<N>, [...F, 0]>
      : StoreLI<LSet<O, LPath<S, D>, VAt<V, J>>, D, Inc<S>, V, Inc<J>, Dec<N>, [...F, 0]>;
/** V[J] for an int J (H3 lookup). */
type VAt<V, J extends string> = NibDec[J] extends infer K
  ? K extends keyof V
    ? V[K]
    : never
  : never;
type Leaf16V<V, J extends string, Acc extends unknown[]> = Acc["length"] extends 16
  ? Acc
  : Leaf16V<V, Inc<J>, [...Acc, VAt<V, J>]>;
/** O (a lazy root of depth >= 2) with the leaf holding path P replaced by L. */
type LSetLeaf<O, P, L> = P extends `${infer d}${infer R}`
  ? SetR<O, d, LSetLeafN<Ch<O, d>, R, L>>
  : never;
type LSetLeafN<N, P, L> = P extends `${infer d}${infer R}`
  ? R extends ""
    ? L
    : SetC<N, d, LSetLeafN<Ch<N, d>, R, L>>
  : never;

// Loops: a chain of tail calls is capped at ~1000 steps, so every loop
// counts Fuel steps and then restarts outside tail position (one level of
// instantiation depth per Fuel steps: ~25k steps per call).
type Fuel = 256;
type Restart<X> = X extends infer Y ? Y : never;

/** Equality of two pointers (or chan values): identity. */
export type PtrEq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** An object id as an int (digits reversed plus a sign nibble), e.g. for map keys. */
export type IdInt<Id extends string> = CanonRev<Id, "">;
type CanonRev<S extends string, O extends string> = S extends `${infer H}${infer R}`
  ? CanonRev<R, `${H}${O}`>
  : TrimU<O>;
type TrimU<S extends string> = S extends `${infer H}0`
  ? TrimU<H>
  : S extends ""
    ? "0"
    : S extends `${string}${"8" | "9" | "a" | "b" | "c" | "d" | "e" | "f"}`
      ? `${S}0`
      : S;

// ------------------------------------------------------------ indexes

/** `true`, or Go's index-out-of-range panic (I a signed int, Len >= 0). */
export type IndexCk<I extends string, Len extends string> =
  IsNeg<I> extends true
    ? Panic<"e", ["index out of range [", [I], "]"]>
    : Lt<I, Len> extends true
      ? true
      : Panic<"e", ["index out of range [", [I], "] with length ", [Len]]>;

/** &s[i] (after IndexCk<I, Len<S>>); Es = element slots. */
export type SliceIndexAddr<S, I extends string, Es extends string> = PtrMk<
  S["0" & keyof S],
  Add<S["1" & keyof S] & string, Mul<I, Es>>
>;
/** &p[i] for p a pointer to an array (after NilCk and IndexCk with the array length). */
export type ArrayIndexAddr<P, I extends string, Es extends string> = PtrMk<
  P["0" & keyof P],
  Add<P["1" & keyof P] & string, Mul<I, Es>>
>;
/** a[i] on an array register value (after IndexCk); one slot. */
export type AggIndex1<A, I extends string> = A[NibDec[I] & keyof A];
/** a[i] on an array register value for elements of Es > 1 slots (Z: element zero, gives the count). */
export type AggIndexK<A, I extends string, Es extends string, Z> = AggSlots<A, Mul<I, Es>, Z, []>;
type AggSlots<A, S extends string, Z, Acc, F extends 0[] = []> = Z extends [unknown, ...infer ZR]
  ? F["length"] extends Fuel
    ? Restart<AggSlots<A, S, Z, Acc>>
    : AggSlots<A, Inc<S>, ZR, Push<Acc, A[NibDec[S] & keyof A]>, [...F, 0]>
  : Acc;

// ------------------------------------------------------------ slices

/** A slice header. */
export type SliceMk<Id, Off, Len, Cap> = Mk4<Id, Off, Len, Cap>;
export type Len<S> = S extends null ? "0" : S["2" & keyof S];
export type Cap<S> = S extends null ? "0" : S["3" & keyof S];

/** `true` or the makeslice panic (Len, Cap signed ints). */
export type MakeSliceCk<L extends string, C extends string> =
  IsNeg<L> extends true
    ? Panic<"e", ["makeslice: len out of range"]>
    : Lt<N2p40, L> extends true
      ? Panic<"e", ["makeslice: len out of range"]>
      : IsNeg<C> extends true
        ? Panic<"e", ["makeslice: cap out of range"]>
        : Lt<C, L> extends true
          ? Panic<"e", ["makeslice: cap out of range"]>
          : Lt<N2p40, C> extends true
            ? Panic<"e", ["makeslice: cap out of range"]>
            : true;
/** 2^40 */
type N2p40 = "00000000001";

/** The heap after make([]T, len, cap): a lazy backing of Cap*Es slots with element zero Ze. */
export type MakeSlice<H, C extends string, Es extends string, Ze> = AllocLazy<H, Mul<C, Es>, Ze>;
/** The slice make([]T, len, cap) gives, read from the heap before MakeSlice. */
export type MakeSliceV<H, L, C> = SliceMk<NextOf<H>, "0", L, C>;

/**
 * s[lo:hi] / s[lo:hi:max] of a slice value (absent bounds `null`): the
 * new header, `null` for a nil slice, or a Panic. Es: element slots.
 */
export type SliceS<S, Lo, Hi, Max, Es extends string> = S extends null
  ? SliceB<null, "0", "0", "0", Lo, Hi, Max, Es, "capacity">
  : SliceB<
      S,
      S["1" & keyof S] & string,
      S["2" & keyof S] & string,
      S["3" & keyof S] & string,
      Lo,
      Hi,
      Max,
      Es,
      "capacity"
    >;
/** p[lo:hi:max] of a pointer to an array of ALen elements: a header or a Panic. */
export type SliceA<P, Lo, Hi, Max, Es extends string, ALen extends string> = P extends null
  ? NilDeref
  : SliceB<P, P["1" & keyof P] & string, ALen, ALen, Lo, Hi, Max, Es, "length">;
type SliceB<
  V,
  Base extends string,
  L extends string,
  C extends string,
  Lo,
  Hi,
  Max,
  Es extends string,
  What extends string,
> = Max extends string
  ? Slice3<V, Base, C, Lo extends string ? Lo : "0", Hi extends string ? Hi : L, Max, Es, What>
  : Slice2<V, Base, C, Lo extends string ? Lo : "0", Hi extends string ? Hi : L, Es, What>;
type BoundsP<M> = Panic<"e", M>;
type Slice2<
  V,
  Base extends string,
  C extends string,
  l extends string,
  h extends string,
  Es extends string,
  What extends string,
> =
  IsNeg<h> extends true
    ? BoundsP<["slice bounds out of range [:", [h], "]"]>
    : Lt<C, h> extends true
      ? BoundsP<["slice bounds out of range [:", [h], `] with ${What} `, [C]]>
      : IsNeg<l> extends true
        ? BoundsP<["slice bounds out of range [", [l], ":]"]>
        : Lt<h, l> extends true
          ? BoundsP<["slice bounds out of range [", [l], ":", [h], "]"]>
          : V extends null
            ? null
            : SliceMk<V["0" & keyof V], Add<Base, Mul<l, Es>>, Sub<h, l>, Sub<C, l>>;
type Slice3<
  V,
  Base extends string,
  C extends string,
  l extends string,
  h extends string,
  k extends string,
  Es extends string,
  What extends string,
> =
  IsNeg<k> extends true
    ? BoundsP<["slice bounds out of range [::", [k], "]"]>
    : Lt<C, k> extends true
      ? BoundsP<["slice bounds out of range [::", [k], `] with ${What} `, [C]]>
      : IsNeg<h> extends true
        ? BoundsP<["slice bounds out of range [:", [h], ":]"]>
        : Lt<k, h> extends true
          ? BoundsP<["slice bounds out of range [:", [h], ":", [k], "]"]>
          : IsNeg<l> extends true
            ? BoundsP<["slice bounds out of range [", [l], "::]"]>
            : Lt<h, l> extends true
              ? BoundsP<["slice bounds out of range [", [l], ":", [h], ":]"]>
              : V extends null
                ? null
                : SliceMk<V["0" & keyof V], Add<Base, Mul<l, Es>>, Sub<h, l>, Sub<k, l>>;

// ---- slot copies (copy, append): Src is ["h", Id, Off] (heap slots) or ["v", Slots] (a register tuple)

/** Copy Cnt slots from Src to object Dst at DstOff; memmove semantics. Ze: element zero (unwritten slots). */
type CopyIn<H, DstId, DstOff extends string, Src, Cnt extends string, Ze> = Cnt extends "0"
  ? H
  : Src extends ["h", infer SId, infer SOff extends string]
    ? CopyBulk<GetObj<H, DstId>, GetObj<H, SId>, Cnt> extends true
      ? PutObj<H, DstId, CopyRaw<GetObj<H, DstId>, GetObj<H, SId>, SOff, DstOff, Cnt>>
      : CopyInH<H, DstId, DstOff, SId, SOff, Cnt, Ze>
    : Src extends ["v", infer T]
      ? PutObj<H, DstId, StoreKO<GetObj<H, DstId>, DstOff, T>>
      : never;
/** Whether a heap copy goes in bulk: both objects lazy, 32 slots or more. */
type CopyBulk<O, Src, Cnt extends string> = O["length" & keyof O] extends 19
  ? Src["length" & keyof Src] extends 19
    ? Le<"02", Cnt>
    : false
  : false;
/**
 * Bulk copy: the source range read raw (unwritten slots stay unwritten:
 * memory is typed, so both objects share the zero pattern), then stored;
 * reading first makes it a memmove.
 */
type CopyRaw<O, Src, SOff extends string, DOff extends string, Cnt extends string> = StoreKO<
  O,
  DOff,
  RangeR<Src, LPath<SOff, Src["16" & keyof Src]>, LPath<Add<SOff, Dec<Cnt>>, Src["16" & keyof Src]>>
>;
type CopyInH<H, DstId, DstOff extends string, SId, SOff extends string, Cnt extends string, Ze> = [
  SId,
] extends [DstId]
  ? Lt<SOff, DstOff> extends true
    ? PutObj<
        H,
        DstId,
        CopyBack<
          GetObj<H, DstId>,
          Add<SOff, Dec<Cnt>>,
          Add<DstOff, Dec<Cnt>>,
          Cnt,
          RevT<Ze>,
          RevT<Ze>
        >
      >
    : PutObj<H, DstId, CopySame<GetObj<H, DstId>, SOff, DstOff, Cnt, Ze, Ze>>
  : PutObj<H, DstId, CopyOther<GetObj<H, DstId>, GetObj<H, SId>, SOff, DstOff, Cnt, Ze, Ze>>;
type RevT<T, O extends unknown[] = []> = T extends [infer x, ...infer R] ? RevT<R, [x, ...O]> : O;

type CopySame<
  O,
  S extends string,
  D extends string,
  N extends string,
  Zc,
  Ze,
  F extends 0[] = [],
> = N extends "0"
  ? O
  : F["length"] extends Fuel
    ? Restart<CopySame<O, S, D, N, Zc, Ze>>
    : Zc extends [infer z, ...infer ZR]
      ? CopySame<OSet<O, D, Dflt<OGet<O, S>, z>>, Inc<S>, Inc<D>, Dec<N>, ZR, Ze, [...F, 0]>
      : CopySame<O, S, D, N, Ze, Ze, F>;
type CopyOther<
  O,
  Src,
  S extends string,
  D extends string,
  N extends string,
  Zc,
  Ze,
  F extends 0[] = [],
> = N extends "0"
  ? O
  : F["length"] extends Fuel
    ? Restart<CopyOther<O, Src, S, D, N, Zc, Ze>>
    : Zc extends [infer z, ...infer ZR]
      ? CopyOther<OSet<O, D, Dflt<OGet<Src, S>, z>>, Src, Inc<S>, Inc<D>, Dec<N>, ZR, Ze, [...F, 0]>
      : CopyOther<O, Src, S, D, N, Ze, Ze, F>;
/** Backward (source below destination in the same object); S, D start at the last slot; Zc/Ze reversed. */
type CopyBack<
  O,
  S extends string,
  D extends string,
  N extends string,
  Zc,
  Ze,
  F extends 0[] = [],
> = N extends "0"
  ? O
  : F["length"] extends Fuel
    ? Restart<CopyBack<O, S, D, N, Zc, Ze>>
    : Zc extends [infer z, ...infer ZR]
      ? CopyBack<OSet<O, D, Dflt<OGet<O, S>, z>>, DecZ<S>, DecZ<D>, Dec<N>, ZR, Ze, [...F, 0]>
      : CopyBack<O, S, D, N, Ze, Ze, F>;
type DecZ<S extends string> = S extends "0" ? "0" : Dec<S>;
/** The count copy(dst, src) returns. */
export type CopyN<Dst, Src> = Min<Len<Dst> & string, Len<Src> & string>;
/** The heap after copy(dst, src) of slices; Es element slots, Ze element zero. */
export type Copy<H, Dst, Src, Es extends string, Ze> =
  CopyN<Dst, Src> extends infer N extends string
    ? N extends "0"
      ? H
      : CopyIn<H, Dst["0" & keyof Dst], Dst["1" & keyof Dst] & string, Mk3H<Src>, Mul<N, Es>, Ze>
    : never;
/** The heap after copy(dst, vals) from a register tuple of slots (e.g. a string's bytes); N elements copied (= CopyN). */
export type CopyVals_<H, Dst, Vals, Ze> = Dst extends null
  ? H
  : CopyIn<H, Dst["0" & keyof Dst], Dst["1" & keyof Dst] & string, Mk2<"v", Vals>, "1", Ze>;
type Mk3H<S> = S extends null ? never : ["h", S["0" & keyof S], S["1" & keyof S]];

/**
 * append(s, src...) for a slice src: `[Heap, Slice]`. Es element slots, Ze
 * element zero, Size element bytes (int), Noscan: the element has no
 * pointers (growslice's size class rounding).
 */
export type Append<
  H,
  S,
  Src,
  Es extends string,
  Ze,
  Size extends string,
  Noscan extends boolean,
> = Src extends null
  ? Mk2<H, S>
  : AppendA<H, S, Len<Src> & string, Mk3H<Src>, Es, Ze, Size, Noscan>;
/** append(s, vals...) with the appended elements as a register tuple of N elements' slots (N an int). */
export type AppendVals<
  H,
  S,
  Vals,
  N extends string,
  Es extends string,
  Ze,
  Size extends string,
  Noscan extends boolean,
> = AppendA<H, S, N, Mk2<"v", Vals>, Es, Ze, Size, Noscan>;
type AppendA<
  H,
  S,
  N extends string,
  Src,
  Es extends string,
  Ze,
  Size extends string,
  Noscan extends boolean,
> = N extends "0"
  ? Mk2<H, S>
  : AppendB<
      H,
      S,
      Len<S> & string,
      Cap<S> & string,
      Add<Len<S> & string, N>,
      N,
      Src,
      Es,
      Ze,
      Size,
      Noscan
    >;
type AppendB<
  H,
  S,
  L extends string,
  C extends string,
  NL extends string,
  N extends string,
  Src,
  Es extends string,
  Ze,
  Size extends string,
  Noscan extends boolean,
> =
  Le<NL, C> extends true
    ? Mk2<
        CopyIn<
          H,
          S["0" & keyof S],
          Add<S["1" & keyof S] & string, Mul<L, Es>>,
          Src,
          Mul<N, Es>,
          Ze
        >,
        SliceMk<S["0" & keyof S], S["1" & keyof S], NL, C>
      >
    : AppendG<H, NextOf<H>, S, L, C, NL, N, Src, GrowCap<NL, C, Size, Noscan>, Es, Ze>;
type AppendG<
  H,
  Nid,
  S,
  L extends string,
  C extends string,
  NL extends string,
  N extends string,
  Src,
  NC extends string,
  Es extends string,
  Ze,
> = Mk2<
  CopyIn<
    Grown<H, S, Mul<C, Es>, Mul<NC, Es>, Mul<L, Es>, Ze>,
    Nid,
    Mul<L, Es>,
    Src,
    Mul<N, Es>,
    Ze
  >,
  SliceMk<Nid, "0", NL, NC>
>;
/** The heap with the new backing array of NN slots allocated, holding the old elements. */
type Grown<H, S, CS extends string, NN extends string, LS extends string, Ze> = S extends null
  ? AllocLazy<H, NN, Ze>
  : S["1" & keyof S] extends "0"
    ? GrownO<H, S, GetObj<H, S["0" & keyof S]>, CS, NN, LS, Ze>
    : GrownCopy<H, S, NN, LS, Ze>;
type GrownO<H, S, O, CS extends string, NN extends string, LS extends string, Ze> =
  IsLazy<O> extends true
    ? [O["17" & keyof O]] extends [CS]
      ? AllocObj<H, Regrow<O, NN, Ze>>
      : GrownCopy<H, S, NN, LS, Ze>
    : GrownCopy<H, S, NN, LS, Ze>;
type GrownCopy<H, S, NN extends string, LS extends string, Ze> = CopyIn<
  AllocLazy<H, NN, Ze>,
  NextOf<H>,
  "0",
  Mk3H<S>,
  LS,
  Ze
>;
/** A lazy object's tree in a lazy root of NN slots (deeper when needed). */
type Regrow<O, NN extends string, Ze> =
  LazyDepth<NN> extends infer D2 ? Deepen<NodeOfRoot<O>, O["16" & keyof O], D2, NN, Ze> : never;
type Deepen<C, D, D2, NN, Ze> = [D] extends [D2]
  ? RootOfNode<C, D, NN, Ze>
  : D extends keyof EDepth
    ? D extends keyof DInc
      ? Deepen<
          Mk16<
            C,
            EDepth[D],
            EDepth[D],
            EDepth[D],
            EDepth[D],
            EDepth[D],
            EDepth[D],
            EDepth[D],
            EDepth[D],
            EDepth[D],
            EDepth[D],
            EDepth[D],
            EDepth[D],
            EDepth[D],
            EDepth[D],
            EDepth[D]
          >,
          DInc[D],
          D2,
          NN,
          Ze
        >
      : never
    : never;

// ------------------------------------------------------------ interfaces

/** An interface value of dynamic type T (int) holding V. */
export type MakeIface<T, V> = Mk2<T, V>;

/** x.(T) for a concrete T: the value, or the plainError panic. St: x's static type; P: program tables. */
export type AssertT<X, T, St, P> = X extends null
  ? Panic<"p", [`interface conversion: interface is nil, not ${Name<P, T>}`]>
  : [X["0" & keyof X]] extends [T]
    ? X["1" & keyof X]
    : Panic<
        "p",
        [`interface conversion: ${Name<P, St>} is ${Name<P, X["0" & keyof X]>}, not ${Name<P, T>}`]
      >;
/** v, ok := x.(T) for a concrete T with zero value Z: `[v, ok]`. */
export type AssertTOk<X, T, Z> = X extends null
  ? Mk2<Z, false>
  : [X["0" & keyof X]] extends [T]
    ? Mk2<X["1" & keyof X], true>
    : Mk2<Z, false>;
/** x.(I) for an interface I: x itself, or the plainError panic. */
export type AssertI<X, I, P> = X extends null
  ? Panic<"p", [`interface conversion: interface is nil, not ${Name<P, I>}`]>
  : Implements<X["0" & keyof X], I, P> extends true
    ? X
    : Panic<
        "p",
        [
          `interface conversion: ${Name<P, X["0" & keyof X]>} is not ${Name<P, I>}: missing method ${Missing<P, X["0" & keyof X], I>}`,
        ]
      >;
/** v, ok := x.(I): `[x, true]` or `[nil, false]`. */
export type AssertIOk<X, I, P> = X extends null
  ? Mk2<null, false>
  : Implements<X["0" & keyof X], I, P> extends true
    ? Mk2<X, true>
    : Mk2<null, false>;
/** Whether dynamic type T implements interface I (program table lookup, H3 form). */
export type Implements<T, I, P> = `${T & string}:${I & string}` extends keyof Tab<P, "impl">
  ? true
  : false;
type Tab<P, K extends string> = K extends keyof P ? P[K] : never;
type Look<T, K> = K extends keyof T ? T[K] : never;
type Name<P, T> = Look<Tab<P, "names">, T> & string;
type Missing<P, T, I> = Look<Tab<P, "missing">, `${T & string}:${I & string}`> & string;

// ------------------------------------------------------------ equality

/**
 * a == b. K is the equality kind of the static type: "=" (identity: bool,
 * ints, strings, pointers, chans, nil checks), "f32" / "f64" (float rules
 * of DESIGN.md), "i" (interface: dynamic types, then the dynamic type's
 * kind from P["eqk"]), or a tuple of kinds, one per slot (structs and
 * arrays; compared in order, stopping at the first difference as Go does).
 * Returns true, false, or the "comparing uncomparable type" panic.
 */
export type Eq<A, B, K, P> = K extends "="
  ? Same<A, B>
  : K extends "f64"
    ? F64Eq<A & string, B & string>
    : K extends "f32"
      ? F32Eq<A & string, B & string>
      : K extends "i"
        ? IfaceEq<A, B, P>
        : EqAgg<A, B, K, P>;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type EqAgg<A, B, K, P> = K extends [infer k, ...infer KR]
  ? A extends [infer a, ...infer AR]
    ? B extends [infer b, ...infer BR]
      ? Eq<a, b, k, P> extends infer r
        ? r extends true
          ? EqAgg<AR, BR, KR, P>
          : r
        : never
      : never
    : never
  : true;
type IfaceEq<A, B, P> = A extends null
  ? B extends null
    ? true
    : false
  : B extends null
    ? false
    : [A["0" & keyof A]] extends [B["0" & keyof B]]
      ? Look<Tab<P, "eqk">, A["0" & keyof A]> extends infer k
        ? k extends "unc"
          ? Panic<"e", [`comparing uncomparable type ${Name<P, A["0" & keyof A]>}`]>
          : Eq<A["1" & keyof A], B["1" & keyof B], k, P>
        : never
      : false;

// floats are bit patterns sign-extended to 64 bits (canonical ints)
type F64Eq<A extends string, B extends string> = A extends B
  ? IsNaN64<A> extends true
    ? false
    : true
  : A extends Zero64
    ? B extends Zero64
      ? true
      : false
    : false;
type Zero64 = "0" | "0000000000000008";
type F32Eq<A extends string, B extends string> = A extends B
  ? IsNaN32<A> extends true
    ? false
    : true
  : A extends Zero32
    ? B extends Zero32
      ? true
      : false
    : false;
type Zero32 = "0" | "00000008";
type Ext<S extends string> = S extends `${string}${"8" | "9" | "a" | "b" | "c" | "d" | "e" | "f"}`
  ? "ffffffffffffffff"
  : "0000000000000000";
type Exp64<S extends string> =
  `${S}${Ext<S>}` extends `${infer m0}${infer m1}${infer m2}${infer m3}${infer m4}${infer m5}${infer m6}${infer m7}${infer m8}${infer m9}${infer m10}${infer m11}${infer m12}${infer e13}${infer e14}${infer s15}${string}`
    ? [`${m0}${m1}${m2}${m3}${m4}${m5}${m6}${m7}${m8}${m9}${m10}${m11}${m12}`, e13, e14, s15]
    : never;
type IsNaN64<S extends string> =
  Exp64<S> extends [infer m, "f", "f", "7" | "f"]
    ? m extends "0000000000000"
      ? false
      : true
    : false;
type Exp32<S extends string> =
  `${S}${Ext<S>}` extends `${infer m0}${infer m1}${infer m2}${infer m3}${infer m4}${infer n5}${infer n6}${infer n7}${string}`
    ? [`${m0}${m1}${m2}${m3}${m4}`, n5, n6, n7]
    : never;
type IsNaN32<S extends string> =
  Exp32<S> extends [
    infer m,
    infer n5 extends "8" | "9" | "a" | "b" | "c" | "d" | "e" | "f",
    "f",
    "7" | "f",
  ]
    ? m extends "00000"
      ? n5 extends "8"
        ? false
        : true
      : true
    : false;

// ------------------------------------------------------------ func values

/** A closure: function F (int) with free-variable values Env (tuple). */
export type MakeClosure<F, Env> = Mk2<F, Env>;
/** A func value with no free variables. */
export type FuncVal<F> = Mk2<F, []>;
export type FuncOf<V> = V["0" & keyof V];
export type EnvOf<V> = V["1" & keyof V];
export type { Add } from "./nat.ts";
