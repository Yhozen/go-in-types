// Go maps in types (tsrs): insertion-ordered, the iteration semantics of
// src/ref/gomap.ts. See docs/DESIGN.md "Type-level encodings".
//
// ## Encoding
//
// A map value is `null` (nil) or the id of its heap object (src/types/heap.ts);
// the object is the map state
//
//   [Len, Seq, Mode, Idx, D, Root]          (built by Mk6)
//
// - Len: the number of entries (int). Seq: the sequence number the next new
//   key gets (int; counts every insertion since makemap, never reset).
// - Mode: how a key's canonical string C becomes its index path: "i" for
//   integer keys (C's four low nibbles), "s" for all others (`Hash<C>`,
//   src/types/hash-spec.ts: 16 bits as four nibbles).
// - Idx: a 16-wide trie of depth 4 on the path, first nibble at the root;
//   leaves are buckets. A bucket is a chain of entries `[C, K, V, Seq, Next]`
//   (Mk5) in insertion order; Next is the next entry or undefined.
// - D, Root: the order trie, depth D ("1".."6"), keyed by an entry's Seq (its
//   D low nibbles, most significant first); leaves hold `${path}${C}` (the
//   entry's index path, so `next` finds it without hashing).
// - Empty subtrees, buckets and order leaves are `undefined`, and a node
//   whose children are all undefined is itself undefined, so the state is a
//   function of the reference map's contents (the codec's bijection).
//
// Keys are canonicalised by the emitter (`Key*` below): C is the key itself
// for strings, integers and bools, `${id}.${slot}` for pointers, and a join
// of the fields' forms for structs and arrays (strings length-prefixed).
// Float and interface keys trap (DESIGN.md).
//
// ## Iteration
//
// An iterator is the sequence number T to look at next (initially "0").
// `MsNext` returns the live entry with the least Seq >= T, so entries
// deleted before they are reached are skipped, keys inserted during the
// loop are seen (their Seq is larger), and a key deleted and re-inserted
// comes again: exactly src/ref/gomap.ts's MapIter.
//
// ## Rules
//
// H1: every tuple here is built by a constructor alias (Mk*, trie nodes by
// map-tables.gen.ts's Mk16). H2: map states and their parts are conditional
// check types only where they are small (entries, nodes, never the heap);
// the heap is only an alias argument. H3: tables are read by literal keys.
import type * as K from "./str-tables.gen.ts";
import type * as T from "./map-tables.gen.ts";
import type { AllocObj, GetObj, NextId, Panic, PutObj } from "./heap.ts";
import type { Len, NDec, NInc, NLt, NTrim } from "./str.ts";

// ---------------------------------------------------------------- constructors

type Mk2<A, B> = A extends unknown ? [A, B] : never;
type Mk4<A, B, C, D> = A extends unknown ? [A, B, C, D] : never;
type Mk5<A, B, C, D, E> = A extends unknown ? [A, B, C, D, E] : never;
type Mk6<A, B, C, D, E, F> = A extends unknown ? [A, B, C, D, E, F] : never;

/** Constructors for map states written as text (src/types/codec-map.ts). */
export type MapMk6<A, B, C, D, E, F> = Mk6<A, B, C, D, E, F>;
export type MapMk5<A, B, C, D, E> = Mk5<A, B, C, D, E>;
export type MapMk16<A0, A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15> = T.Mk16<
  A0,
  A1,
  A2,
  A3,
  A4,
  A5,
  A6,
  A7,
  A8,
  A9,
  A10,
  A11,
  A12,
  A13,
  A14,
  A15
>;

type F0<X> = X["0" & keyof X];
type F1<X> = X["1" & keyof X];
type F2<X> = X["2" & keyof X];
type F3<X> = X["3" & keyof X];
type F4<X> = X["4" & keyof X];
type F5<X> = X["5" & keyof X];

// ---------------------------------------------------------------- key hash

/** The 16-bit hash of a byte string as four nibbles (src/types/hash-spec.ts strHash). Memoized per string. */
export type Hash<S extends string> = HashD<S, "0000">;
type HashD<
  S extends string,
  St extends string,
