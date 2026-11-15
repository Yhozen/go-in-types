// Go strings in types (tsrs). See docs/DESIGN.md "Type-level encodings".
//
// A Go string is a string literal type whose chars are bytes (0..255).
// Integers (lengths, indices, bytes, runes) use the DESIGN.md encoding:
// lowercase hex nibbles, least significant first, the shortest two's
// complement that sign-extends to the value's pattern sign-extended to 64
// bits ("0", "1", "f" for -1, "80" for 8; a uint8 255 is "f"). Operations
// that panic return `Panic<Msg>` (heap.ts's `Panic<"e", [msg]>`: a
// runtime.errorString whose message, without the "runtime error: " prefix,
// is one string part), which the caller raises.
//
// Long strings are read through an index, `Chars<S>` (adapted from
// lua-in-types' src/aot/types/str.ts): a 16-ary trie of 256-char blocks keyed
// by the nibbles of the offset, built once per distinct string and memoized
// by the checker's alias-instantiation cache, so a byte read costs a few
// indexed accesses once it exists.
import type { Panic as HP } from "./heap.ts";
import type * as I from "./int.ts";
import type * as K from "./str-tables.gen.ts";

/** A runtime panic (runtime.errorString with this message), heap.ts's form with one message part. */
export type Panic<M extends string> = HP<"e", [M]>;

type NegNib = "8" | "9" | "a" | "b" | "c" | "d" | "e" | "f";

// ---------------------------------------------------------------- naturals
//
// Small non-negative integers in the canonical encoding (lengths, offsets,
// counts): a few helpers, so strings and maps do not depend on the general
// integer module for their bookkeeping.

interface SUCC {
  "0": "1";
  "1": "2";
  "2": "3";
  "3": "4";
  "4": "5";
  "5": "6";
  "6": "7";
  "7": "8";
  "8": "9";
  "9": "a";
  a: "b";
  b: "c";
  c: "d";
  d: "e";
  e: "f";
  f: "0";
}
interface PRED {
  "0": "f";
  "1": "0";
  "2": "1";
  "3": "2";
  "4": "3";
  "5": "4";
  "6": "5";
  "7": "6";
  "8": "7";
  "9": "8";
  a: "9";
  b: "a";
  c: "b";
  d: "c";
  e: "d";
  f: "e";
}

/** Is the integer negative? */
export type IsNeg<A extends string> = A extends `${string}${NegNib}` ? true : false;

/** n + 1 for canonical n >= 0. */
export type NInc<A extends string, O extends string = ""> = A extends `${infer a}${infer R}`
  ? a extends "f"
    ? NInc<R, `${O}0`>
    : R extends ""
      ? a extends "7"
        ? `${O}80`
        : `${O}${SUCC[a & keyof SUCC]}`
      : R extends "0"
        ? `${O}${SUCC[a & keyof SUCC]}0`
        : `${O}${SUCC[a & keyof SUCC]}${R}`
  : `${O}1`;

/** n - 1 for canonical n >= 1. */
export type NDec<A extends string, O extends string = ""> = A extends `${infer a}${infer R}`
  ? a extends "0"
    ? NDec<R, `${O}f`>
    : NTrim<`${O}${PRED[a & keyof PRED]}${R}`>
  : never;

/** Canonical form of an unsigned nibble string below 2^63: drop high zeros, keep a sign "0". */
export type NTrim<U extends string> =
  StripZ<U> extends infer V extends string
    ? V extends ""
      ? "0"
      : V extends `${string}${NegNib}`
        ? `${V}0`
        : V
    : never;
type StripZ<S extends string> = S extends `${infer H}0` ? StripZ<H> : S;

/** a + w for canonical a >= 0 and w in "1".."4". */
export type NAddW<A extends string, W extends string> = W extends "1"
  ? NInc<A>
  : W extends "2"
    ? NInc<NInc<A>>
    : W extends "3"
      ? NInc<NInc<NInc<A>>>
      : NInc<NInc<NInc<NInc<A>>>>;

/** Compare canonical a, b >= 0: "<", "=" or ">". */
export type NCmp<A extends string, B extends string, F extends string = "="> = A extends B
  ? "="
  : NCmpL<A, B, F>;
