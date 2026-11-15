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
//   D low nibbles, most significant first); leaves hold C.
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
import type { Len, NDec, NInc, NLt, NTrim } from "./str.ts";

// ---------------------------------------------------------------- constructors

type Mk2<A, B> = A extends unknown ? [A, B] : never;
type Mk4<A, B, C, D> = A extends unknown ? [A, B, C, D] : never;
type Mk5<A, B, C, D, E> = A extends unknown ? [A, B, C, D, E] : never;
type Mk6<A, B, C, D, E, F> = A extends unknown ? [A, B, C, D, E, F] : never;

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
  TPutP<Root, SeqPath<D, Seq>, C>
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
      : MsNextAt<MS, It, ZK, ZV, SeqPath<F4<MS>, It>>
    : Mk4<false, ZK, ZV, It>;
type MsNextAt<MS, It extends string, ZK, ZV, P extends string> =
  TGetP<F5<MS>, P> extends infer C extends string
    ? MsNextE<MsGet<MS, C>, It>
    : Succ<F5<MS>, P> extends infer Q extends string
      ? MsNextE<MsGet<MS, TGetP<F5<MS>, Q> & string>, NTrim<Rev<Q>>>
      : Mk4<false, ZK, ZV, It>;
type MsNextE<E, S extends string> = Mk4<true, F1<E>, F2<E>, NInc<S>>;