> = St extends `${infer a}${infer b}${infer c}${infer d}`
  ? HashL<S, a, b, c, d, "900"> extends infer X
    ? X extends [1, infer S2 extends string, infer St2 extends string]
      ? HashD<S2, St2>
      : X
    : never
  : never;
/** One Feistel round per byte, at most F bytes per call ([1, rest, state] when out of fuel). */
type HashL<
  S extends string,
  A extends string,
  B extends string,
  C extends string,
  D extends string,
  F extends string,
> = F extends "0"
  ? [1, S, `${A}${B}${C}${D}`]
  : S extends `${infer x}${infer R}`
    ? HashL<
        R,
        T.HX[`${C}${T.HVH[`${B}${T.HU[`${A}${x}`]}`]}`],
        T.HX[`${D}${T.HVL[`${B}${T.HU[`${A}${x}`]}`]}`],
        A,
        B,
        K.FUEL[F]
      >
    : `${A}${B}${C}${D}`;

/** The index path of canonical key C. */
export type KeyPath<Mode, C extends string> = Mode extends "i"
  ? `${C}0000` extends `${infer a}${infer b}${infer c}${infer d}${string}`
    ? `${a}${b}${c}${d}`
    : never
  : Hash<C>;

// ---------------------------------------------------------------- canonical keys

/** A string key inside a struct or array key: length-prefixed. */
export type KeyStr<S extends string> = `${Len<S>}:${S}`;
/** A bool key. */
export type KeyBool<B> = B extends true ? "t" : "f";
/** A pointer key ([Id, Slot] or null). */
export type KeyPtr<P> = P extends null ? "nil" : `${F0<P> & string}.${F1<P> & string}`;

// ---------------------------------------------------------------- tries

/** Child D of node N (undefined for an empty node). */
type Ch<N, D> = N extends undefined ? undefined : N[T.IX[D & keyof T.IX] & keyof N];
/** The leaf at path P (nibbles, root first). */
type TGetP<N, P extends string> = P extends `${infer d}${infer R}` ? TGetP<Ch<N, d>, R> : N;
/** N with the leaf at path P set to V (V undefined: removed, emptied nodes collapse). */
type TPutP<N, P extends string, V> = P extends `${infer d}${infer R}`
  ? SetCC<N, d, TPutP<Ch<N, d>, R, V>>
  : V;
type SetCC<N, D, V> = V extends undefined ? Collapse<T.SetC<N, D, undefined>> : T.SetC<N, D, V>;
type Collapse<N> = N extends T.E16 ? undefined : N;

// ---------------------------------------------------------------- buckets

/** The entry for C in bucket B, or undefined. */
type BGet<B, C> = B extends undefined ? undefined : F0<B> extends C ? B : BGet<F4<B>, C>;
/** B (which holds C) with C's value replaced. */
type BRepl<B, C, V> =
  F0<B> extends C
    ? Mk5<F0<B>, F1<B>, V, F3<B>, F4<B>>
    : Mk5<F0<B>, F1<B>, F2<B>, F3<B>, BRepl<F4<B>, C, V>>;
/** B with entry E appended. */
type BApp<B, E> = B extends undefined ? E : Mk5<F0<B>, F1<B>, F2<B>, F3<B>, BApp<F4<B>, E>>;
/** B (which holds C) without C. */
type BDel<B, C> = F0<B> extends C ? F4<B> : Mk5<F0<B>, F1<B>, F2<B>, F3<B>, BDel<F4<B>, C>>;

// ---------------------------------------------------------------- order trie

/** Seq's D low nibbles, most significant first (Seq < 16^6). */
type SeqPath<
  D,
  Seq extends string,
> = `${Seq}000000` extends `${infer n0}${infer n1}${infer n2}${infer n3}${infer n4}${infer n5}${string}`
  ? D extends "1"
    ? n0
    : D extends "2"
      ? `${n1}${n0}`
      : D extends "3"
        ? `${n2}${n1}${n0}`
        : D extends "4"
          ? `${n3}${n2}${n1}${n0}`
          : D extends "5"
            ? `${n4}${n3}${n2}${n1}${n0}`
            : `${n5}${n4}${n3}${n2}${n1}${n0}`
  : never;