type NCmpL<A extends string, B extends string, F extends string> = A extends `${infer a}${infer AR}`
  ? B extends `${infer b}${infer BR}`
    ? NCmpL<AR, BR, a extends b ? F : K.CMPN[`${a}${b}`]>
    : ">"
  : B extends ""
    ? F
    : "<";

/** a < b for canonical a, b >= 0. */
export type NLt<A extends string, B extends string> = NCmp<A, B> extends "<" ? true : false;

// ---------------------------------------------------------------- length

/** Count chars: L ones, M sixteens (nibbles), H 256s (unsigned); 16 sixteens move to the 256 loop. */
type Cnt16<
  S extends string,
  M extends string,
  H extends string,
> = S extends `${infer _0}${infer _1}${infer _2}${infer _3}${infer _4}${infer _5}${infer _6}${infer _7}${infer _8}${infer _9}${infer _10}${infer _11}${infer _12}${infer _13}${infer _14}${infer _15}${infer R}`
  ? M extends "f"
    ? CntD<R, UInc<H>>
    : Cnt16<R, SUCC[M & keyof SUCC], H>
  : Cnt1<S, "0", M, H>;
type Cnt1<
  S extends string,
  L extends string,
  M extends string,
  H extends string,
> = S extends `${infer _}${infer R}` ? Cnt1<R, SUCC[L & keyof SUCC], M, H> : NTrim<`${L}${M}${H}`>;
/** 256 chars per step, at most 500 steps per call ([1, rest, H] when out of fuel). */
type Cnt256<S extends string, H extends string, F extends string> = F extends "0"
  ? [1, S, H]
  : K.Skip256<S> extends infer R extends string
    ? Cnt256<R, UInc<H>, K.FUEL[F]>
    : Cnt16<S, "0", H>;
type CntD<S extends string, H extends string> =
  Cnt256<S, H, "500"> extends infer X
    ? X extends [1, infer S2 extends string, infer H2 extends string]
      ? CntD<S2, H2>
      : X
    : never;
/** u + 1 on an unsigned nibble string (least significant first, may end in zeros). */
type UInc<U extends string, O extends string = ""> = U extends `${infer x}${infer R}`
  ? x extends "f"
    ? UInc<R, `${O}0`>
    : `${O}${SUCC[x & keyof SUCC]}${R}`
  : `${O}1`;

/** `len(s)`: the number of bytes (memoized per string). */
export type Len<S extends string> = Cnt16<S, "0", "">;

// ---------------------------------------------------------------- the index

type Node<C extends unknown[]> = C extends unknown[]
  ? {
      "0": C[0];
      "1": C[1];
      "2": C[2];
      "3": C[3];
      "4": C[4];
      "5": C[5];
      "6": C[6];
      "7": C[7];
      "8": C[8];
      "9": C[9];
      a: C[10];
      b: C[11];
      c: C[12];
      d: C[13];
      e: C[14];
      f: C[15];
      g: C[0];
    }
  : never;

/**
 * A block of up to 256 chars, 16 at a time: X0 is the string from the block
 * on, Subs the 16-char nodes so far, Pre their prefixes, Acc the text so far.
 * Used for the first block (cheap for short strings) and the last one.
 */
type Tail<
  X0 extends string,
  X extends string,
  Subs extends unknown[],
  Pre extends string[],
  Acc extends string,
> = Subs["length"] extends 16
  ? [{ c: Node<Subs>; t: Acc; p: Node<Pre>; x: X0 }, X, X extends "" ? "ff" : false]
  : X extends `${infer _0}${infer _1}${infer _2}${infer _3}${infer _4}${infer _5}${infer _6}${infer _7}${infer _8}${infer _9}${infer _10}${infer _11}${infer _12}${infer _13}${infer _14}${infer _15}${infer R}`
    ? Tail<
        X0,
        R,
        [
          ...Subs,
          {
            "0": _0;
            "1": _1;
            "2": _2;
            "3": _3;
            "4": _4;
            "5": _5;
            "6": _6;
            "7": _7;
            "8": _8;
            "9": _9;
            a: _10;
            b: _11;
            c: _12;
            d: _13;
            e: _14;
            f: _15;
            g: _0;
          },
        ],
        [...Pre, Acc],
        `${Acc}${_0}${_1}${_2}${_3}${_4}${_5}${_6}${_7}${_8}${_9}${_10}${_11}${_12}${_13}${_14}${_15}`
      >
    : TailEnd<X0, X, [], Subs, [...Pre, Acc]>;

