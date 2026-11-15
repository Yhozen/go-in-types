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
import type {
  Ch,
  E0,
  EChild,
  EDepth,
  ERoot,
  Id0,
  IncId,
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

type First<S> = S extends `${infer c}${string}` ? c : never;
type IsLazy<O> = O["length" & keyof O] extends 19 ? true : false;
type LGet<N, P> = P extends `${infer d}${infer R}` ? LGet<Ch<N, d>, R> : N;
type LSetN<N, P, V> = P extends `${infer d}${infer R}` ? SetC<N, d, LSetN<Ch<N, d>, R, V>> : V;
type LSet<O, P, V> = P extends `${infer d}${infer R}` ? SetR<O, d, LSetN<Ch<O, d>, R, V>> : never;

/** Slot S (int) of object O (`undefined` when never written in a lazy object). */
export type OGet<O, S extends string> =
  IsLazy<O> extends true ? LGet<O, LPath<S, O["16" & keyof O]>> : Ch<O, First<S>>;
/** O with slot S set to V. */
export type OSet<O, S extends string, V> =
  IsLazy<O> extends true ? LSet<O, LPath<S, O["16" & keyof O]>, V> : SetC<O, First<S>, V>;
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
export type Load1<H, P, Z0> = Dflt<
  OGet<GetObj<H, P["0" & keyof P]>, P["1" & keyof P] & string>,
  Z0
>;
/** *P for an aggregate type with zero slots Z (a tuple; result has as many slots). */
export type LoadK<H, P, Z> = LoadKI<GetObj<H, P["0" & keyof P]>, P["1" & keyof P] & string, Z, []>;
type LoadKI<O, S extends string, Z, Acc> = Z extends [infer z, ...infer ZR]
  ? LoadKI<O, Inc<S>, ZR, Push<Acc, Dflt<OGet<O, S>, z>>>
  : Acc;
/** *P = V for a 1-slot type (P non-nil). */
export type Store1<H, P, V> = StoreAt<H, P["0" & keyof P], P["1" & keyof P] & string, V>;
type StoreAt<H, Id, S extends string, V> = PutObj<H, Id, OSet<GetObj<H, Id>, S, V>>;
/** *P = V for an aggregate (V a tuple of its slots). */
export type StoreK<H, P, V> = StoreKAt<H, P["0" & keyof P], P["1" & keyof P] & string, V>;
type StoreKAt<H, Id, S extends string, V> = PutObj<H, Id, StoreKI<GetObj<H, Id>, S, V>>;
type StoreKI<O, S extends string, V> = V extends [infer x, ...infer R]
  ? StoreKI<OSet<O, S, x>, Inc<S>, R>
  : O;

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
type AggSlots<A, S extends string, Z, Acc> = Z extends [unknown, ...infer ZR]
  ? AggSlots<A, Inc<S>, ZR, Push<Acc, A[NibDec[S] & keyof A]>>
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
    ? [SId] extends [DstId]
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
      : PutObj<H, DstId, CopyOther<GetObj<H, DstId>, GetObj<H, SId>, SOff, DstOff, Cnt, Ze, Ze>>
    : Src extends ["v", infer T]
      ? PutObj<H, DstId, CopyVals<GetObj<H, DstId>, T, DstOff, Ze, Ze>>
      : never;
type RevT<T, O extends unknown[] = []> = T extends [infer x, ...infer R] ? RevT<R, [x, ...O]> : O;

// Each loop runs at most 256 steps per chain (tail-call limit ~1000), then
// an outer loop restarts it: copies of up to ~250k slots.
type Fuel256 = 256;
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
  : F["length"] extends Fuel256
    ? CopySame<O, S, D, N, Zc, Ze>
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
  : F["length"] extends Fuel256
    ? CopyOther<O, Src, S, D, N, Zc, Ze>
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
  : F["length"] extends Fuel256
    ? CopyBack<O, S, D, N, Zc, Ze>
    : Zc extends [infer z, ...infer ZR]
      ? CopyBack<OSet<O, D, Dflt<OGet<O, S>, z>>, DecZ<S>, DecZ<D>, Dec<N>, ZR, Ze, [...F, 0]>
      : CopyBack<O, S, D, N, Ze, Ze, F>;
type DecZ<S extends string> = S extends "0" ? "0" : Dec<S>;
type CopyVals<O, T, D extends string, Zc, Ze, F extends 0[] = []> = T extends [infer x, ...infer R]
  ? F["length"] extends Fuel256
    ? CopyVals<O, T, D, Zc, Ze>
    : Zc extends [infer z, ...infer ZR]
      ? CopyVals<OSet<O, D, Dflt<x, z>>, R, Inc<D>, ZR, Ze, [...F, 0]>
      : CopyVals<O, T, D, Ze, Ze, F>
  : O;

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