/** Does Seq need more than D nibbles? */
type NeedsGrow<
  D,
  Seq extends string,
> = `${Seq}0000000` extends `${infer _0}${infer n1}${infer n2}${infer n3}${infer n4}${infer n5}${infer n6}${string}`
  ? (
      D extends "1"
        ? n1
        : D extends "2"
          ? n2
          : D extends "3"
            ? n3
            : D extends "4"
              ? n4
              : D extends "5"
                ? n5
                : n6
    ) extends "0"
    ? false
    : true
  : never;
interface DINC {
  "1": "2";
  "2": "3";
  "3": "4";
  "4": "5";
  "5": "6";
  "6": "7";
}
type Rev<S extends string, O extends string = ""> = S extends `${infer a}${infer R}`
  ? Rev<R, `${a}${O}`>
  : O;

/** The least present child index of N from nibble d on, or false. */
type FirstFrom<N, d> = d extends "g"
  ? false
  : Ch<N, d> extends undefined
    ? FirstFrom<N, T.NEXTN[d & keyof T.NEXTN]>
    : d;
/** The path of the least leaf in N (R: the remaining depth, as a string of that length). */
type MinPath<N, R extends string> = R extends `${string}${infer RR}`
  ? FirstFrom<N, "0"> extends infer j extends string
    ? `${j}${MinPath<Ch<N, j>, RR>}`
    : never
  : "";
/** The path of the least leaf of N at or after path P, or false. */
type Succ<N, P extends string> = N extends undefined
  ? false
  : P extends `${infer d}${infer R}`
    ? R extends ""
      ? FirstFrom<N, d>
      : SuccIn<N, d, R, Succ<Ch<N, d>, R>>
    : false;
type SuccIn<N, d extends string, R extends string, X> = X extends string
  ? `${d}${X}`
  : FirstFrom<N, T.NEXTN[d & keyof T.NEXTN]> extends infer j extends string
    ? `${j}${MinPath<Ch<N, j>, R>}`
    : false;

// ---------------------------------------------------------------- map states

/** An empty map state; Mode "i" for integer keys, "s" otherwise. */
export type MsEmpty<Mode> = Mk6<"0", "0", Mode, undefined, "1", undefined>;

/** `len(m)`. */
export type MsLen<MS> = F0<MS>;

/** The entry [C, K, V, Seq, Next] for canonical key C, or undefined. */
export type MsGet<MS, C extends string> =
  KeyPath<F2<MS>, C> extends infer P extends string ? BGet<TGetP<F3<MS>, P>, C> : never;

/** `m[k]`: the value for C, or Z (the value type's zero). */
export type MsLookup<MS, C extends string, Z> =
  MsGet<MS, C> extends infer E ? (E extends undefined ? Z : F2<E>) : never;

/** `v, ok := m[k]`: [value, true] or [Z, false]. */
export type MsLookupOk<MS, C extends string, Z> =
  MsGet<MS, C> extends infer E ? (E extends undefined ? Mk2<Z, false> : Mk2<F2<E>, true>) : never;

/** `m[k] = v` (C canonical, K the key value). */
export type MsSet<MS, C extends string, Key, V> =
  KeyPath<F2<MS>, C> extends infer P extends string ? MsSetP<MS, C, Key, V, P> : never;
type MsSetP<MS, C extends string, Key, V, P extends string> = MsSetB<
  MS,
  C,
  Key,
  V,
  P,
  TGetP<F3<MS>, P>
>;
type MsSetB<MS, C extends string, Key, V, P extends string, B> =
  BGet<B, C> extends undefined
    ? MsIns<MS, P, BApp<B, Mk5<C, Key, V, F1<MS>, undefined>>, C, F1<MS> & string, F4<MS>>
    : Mk6<F0<MS>, F1<MS>, F2<MS>, TPutP<F3<MS>, P, BRepl<B, C, V>>, F4<MS>, F5<MS>>;