type TailEnd<
  X0 extends string,
  X extends string,
  L extends string[],
  Subs extends unknown[],
  Pre extends string[],
> = X extends `${infer a}${infer R}`
  ? TailEnd<X0, R, [...L, a], Subs, Pre>
  : L extends [unknown, ...infer L1]
    ? [
        { c: Node<[...Subs, Node<L>]>; t: X0; p: Node<Pre>; x: X0 },
        "",
        `${K.HEX[L1["length"]]}${K.HEX[Subs["length"]]}`,
      ]
    : Subs extends [unknown, ...infer S1]
      ? [{ c: Node<Subs>; t: X0; p: Node<Pre>; x: X0 }, "", `f${K.HEX[S1["length"]]}`]
      : never;

type Blk<X extends string> =
  K.Blk256<X> extends infer B ? (B extends 0 ? Tail<X, X, [], [], ""> : B) : never;

/** A trie node of level L (L = 0: a block) from X: [node, rest, last offset in it | false]. */
type Build<L extends 1[], X extends string> = L extends [1, ...infer L1 extends 1[]]
  ? Fill<L1, X, []>
  : Blk<X>;
type Fill<L1 extends 1[], X extends string, C extends unknown[]> =
  Build<L1, X> extends [infer Nd, infer R extends string, infer P]
    ? P extends string
      ? [Node<[...C, Nd]>, R, `${P}${K.HEX[C["length"]]}`]
      : C["length"] extends 15
        ? [Node<[...C, Nd]>, R, false]
        : Fill<L1, R, [...C, Nd]>
    : never;
/** Root is a full level-L node and R the rest: put it under a new root. */
type Grow<L extends 1[], Root, R extends string> =
  Fill<L, R, [Root]> extends [infer Nd, infer R2 extends string, infer P]
    ? P extends string
      ? { root: Nd; d: [1, ...L] }
      : Grow<[1, ...L], Nd, R2>
    : never;

/** The shape of an index: the trie and its depth (levels above the blocks). */
export type CharsT = { root: any; d: 1[] };

/**
 * The index of a non-empty S: a 16-ary trie whose leaves are 256-char
 * blocks, keyed by the nibbles of the offset. Memoized per string.
 */
export type Chars<S extends string> =
  Tail<S, S, [], [], ""> extends [infer B, infer R extends string, infer P]
    ? P extends string
      ? { root: B; d: [] }
      : Grow<[], B, R>
    : never;

type InRange<Z extends string> = Z extends `g${string}`
  ? true
  : Z extends `0g${string}`
    ? true
    : false;

/** "g" (the lookup padding) reads as "0". */
type NZ = {
  [key: string]: string;
  g: "0";
  "0": "0";
  "1": "1";
  "2": "2";
  "3": "3";
  "4": "4";
  "5": "5";
  "6": "6";
  "7": "7";
  "8": "8";
  "9": "9";
  a: "a";
  b: "b";
  c: "c";
  d: "d";
  e: "e";
  f: "f";
};

/**
 * Where offset P (canonical, >= 0) is: [block, hi, lo, path] with the path
 * of the block (nibbles least significant first, "g" read as "0"), or 0 when P
 * is beyond the trie. Within it, chars past the end read as undefined.
 */
type Loc<C extends CharsT, P extends string> = LocD<C["root"], C["d"], `${P}gggggg`>;
type LocD<R, D extends 1[], Q extends string> = D extends []
  ? Q extends `${infer a}${infer b}${infer z}`
    ? InRange<z> extends true
      ? [R, b, a, ""]
      : 0
    : 0
  : D extends [1]
    ? Q extends `${infer a}${infer b}${infer p1}${infer z}`
      ? InRange<z> extends true
        ? [Ix<R, p1>, b, a, NZ[p1]]
        : 0
      : 0
    : LocD2<R, D, Q>;