/** Insert a new entry: bucket B2 at path P, C at sequence number Seq in the order trie. */
type MsIns<MS, P extends string, B2, C extends string, Seq extends string, D> =
  NeedsGrow<D, Seq> extends true
    ? MsInsD<
        MS,
        P,
        B2,
        C,
        Seq,
        DINC[D & keyof DINC],
        F5<MS> extends undefined ? undefined : T.SetC<undefined, "0", F5<MS>>
      >
    : MsInsD<MS, P, B2, C, Seq, D, F5<MS>>;
type MsInsD<MS, P extends string, B2, C extends string, Seq extends string, D, Root> = Mk6<
  NInc<F0<MS> & string>,
  NInc<Seq>,
  F2<MS>,
  TPutP<F3<MS>, P, B2>,
  D,
  TPutP<Root, SeqPath<D, Seq>, `${P}${C}`>
>;

/** `delete(m, k)`. */
export type MsDel<MS, C extends string> =
  KeyPath<F2<MS>, C> extends infer P extends string ? MsDelP<MS, C, P> : never;
type MsDelP<MS, C extends string, P extends string> = MsDelB<MS, C, P, TGetP<F3<MS>, P>>;
type MsDelB<MS, C extends string, P extends string, B> =
  BGet<B, C> extends infer E
    ? E extends undefined
      ? MS
      : Mk6<
          NDec<F0<MS> & string>,
          F1<MS>,
          F2<MS>,
          TPutP<F3<MS>, P, BDel<B, C>>,
          F4<MS>,
          TPutP<F5<MS>, SeqPath<F4<MS>, F3<E> & string>, undefined>
        >
    : never;

/** `clear(m)`. */
export type MsClear<MS> = Mk6<"0", F1<MS>, F2<MS>, undefined, F4<MS>, undefined>;

/**
 * One `next` of a map iterator at sequence number It: `[true, K, V, It2]`
 * for the next live entry, or `[false, ZK, ZV, It]` at the end. The emitter
 * keeps It2 as the iterator's state (the first It is "0").
 */
export type MsNext<MS, It extends string, ZK, ZV> =
  NLt<It, F1<MS> & string> extends true
    ? F5<MS> extends undefined
      ? Mk4<false, ZK, ZV, It>
      : MsNextAt4<MS, It, ZK, ZV, SeqPath<F4<MS>, It>>
    : Mk4<false, ZK, ZV, It>;
type MsNextAt4<MS, It extends string, ZK, ZV, P extends string> =
  TGetP<F5<MS>, P> extends infer C extends string
    ? MsNextE<OrdGet<MS, C>, NInc<It>>
    : Succ<F5<MS>, P> extends infer Q extends string
      ? MsNextE<OrdGet<MS, TGetP<F5<MS>, Q>>, NInc<NTrim<Rev<Q>>>>
      : Mk4<false, ZK, ZV, It>;
/** The entry of an order-trie leaf (its index path then its canonical key: no hashing). */
type OrdGet<MS, L> = L extends `${infer a}${infer b}${infer c}${infer d}${infer C}`
  ? BGet<TGetP<F3<MS>, `${a}${b}${c}${d}`>, C>
  : never;
type MsNextE<E, It2> = Mk4<true, F1<E>, F2<E>, It2>;
/** The next live entry at or after It and the iterator state after it: [entry, It2], or false. */
type MsNextX<MS, It extends string> =
  NLt<It, F1<MS> & string> extends true
    ? F5<MS> extends undefined
      ? false
      : MsNextAt<MS, It, SeqPath<F4<MS>, It>>
    : false;
type MsNextAt<MS, It extends string, P extends string> =
  TGetP<F5<MS>, P> extends infer C extends string
    ? Mk2<OrdGet<MS, C>, NInc<It>>
    : Succ<F5<MS>, P> extends infer Q extends string
      ? Mk2<OrdGet<MS, TGetP<F5<MS>, Q>>, NInc<NTrim<Rev<Q>>>>
      : false;