type LocD2<R extends any, D extends 1[], Q extends string> = D extends [1, 1]
  ? Q extends `${infer a}${infer b}${infer p1}${infer p2}${infer z}`
    ? InRange<z> extends true
      ? [Ix<Ix<R, p2>, p1>, b, a, `${NZ[p1]}${NZ[p2]}`]
      : 0
    : 0
  : D extends [1, 1, 1]
    ? Q extends `${infer a}${infer b}${infer p1}${infer p2}${infer p3}${infer z}`
      ? InRange<z> extends true
        ? [Ix<Ix<Ix<R, p3>, p2>, p1>, b, a, `${NZ[p1]}${NZ[p2]}${NZ[p3]}`]
        : 0
      : 0
    : Q extends `${infer a}${infer b}${infer p1}${infer p2}${infer p3}${infer p4}${infer z}`
      ? InRange<z> extends true
        ? [Ix<Ix<Ix<Ix<R, p4>, p3>, p2>, p1>, b, a, `${NZ[p1]}${NZ[p2]}${NZ[p3]}${NZ[p4]}`]
        : 0
      : 0;
type Ix<R, K extends string> = R extends { [k: string]: any } ? R[K] : undefined;

/** The char at offset P (canonical, >= 0), or undefined past the end. */
export type At<C extends CharsT, P extends string> =
  Loc<C, P> extends [
    infer B extends { c: any },
    infer h extends string,
    infer l extends string,
    string,
  ]
    ? B["c"][h][l]
    : undefined;

/** The block whose path (least significant nibble first) is P. */
type BlockAt<R, P extends string> = P extends `${infer p}${infer PR}` ? BlockAtR<R, PR, p> : R;
type BlockAtR<R, PR extends string, p extends string> =
  BlockAt<R, PR> extends infer X ? Ix<X, p> : never;

/** Path a < path b (equal lengths, least significant nibble first). */
type PathLt<
  A extends string,
  B extends string,
  F extends boolean = false,
> = A extends `${infer a}${infer AR}`
  ? B extends `${infer b}${infer BR}`
    ? PathLt<AR, BR, a extends b ? F : K.CMPN[`${a}${b}`] extends "<" ? true : false>
    : F
  : F;

/** Path + 1 (fixed width; least significant nibble first). */
type PathInc<P extends string, O extends string = ""> = P extends `${infer x}${infer R}`
  ? x extends "f"
    ? PathInc<R, `${O}0`>
    : `${O}${SUCC[x & keyof SUCC]}${R}`
  : O;

// ---------------------------------------------------------------- substrings

/** The first k chars of block B, k the next offset after (h, l): "t" means the whole block. */
type PrefixThrough<
  B extends { c: any; p: any; t: string },
  h extends string,
  l extends string,
> = K.NEXT2[`${NZ[l]}${NZ[h]}`] extends infer X
  ? X extends "t"
    ? B["t"]
    : X extends `${infer l2}${infer h2}`
      ? K.PrefixAt<B, h2, l2>
      : never
  : never;

type Blk_ = { c: any; p: any; t: string; x: string };

/** S[a..e] (inclusive offsets, a <= e < len). */
type SubAE<C extends CharsT, A extends string, E extends string> =
  Loc<C, A> extends [
    infer BA extends Blk_,
    infer ha extends string,
    infer la extends string,
    infer pa extends string,
  ]
    ? Loc<C, E> extends [
        infer BE extends Blk_,
        infer he extends string,
        infer le extends string,
        infer pe extends string,
      ]
      ? SubBlocks<C, BA, K.PrefixAt<BA, ha, la>, pa, BE, PrefixThrough<BE, he, le>, pe>
      : never
    : never;

type SubBlocks<
  C extends CharsT,
  BA extends Blk_,
  PA extends string,
  pa extends string,
  BE extends Blk_,
  PE extends string,
  pe extends string,
> = pa extends pe
  ? PE extends `${PA}${infer M}`
    ? M
    : ""
  : PathLt<pe, pa> extends true
    ? ""
    : BA["t"] extends `${PA}${infer TA}`
      ? SubMid<C, PathInc<pa>, pe, TA, PE, BA, PA, BE, "8">
      : never;

/** Concatenate the blocks between (up to 8), else cut the suffixes. */
type SubMid<
  C extends CharsT,
  P extends string,
  pe extends string,
  Acc extends string,
  PE extends string,
  BA extends Blk_,
  PA extends string,
  BE extends Blk_,
  F extends string,
> = P extends pe
  ? `${Acc}${PE}`
  : F extends "0"
    ? SubFar<BA, PA, BE, PE>
    : SubMid<C, PathInc<P>, pe, `${Acc}${BlockAt<C["root"], P>["t"]}`, PE, BA, PA, BE, K.FUEL[F]>;

type SubFar<
  BA extends Blk_,
  PA extends string,
  BE extends Blk_,
  PE extends string,
> = BA["x"] extends `${PA}${infer SA}`
  ? BE["x"] extends `${PE}${infer SE}`
    ? SA extends `${infer M}${SE}`
      ? M
      : never
    : never
  : never;

/** S from offset P on (0 < P < len). */
type SuffixFrom<C extends CharsT, P extends string> =
  Loc<C, P> extends [infer B extends Blk_, infer h extends string, infer l extends string, string]
    ? B["x"] extends `${K.PrefixAt<B, h, l>}${infer X}`
      ? X
      : never
    : never;

/**
 * `s[l:h]` (L, H integers of kinds KL, KH; null when omitted), or the bounds
 * panic Go raises (checked in Go's order: h, then l).
 */
export type Slice<
  S extends string,
  L extends string | null,
  H extends string | null,
  KL extends I.W = "i64",
  KH extends I.W = "i64",
> =
  Len<S> extends infer N extends string
    ? H extends string
      ? SliceH<S, N, L extends string ? L : "0", Pos<KH, H>, KL, KH, L extends string ? L : "0", H>
      : SliceH<S, N, L extends string ? L : "0", N, KL, "i64", L extends string ? L : "0", N>
    : never;
type SliceH<
  S extends string,
  N extends string,
  L extends string,
  H extends string,
  KL extends I.W,
  KH extends I.W,
  L0 extends string,
  H0 extends string,
> =
  IsNeg<H> extends true
    ? Panic<`slice bounds out of range [:${I.ToDec<KH, H0>}]`>
    : NLt<N, H> extends true
      ? Panic<`slice bounds out of range [:${I.ToDec<KH, H0>}] with length ${I.ToDec<"i64", N>}`>
      : Pos<KL, L> extends infer LP extends string
        ? IsNeg<LP> extends true
          ? Panic<`slice bounds out of range [${I.ToDec<KL, L0>}:]`>
          : NLt<H, LP> extends true
            ? Panic<`slice bounds out of range [${I.ToDec<KL, L0>}:${I.ToDec<KH, H0>}]`>
            : SliceOk<S, N, LP, H>
        : never;
/** An index of kind K as a signed form (unsigned values zero-extended, so they are never negative). */
type Pos<K extends I.W, A extends string> = K extends "i64" | "i32" | "i16" | "i8"
  ? A
  : I.ZExt<K, A>;
type SliceOk<S extends string, N extends string, L extends string, H extends string> = L extends H
  ? ""
  : H extends N
    ? L extends "0"
      ? S
      : Chars<S> extends infer C extends CharsT
        ? SuffixFrom<C, L>
        : never
    : Chars<S> extends infer C extends CharsT
      ? SubAE<C, L, NDec<H>>
      : never;

// ---------------------------------------------------------------- bytes

/** `s[i]`: the byte at offset I (an integer of kind KI), a uint8; or the index panic. */
export type Index<S extends string, I0 extends string, KI extends I.W = "i64"> =
  Pos<KI, I0> extends infer P extends string
    ? IsNeg<P> extends true
      ? Panic<`index out of range [${I.ToDec<KI, I0>}]`>
      : S extends ""
        ? Panic<`index out of range [${I.ToDec<KI, I0>}] with length 0`>
        : Chars<S> extends infer C extends CharsT
          ? At<C, P> extends infer c extends string
            ? K.CODE[c]
            : Panic<`index out of range [${I.ToDec<KI, I0>}] with length ${I.ToDec<"i64", Len<S>>}`>
          : never
    : never;

/** `s + t`. */
export type Concat<A extends string, B extends string> = `${A}${B}`;

/** The bytes of S as a tuple of uint8s (`[]byte(s)` contents; S up to a few thousand bytes). */
export type Codes<
  S extends string,
  O extends string[] = [],
> = S extends `${infer a}${infer b}${infer c}${infer d}${infer R}`
  ? Codes<R, [...O, K.CODE[a], K.CODE[b], K.CODE[c], K.CODE[d]]>
  : S extends `${infer a}${infer R}`
    ? Codes<R, [...O, K.CODE[a]]>
    : O;