/** The state of a map with the entries of MS in iteration order, renumbered from 0 (maps.clone). */
export type MsRebuild<MS> = MsCopyD<MS, "0", MsEmpty<F2<MS>>>;
type MsCopyD<MS, It extends string, Acc> =
  MsCopyL<MS, It, Acc, "300"> extends infer R
    ? F0<R> extends 1
      ? MsCopyD<MS, F1<R> & string, F2<R>>
      : F2<R>
    : never;
type MsCopyL<MS, It extends string, Acc, F extends string> = F extends "0"
  ? Mk4<1, It, Acc, 0>
  : MsNextX<MS, It> extends infer X
    ? X extends false
      ? Mk4<0, It, Acc, 0>
      : MsCopyL<MS, F1<X> & string, MsSet<Acc, F0<F0<X>> & string, F1<F0<X>>, F2<F0<X>>>, K.FUEL[F]>
    : never;

// ---------------------------------------------------------------- maps on the heap
//
// A map value is null (nil) or its object id. Ops take the heap H as an
// alias argument (H2) and the key's canonical form C (`Key*` above).

/** The heap after `make(map[K]V)`; Mode "i" for integer key types, "s" otherwise. */
export type MakeMap<H, Mode> = AllocObj<H, MsEmpty<Mode>>;
/** The map value `make` gives, read from the heap before MakeMap. */
export type MakeMapV<H> = NextId<H>;

// Each op reads the state through `MS extends unknown` so the declarations
// stay deferred (checking them generically over the heap's trie costs ~1M
// types per alias otherwise).

/** `len(m)`. */
export type MapLen<H, M> = M extends null ? "0" : OnMs<GetObj<H, M>, "len", 0, 0, 0>;
/** `m[k]` (Z: the value type's zero). */
export type MapLookup<H, M, C extends string, Z> = M extends null
  ? Z
  : OnMs<GetObj<H, M>, "get", C, Z, 0>;
/** `v, ok := m[k]`. */
export type MapLookupOk<H, M, C extends string, Z> = M extends null
  ? Mk2<Z, false>
  : OnMs<GetObj<H, M>, "getok", C, Z, 0>;
/** `true`, or the nil-map write panic (runtime.plainError). */
export type MapUpdateCk<M> = M extends null ? Panic<"p", ["assignment to entry in nil map"]> : true;
/** The heap after `m[k] = v` (M not nil: MapUpdateCk first). */
export type MapUpdate<H, M, C extends string, Key, V> = PutObj<
  H,
  M,
  OnMs<GetObj<H, M>, "set", C, Key, V>
>;
/** The heap after `delete(m, k)`. */
export type MapDelete<H, M, C extends string> = M extends null
  ? H
  : PutObj<H, M, OnMs<GetObj<H, M>, "del", C, 0, 0>>;
/** The heap after `clear(m)`. */
export type MapClear<H, M> = M extends null
  ? H
  : PutObj<H, M, OnMs<GetObj<H, M>, "clear", 0, 0, 0>>;
/** One `next` of `range m` at iterator state It (initially "0"): `[ok, k, v, It2]`. */
export type MapNext<H, M, It extends string, ZK, ZV> = M extends null
  ? Mk4<false, ZK, ZV, It>
  : OnMs<GetObj<H, M>, "next", It, ZK, ZV>;
/** The heap after `maps.clone(m)` (M not nil); the clone is MakeMapV of the heap before. */
export type MapClone<H, M> = AllocObj<H, OnMs<GetObj<H, M>, "clone", 0, 0, 0>>;

/** Op on map state MS with arguments A..C. */
type OnMs<MS, Op, A, B, C> = MS extends unknown
  ? Op extends "get"
    ? MsLookup<MS, A & string, B>
    : Op extends "set"
      ? MsSet<MS, A & string, B, C>
      : Op extends "next"
        ? MsNext<MS, A & string, B, C>
        : Op extends "getok"
          ? MsLookupOk<MS, A & string, B>
          : Op extends "del"
            ? MsDel<MS, A & string>
            : Op extends "len"
              ? MsLen<MS>
              : Op extends "clear"
                ? MsClear<MS>
                : MsRebuild<MS>
  : never;