/** A string from uint8s (`string(b)` contents). */
export type FromCodes<Cs extends string[], O extends string = ""> = Cs extends [
  infer a extends string,
  infer b extends string,
  infer c extends string,
  infer d extends string,
  ...infer R extends string[],
]
  ? FromCodes<R, `${O}${K.CHR[a]}${K.CHR[b]}${K.CHR[c]}${K.CHR[d]}`>
  : Cs extends [infer a extends string, ...infer R extends string[]]
    ? FromCodes<R, `${O}${K.CHR[a]}`>
    : O;

// ---------------------------------------------------------------- comparison

/** Compare byte strings: "f" (-1), "0" or "1" (runtime.cmpstring). */
export type Compare<A extends string, B extends string> = A extends B ? "0" : Cmp4<A, B>;
type Cmp4<
  A extends string,
  B extends string,
> = A extends `${infer a0}${infer a1}${infer a2}${infer a3}${infer AR}`
  ? B extends `${a0}${a1}${a2}${a3}${infer BR}`
    ? Cmp4<AR, BR>
    : Cmp1<A, B>
  : Cmp1<A, B>;
type Cmp1<A extends string, B extends string> = A extends `${infer a}${infer AR}`
  ? B extends `${infer b}${infer BR}`
    ? a extends b
      ? Cmp1<AR, BR>
      : CmpC<K.HEX2[a], K.HEX2[b]>
    : "1"
  : B extends ""
    ? "0"
    : "f";
type CmpC<X extends string, Y extends string> = X extends `${infer xh}${infer xl}`
  ? Y extends `${infer yh}${infer yl}`
    ? (xh extends yh ? K.CMPN[`${xl}${yl}`] : K.CMPN[`${xh}${yh}`]) extends "<"
      ? "f"
      : "1"
    : never
  : never;

/** `a == b`. */
export type Eq<A extends string, B extends string> = [A] extends [B] ? true : false;
/** `a < b`. */
export type Lt<A extends string, B extends string> = Compare<A, B> extends "f" ? true : false;
/** `a <= b`. */
export type Le<A extends string, B extends string> = Compare<A, B> extends "1" ? false : true;
/** `a > b`. */
export type Gt<A extends string, B extends string> = Compare<A, B> extends "1" ? true : false;
/** `a >= b`. */
export type Ge<A extends string, B extends string> = Compare<A, B> extends "f" ? false : true;

// ---------------------------------------------------------------- searching (internal/bytealg)

/** `bytealg.IndexByteString(s, c)`: the first offset of byte C, or -1. */
export type IndexByte<
  S extends string,
  C extends string,
> = S extends `${infer P}${K.CHR[C]}${string}` ? Len<P> : "f";

/** `bytealg.IndexString(s, sub)`: the first offset of Sub, or -1. */
export type IndexStr<S extends string, Sub extends string> = Sub extends ""
  ? "0"
  : S extends `${infer P}${Sub}${string}`
    ? Len<P>
    : "f";

/** `bytealg.CountString(s, c)`: the number of bytes equal to C. */
export type CountByte<S extends string, C extends string> = CountD<S, K.CHR[C], "0">;
type CountL<S extends string, Ch extends string, N extends string, F extends string> = F extends "0"
  ? [1, S, N]
  : S extends `${string}${Ch}${infer R}`
    ? CountL<R, Ch, NInc<N>, K.FUEL[F]>
    : [0, "", N];
type CountD<S extends string, Ch extends string, N extends string> =
  CountL<S, Ch, N, "500"> extends [infer More, infer R extends string, infer N2 extends string]
    ? More extends 1
      ? CountD<R, Ch, N2>
      : N2
    : never;

// ---------------------------------------------------------------- UTF-8

/** U+FFFD's encoding. */
type FFFD = "\xef\xbf\xbd";
type Bad = ["dfff0", "1"];

/** `string(r)` for any integer R: its UTF-8 encoding, U+FFFD when not a valid code point. */
export type RuneStr<R extends string> = R extends keyof K.ENC12
  ? K.ENC12[R]
  : R extends `${infer n0}${infer n1}${infer n2}${infer n3}${infer rest}`
    ? `${n3}${n2}${rest}` extends keyof K.E3A
      ? `${K.E3A[`${n3}${n2}${rest}`]}${K.E4L[`${n2}${n1}${n0}`]}`
      : `${rest}${n3}` extends keyof K.E4H
        ? `${K.E4H[`${rest}${n3}`]}${K.E4L[`${n2}${n1}${n0}`]}`
        : FFFD
    : FFFD;

/**
 * Decode the rune at the start of a non-empty X exactly as
 * utf8.DecodeRuneInString: [rune, width] (invalid: U+FFFD, width 1).
 * C1..C3 are the next chars (or undefined).
 */
type Decode<
  C0 extends string,
  C1 extends string,
  C2 extends string,
  C3 extends string,
> = K.CLS[C0] extends "1"
  ? [K.CODE[C0], "1"]
  : K.CLS[C0] extends "2"
    ? `${C0}${C1}` extends keyof K.DEC2
      ? [K.DEC2[`${C0}${C1}`], "2"]
      : Bad
    : K.CLS[C0] extends "3"
      ? `${C0}${C1}` extends keyof K.D3A
        ? K.D3A[`${C0}${C1}`] extends `${infer k}${infer up}`
          ? `${k}${C2}` extends keyof K.D3B
            ? [`${K.D3B[`${k}${C2}`]}${up}`, "3"]
            : Bad
          : never
        : Bad
      : K.CLS[C0] extends "4"
        ? `${C0}${C1}` extends keyof K.D4A
          ? `${C2}${C3}` extends keyof K.D4B
            ? [`${K.D4B[`${C2}${C3}`]}${K.D4A[`${C0}${C1}`]}`, "4"]
            : Bad
          : Bad
        : Bad;

/** Decode the rune at the start of X: [rune, width, rest] (X non-empty). */
type DecodeHead<X extends string> = X extends `${infer c0}${infer R}`
  ? K.CLS[c0] extends "1"
    ? [K.CODE[c0], "1", R]
    : R extends `${infer c1}${infer c2}${infer c3}${infer R3}`
      ? Rest<Decode<c0, c1, c2, c3>, R, `${c2}${c3}${R3}`, `${c3}${R3}`, R3>
      : R extends `${infer c1}${infer c2}${infer R2}`
        ? Rest<Decode<c0, c1, c2, "">, R, `${c2}${R2}`, R2, never>
        : R extends `${infer c1}${infer R1}`
          ? Rest<Decode<c0, c1, "", "">, R, R1, never, never>
          : Rest<Bad, R, never, never, never>
  : never;
type Rest<D, R1, R2, R3, R4> = D extends [infer r, infer w]
  ? [r, w, w extends "1" ? R1 : w extends "2" ? R2 : w extends "3" ? R3 : R4]
  : never;

/**
 * One step of `range` over S at offset P (DESIGN.md: decodes like
 * utf8.DecodeRuneInString): `[true, P, rune, next offset]`, or
 * `[false, "0", "0", P]` at the end. The emitter keeps the next offset as the
 * iterator's state.
 */
export type Next<S extends string, P extends string> = S extends ""
  ? [false, "0", "0", P]
  : Chars<S> extends infer C extends CharsT
    ? At<C, P> extends infer c0 extends string
      ? K.CLS[c0] extends "1"
        ? [true, P, K.CODE[c0], NInc<P>]
        : NextM<C, P, c0, NInc<P>>
      : [false, "0", "0", P]
    : never;
type NextM<C extends CharsT, P extends string, c0 extends string, P1 extends string> =
  NInc<P1> extends infer P2 extends string
    ? Decode<c0, Ch<At<C, P1>>, Ch<At<C, P2>>, Ch<At<C, NInc<P2>>>> extends [
        infer r,
        infer w extends string,
      ]
      ? [true, P, r, NAddW<P, w>]
      : never
    : never;

/** A char read by At, or "" past the end. */
type Ch<X> = X extends string ? X : "";

/** `[]rune(s)` contents: the runes of S as a tuple (S up to ~2,000 runes). */
export type Runes<S extends string, O extends string[] = []> = S extends ""
  ? O
  : DecodeHead<S> extends [infer r extends string, string, infer R extends string]
    ? Runes<R, [...O, r]>
    : never;

/** `string(runes)` contents: each rune's encoding (U+FFFD for invalid ones). */
export type FromRunes<Rs extends string[], O extends string = ""> = Rs extends [
  infer r extends string,
  ...infer R extends string[],
]
  ? FromRunes<R, `${O}${RuneStr<r>}`>
  : O;
