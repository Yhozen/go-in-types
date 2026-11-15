// Go integers of every width in types (docs/DESIGN.md "Type-level encodings").
//
// A value is the nibble string of its w-bit pattern sign-extended to 64 bits:
// lowercase hex, least significant nibble first, two's complement, trimmed to
// the shortest string that sign-extends to the value (the top bit of the last
// nibble is the sign; every nibble past the end repeats it). 0 -> "0",
// 8 -> "80", -1 -> "f", int16 -2 -> "e", uint8 255 -> "f", uint64 max -> "f".
// Every value of every width has one canonical form, so `==` is `extends` and
// values can be object keys. Width and signedness live in the operation: the
// first parameter `W` of an operation is one of `"i8" | "u8" | "i16" | "u16" |
// "i32" | "u32" | "i64" | "u64"` (`int`/`uint`/`uintptr` are i64/u64). The
// JavaScript side is src/types/codec-int.ts.
//
// Adapted from lua-in-types' src/aot/types/int64.ts: every operation walks
// the nibbles with lookup tables (int-tables.gen.ts), so a value costs what
// its length is. Short paths come first: forms of one or two nibbles
// (-128..127, every int8/uint8 value) add and compare in one lookup of a
// pair table (int-pairs.gen.ts, 65,536 keys each, ~29 MB of checker memory
// per table); forms of up to three nibbles (-2048..2047: indices, ast.Kind
// values) split into a two-nibble high part and a nibble (HI3/LO3 tables)
// for + - < <= & | ^ &^, shifts, * and / % by |b| < 16; - and ^ are one
// lookup. Longer operands take the nibble loops.
// Because forms are sign-extended, the 64-bit result of + - * ^ & | &^ <<
// already has the right low w bits: `Fit<W, _>` cuts it to w/4 nibbles and
// re-trims (nothing to do for i64/u64, or when the result is short). Bitwise
// operations, comparisons, signed division and >> need no cut. Unsigned
// division, remainder and >> of a negative-looking form work on the w-bit
// pattern's magnitude (`UMag`); unsigned < compares the sign-extended
// patterns as uint64, which orders w-bit patterns correctly.
//
// Errors are `Panic<message>` tuples (Go's runtime error text without the
// "runtime error: " prefix) that the emitter turns into a runtime panic:
// `DivZero` for `/` and `%` by zero, `NegShift` for a negative signed shift
// count. MinInt / -1 wraps to MinInt and MinInt % -1 is 0, as in Go.
//
// Internally, unsigned magnitudes ("U" strings) are nibbles least significant
// first without a sign nibble; zero is "" and trailing zeros may appear.
//
// Cost: instantiations per op on stock tsrs 0.23.0 (`TSRS_FAST=1 tsrs --fast
// --extendedDiagnostics`), `scripts/heavy.sh node scripts/bench-int.ts 200`:
// 200 distinct random cases per cell minus a baseline of the same assertions
// on literals. Columns: "1" both operands -8..7 (i64; u64 for "(u)" rows, so
// negatives are full-width there), "byte" uint8 0..255, "idx" int 0..255,
// "i16" int16 0..400 (ast.Kind-like), "32"/"64" full-width random operands
// (i32/u32, i64/u64). Shifts count by a uint64 1..w-1. `*` star: fewer
// distinct cases exist. lua-in-types int64 for reference (its columns 1, 2,
// 8, 16 nibbles): Add 6/94/300/566, Mul 6/387/2978/10702, IDiv 7/674/2544/
// 4654, Band 6/64/212/404, Lt 6-23/57/140/219, ToDec 0/4/1141/3893.
//
// | op         |    1 | byte |  idx |  i16 |   32 |     64 |
// | ---------- | ---: | ---: | ---: | ---: | ---: | -----: |
// | Add        |   13 |   18 |   37 |   43 |  381 |    608 |
// | Sub        |   18 |   23 |   41 |   50 |  345 |    573 |
// | Mul        |   14 |  367 |  322 |  408 | 3032 | 10,739 |
// | Quo        |   14 |  675 |  673 |  823 | 2435 |  4,422 |
// | Quo (u)    |  919 |  670 |  655 |  834 | 2358 |  4,366 |
// | Rem        |   13 |  668 |  662 |  811 | 2443 |  4,455 |
// | And        |   24 |   24 |   24 |   24 |  214 |    405 |
// | Or, Xor    |   22 |   22 |   22 |   22 |  210 |    402 |
// | AndNot     |   26 |   28 |   28 |   28 |  287 |    529 |
// | Shl        |   45 |   44 |   55 |   62 |  264 |    302 |
// | Shr        |   31 |   51 |   31 |   28 |  158 |    262 |
// | Shr (u)    |  138 |   53 |   41 |   28 |  200 |    321 |
// | Eq         |    3 |    3 |    3 |    3 |    3 |      3 |
// | Lt, Le     |   23 |   23 |   23 |   23 |  175 |    278 |
// | Lt (u)     |   23 |   23 |   23 |   23 |  142 |    214 |
// | Neg        |   10 |   14 |   10 |   13 |  133 |    145 |
// | Not        |    6 |    6 |    6 |    6 |   73 |    121 |
// | Conv trunc |   17 |    6 |   17 |   17 |   43 |     43 |
// | Conv zext  |    6 |   36 |    6 |   22 |   45 |      6 |
// | ToDec      |    6 |   19 |    6 |    6 | 1153 |  3,899 |
//
// Mid-size operands ("mid": i64 4096..1,000,000, `bench-int.ts` column
// `mid`) take the six-nibble split: Add 168 (217 through the loop), Lt 99
// (176), Le 101; a + 1 and a - 1 are Inc/Dec1. Sub of a mid-size operand
// still takes the loop (229). The split costs Add, Lt and Le ~30-40 more on
// 32/64-bit operands before they fall back to the loops. An empty Go loop
// at N = 10k-20k costs 126 instantiations per iteration (202 before; 82 at N
// up to ~600).
//
// Constant operands on the short paths (a in 0..2047): a * 10 ~100, a / 10
// ~120 (u: ~90), a % 10 ~115, a * 2^k ~38, a / 2 ~46, a >> 3 ~27, a << 3
// ~34. (The byte/idx Mul and Quo columns use random divisors up to 255, which
// take the loops.) The `W` dispatch costs 1-4 per op; aliases specialised per
// kind would save that. Cost does not depend on unrelated live types: with a
// forced 102,400-tuple trie in the same file, the per-op numbers of Add, Mul,
// Quo, Lt and Shr are identical (bench-int.ts --noise 102400).
import type * as P from "./int-pairs.gen.ts";
import type * as T from "./int-tables.gen.ts";

/** An integer kind: signedness and width. */
export type W = "i8" | "u8" | "i16" | "u16" | "i32" | "u32" | "i64" | "u64";
type US = "u8" | "u16" | "u32" | "u64";

/** A runtime error result. */
export type Panic<M extends string> = ["panic", M];
/** `/` or `%` by zero. */
export type DivZero = Panic<"integer divide by zero">;
/** A shift by a negative (signed) count. */
export type NegShift = Panic<"negative shift amount">;

type Nib =
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f";
type PosNib = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7";
type NegNib = "8" | "9" | "a" | "b" | "c" | "d" | "e" | "f";
/** A canonical form whose top bit is set (negative as signed). */
type NegForm = `${string}${NegNib}`;

// ---- strings of nibbles ----

/** The sign-extension nibble of a canonical form: "f" when negative, else "0". */
type Ext<A extends string> = A extends NegForm ? "f" : "0";

/** Drop trailing nibbles that only repeat the sign of the nibble below them. */
type Trim<S extends string> = S extends `${infer H}0`
  ? H extends `${string}${PosNib}`
    ? Trim<H>
    : S
  : S extends `${infer H}f`
    ? H extends `${string}${NegNib}`
      ? Trim<H>
      : S
    : S;

/**
 * O followed by X, canonical when X is the last nibble of a result or the
 * unchanged canonical tail of an operand: only a last "0" or "f" can be
 * redundant, and only when it is the whole of X.
 */
type Cat<O extends string, X extends string> = X extends "0" | "f" ? Trim<`${O}${X}`> : `${O}${X}`;

/** The first 16 nibbles of S (S itself when shorter): the 64-bit pattern. */
type Take16<S extends string> =
  S extends `${infer a}${infer b}${infer c}${infer d}${infer e}${infer f}${infer g}${infer h}${infer R}`
    ? R extends `${infer i}${infer j}${infer k}${infer l}${infer m}${infer n}${infer o}${infer p}${string}`
      ? `${a}${b}${c}${d}${e}${f}${g}${h}${i}${j}${k}${l}${m}${n}${o}${p}`
      : S
    : S;

/** At least 16 nibbles. */
type Is16<S extends string> =
  S extends `${infer _0}${infer _1}${infer _2}${infer _3}${infer _4}${infer _5}${infer _6}${infer _7}${infer R}`
    ? R extends `${infer _8}${infer _9}${infer _10}${infer _11}${infer _12}${infer _13}${infer _14}${infer _15}${string}`
      ? true
      : false
    : false;

/** A 64-bit canonical form cut to 2, 4 or 8 nibbles and re-trimmed (w-bit wraparound). */
type Cut2<S extends string> = S extends `${infer a}${infer b}${infer R}`
  ? R extends ""
    ? S
    : Trim<`${a}${b}`>
  : S;
type Cut4<S extends string> = S extends `${infer a}${infer b}${infer c}${infer d}${infer R}`
  ? R extends ""
    ? S
    : Trim<`${a}${b}${c}${d}`>
  : S;
type Cut8<S extends string> =
  S extends `${infer a}${infer b}${infer c}${infer d}${infer e}${infer f}${infer g}${infer h}${infer R}`
    ? R extends ""
      ? S
      : Trim<`${a}${b}${c}${d}${e}${f}${g}${h}`>
    : S;

/** A 64-bit canonical form wrapped to kind W. */
export type Fit<K extends W, S extends string> = K extends "i64" | "u64"
  ? S
  : S extends keyof T.WRAP8
    ? K extends "i8" | "u8"
      ? T.WRAP8[S]
      : S
    : K extends "i32" | "u32"
      ? Cut8<S>
      : K extends "i16" | "u16"
        ? Cut4<S>
        : Cut2<S>;

/** A trimmed (or 17-nibble) nibble string, possibly longer than W, wrapped to kind W. */
type Wrap<K extends W, S extends string> = K extends "i64" | "u64" ? Trim<Take16<S>> : Fit<K, S>;

/** The low w/4 nibbles of A sign-extended with "f" (A negative): the w-bit pattern. */
type PadF<K extends W, A extends string> = K extends "i64" | "u64"
  ? Take16<`${A}ffffffffffffffff`>
  : K extends "i32" | "u32"
    ? Take8<`${A}fffffff`>
    : K extends "i16" | "u16"
      ? Take4<`${A}fff`>
      : Take2<`${A}f`>;
type Take2<S extends string> = S extends `${infer a}${infer b}${string}` ? `${a}${b}` : S;
type Take4<S extends string> = S extends `${infer a}${infer b}${infer c}${infer d}${string}`
  ? `${a}${b}${c}${d}`
  : S;
type Take8<S extends string> =
  S extends `${infer a}${infer b}${infer c}${infer d}${infer e}${infer f}${infer g}${infer h}${string}`
    ? `${a}${b}${c}${d}${e}${f}${g}${h}`
    : S;

/** Reverse a string (four characters per iteration when possible). */
type Rev<
  S extends string,
  O extends string,
> = S extends `${infer A}${infer B}${infer C}${infer D}${infer R}`
  ? Rev<R, `${D}${C}${B}${A}${O}`>
  : S extends `${infer H}${infer R}`
    ? Rev<R, `${H}${O}`>
    : O;

/** Strip trailing zero nibbles of an unsigned magnitude ("0" -> ""). */
type StripZ<S extends string> = S extends `${infer H}0` ? StripZ<H> : S;

/** Drop as many leading characters of S as K has. */
type Drop<S extends string, K extends string> = K extends `${string}${infer KR}`
  ? S extends `${string}${infer SR}`
    ? Drop<SR, KR>
    : ""
  : S;

// ---- addition and subtraction (64-bit) ----

/**
 * The end of an addition: digits O, last digit D, and F, the digit beyond
 * (the sum of the sign extensions and the carry). F is kept when it is not
 * just D's sign extension, unless that makes 17 nibbles (wraparound).
 */
type AddFin<O extends string, D extends string, F extends string> = T.EXT[D] extends F
  ? Cat<O, D>
  : Is16<`${O}${D}`> extends true
    ? Trim<`${O}${D}`>
    : `${O}${D}${F}`;

type AddL<
  A extends string,
  B extends string,
  C extends string,
  O extends string,
> = A extends `${infer a}${infer AR}`
  ? B extends `${infer b}${infer BR}`
    ? T.ADD[`${C}${a}${b}`] extends `${infer d}${infer c}`
      ? AR extends ""
        ? BR extends ""
          ? AddFin<O, d, T.ADDE[`${c}${T.EXT[a]}${T.EXT[b]}`]>
          : AddT<BR, T.EXT[a], c, `${O}${d}`>
        : BR extends ""
          ? AddT<AR, T.EXT[b], c, `${O}${d}`>
          : AddL<AR, BR, c, `${O}${d}`>
      : never
    : never
  : never;

/** The rest X of the longer operand, the other's sign extension E, carry C. */
type AddT<
  X extends string,
  E extends string,
  C extends string,
  O extends string,
> = `${C}${E}` extends "00" | "1f"
  ? Cat<O, X>
  : X extends `${infer x}${infer XR}`
    ? T.ADD[`${C}${x}${E}`] extends `${infer d}${infer c}`
      ? XR extends ""
        ? AddFin<O, d, T.ADDE[`${c}${T.EXT[x]}${E}`]>
        : AddT<XR, E, c, `${O}${d}`>
      : never
    : never;

type SubL<
  A extends string,
  B extends string,
  C extends string,
  O extends string,
> = A extends `${infer a}${infer AR}`
  ? B extends `${infer b}${infer BR}`
    ? T.SUB[`${C}${a}${b}`] extends `${infer d}${infer c}`
      ? AR extends ""
        ? BR extends ""
          ? AddFin<O, d, T.SUBE[`${c}${T.EXT[a]}${T.EXT[b]}`]>
          : SubTB<BR, T.EXT[a], c, `${O}${d}`>
        : BR extends ""
          ? SubTA<AR, T.EXT[b], c, `${O}${d}`>
          : SubL<AR, BR, c, `${O}${d}`>
      : never
    : never
  : never;

/** a - b past the end of b: the rest X of a, b's sign extension E, borrow C. */
type SubTA<
  X extends string,
  E extends string,
  C extends string,
  O extends string,
> = `${C}${E}` extends "00" | "1f"
  ? Cat<O, X>
  : X extends `${infer x}${infer XR}`
    ? T.SUB[`${C}${x}${E}`] extends `${infer d}${infer c}`
      ? XR extends ""
        ? AddFin<O, d, T.SUBE[`${c}${T.EXT[x]}${E}`]>
        : SubTA<XR, E, c, `${O}${d}`>
      : never
    : never;

/** a - b past the end of a: the rest X of b, a's sign extension E, borrow C. */
type SubTB<
  X extends string,
  E extends string,
  C extends string,
  O extends string,
> = `${C}${E}` extends "0f" | "10"
  ? Cat<O, NotL<X, "">>
  : X extends `${infer x}${infer XR}`
    ? T.SUB[`${C}${E}${x}`] extends `${infer d}${infer c}`
      ? XR extends ""
        ? AddFin<O, d, T.SUBE[`${c}${E}${T.EXT[x]}`]>
        : SubTB<XR, E, c, `${O}${d}`>
      : never
    : never;

/** a + b, 64-bit wrapping. */
type Add64<A extends string, B extends string> = A extends Nib
  ? B extends Nib
    ? T.ADD1[`${A}${B}`]
    : A extends "0"
      ? B
      : AddL<A, B, "0", "">
  : B extends "0"
    ? A
    : AddL<A, B, "0", "">;

/** a - b, 64-bit wrapping. */
type Sub64<A extends string, B extends string> = A extends Nib
  ? B extends Nib
    ? T.SUB1[`${A}${B}`]
    : SubL<A, B, "0", "">
  : B extends "0"
    ? A
    : SubL<A, B, "0", "">;

// Short paths. Forms of up to three nibbles (-2048..2047: indices, bytes,
// ast.Kind values) split into hi = floor(a / 16), a form of one or two
// nibbles, and lo = a & 15; the pair tables (int-pairs.gen.ts) then do the
// hi part in one lookup. Operands of one or two nibbles need no split.

/** 16 h + d for a nibble d and a canonical form h. */
type Join<D extends string, H extends string> = H extends "0"
  ? D extends PosNib
    ? D
    : `${D}0`
  : H extends "f"
    ? D extends NegNib
      ? D
      : `${D}f`
    : `${D}${H}`;

/** a + b for forms of up to three nibbles. */
type Add3<
  A extends string,
  B extends string,
> = T.ADD[`0${T.LO3[A]}${T.LO3[B]}`] extends `${infer d}${infer c}`
  ? Join<
      d,
      c extends "0" ? P.ADD2[`${T.HI3[A]}_${T.HI3[B]}`] : T.INC3[P.ADD2[`${T.HI3[A]}_${T.HI3[B]}`]]
    >
  : never;

/** a + b: one lookup for one or two nibbles, the split for three, then +-1 and up to six nibbles, else the loop. */
type AddS<A extends string, B extends string> = string extends P.ADD2[`${A}_${B}`]
  ? A extends keyof T.TODEC
    ? B extends keyof T.TODEC
      ? Add3<A, B>
      : AddM<A, B>
    : AddM<A, B>
  : P.ADD2[`${A}_${B}`];
/** Mid-size operands: a + 1, a - 1, and forms of up to six nibbles (loop counters, positions). */
type AddM<A extends string, B extends string> = B extends "1"
  ? Inc<A, "">
  : B extends "f"
    ? Dec1<A, "">
    : A extends "1"
      ? Inc<B, "">
      : Add6<A, B>;

/** a - b as a + (-b) on the short paths. */
type SubS<A extends string, B extends string> = B extends keyof T.NEG3
  ? string extends P.ADD2[`${A}_${T.NEG3[B]}`]
    ? A extends keyof T.TODEC
      ? T.NEG3[B] extends keyof T.TODEC
        ? Add3<A, T.NEG3[B]>
        : AddM<A, T.NEG3[B]>
      : AddM<A, T.NEG3[B]>
    : P.ADD2[`${A}_${T.NEG3[B]}`]
  : Sub64<A, B>;

// Mid-size forms (four to six nibbles: -2^23..2^23-1) split into three low
// nibbles and a high part of up to three nibbles, which takes the short
// paths: + is three nibble lookups and an Add3, < compares the high parts
// (Lt3) and then the low nibbles.

/** [n0, n1, n2, Hi] for forms of up to six nibbles (Hi canonical, up to three nibbles), else false. */
type Split6<A extends string> = A extends `${infer a0}${infer a1}${infer a2}${infer H}`
  ? H extends ""
    ? [a0, a1, a2, Ext<A>]
    : H extends keyof T.TODEC
      ? [a0, a1, a2, H]
      : false
  : A extends `${infer a0}${infer a1}${infer H}`
    ? H extends ""
      ? [a0, a1, Ext<A>, Ext<A>]
      : false
    : [A, Ext<A>, Ext<A>, Ext<A>];
type Add6<A extends string, B extends string> =
  Split6<A> extends [
    infer a0 extends string,
    infer a1 extends string,
    infer a2 extends string,
    infer AH extends string,
  ]
    ? Split6<B> extends [
        infer b0 extends string,
        infer b1 extends string,
        infer b2 extends string,
        infer BH extends string,
      ]
      ? Add6L<T.ADD[`0${a0}${b0}`], a1, a2, b1, b2, AH, BH>
      : Add64<A, B>
    : Add64<A, B>;
type Add6L<
  R0 extends string,
  a1 extends string,
  a2 extends string,
  b1 extends string,
  b2 extends string,
  AH extends string,
  BH extends string,
> = R0 extends `${infer d0}${infer c0}`
  ? T.ADD[`${c0}${a1}${b1}`] extends `${infer d1}${infer c1}`
    ? T.ADD[`${c1}${a2}${b2}`] extends `${infer d2}${infer c2}`
      ? Cat<`${d0}${d1}${d2}`, c2 extends "0" ? Add3<AH, BH> : Inc<Add3<AH, BH>, "">>
      : never
    : never
  : never;

/** a - 1 for canonical a (the borrow runs through low "0" nibbles), 64-bit wrapping like Inc. */
type Dec1<A extends string, O extends string> = A extends `${infer a}${infer R}`
  ? a extends "0"
    ? R extends ""
      ? `${O}f`
      : Dec1<R, `${O}f`>
    : R extends ""
      ? a extends "8"
        ? O extends "fffffffffffffff"
          ? `${O}7`
          : `${O}7f`
        : Trim<`${O}${PRED[a & keyof PRED]}`>
      : Cat<`${O}${PRED[a & keyof PRED]}`, R>
  : "f";
interface PRED {
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

/** a < b (a != b) for forms of up to six nibbles; Hi is HI3 (signed) or HIU3 (unsigned); else never. */
type Lt6<A extends string, B extends string, Hi extends Record<string, string>> =
  Split6<A> extends [
    infer a0 extends string,
    infer a1 extends string,
    infer a2 extends string,
    infer AH extends string,
  ]
    ? Split6<B> extends [
        infer b0 extends string,
        infer b1 extends string,
        infer b2 extends string,
        infer BH extends string,
      ]
      ? AH extends BH
        ? a2 extends b2
          ? a1 extends b1
            ? T.NLT[`${a0}${b0}`]
            : T.NLT[`${a1}${b1}`]
          : T.NLT[`${a2}${b2}`]
        : Lt3<AH, BH, Hi>
      : never
    : never;

/** a < b for forms of up to three nibbles; Hi is HI3 (signed) or HIU3 (unsigned). */
type Lt3<
  A extends string,
  B extends string,
  Hi extends Record<string, string>,
> = Hi[A] extends Hi[B] ? T.NLT[`${T.LO3[A]}${T.LO3[B]}`] : P.LT2[`${Hi[A]}_${Hi[B]}`];

/** a + 1 for canonical a (the carry runs through low "f" nibbles). */
type Inc<A extends string, O extends string> = A extends `${infer a}${infer R}`
  ? a extends "f"
    ? Inc<R, `${O}0`>
    : R extends ""
      ? a extends "7"
        ? O extends "000000000000000"
          ? `${O}8`
          : `${O}80`
        : `${O}${T.SUCC[a]}`
      : Cat<`${O}${T.SUCC[a]}`, R>
  : "0";

/** -a, 64-bit wrapping. */
type Neg64<A extends string> = A extends keyof T.NEG3 ? T.NEG3[A] : Inc<NotL<A, "">, "">;

// ---- bitwise ----

type NotL<
  A extends string,
  O extends string,
> = A extends `${infer a}${infer b}${infer c}${infer d}${infer R}`
  ? NotL<R, `${O}${T.NOT[a]}${T.NOT[b]}${T.NOT[c]}${T.NOT[d]}`>
  : A extends `${infer a}${infer R}`
    ? NotL<R, `${O}${T.NOT[a]}`>
    : O;

type Not64<A extends string> = A extends keyof T.TODEC ? T.NOT3[A] : NotL<A, "">;

type AndL<A extends string, B extends string, O extends string> = A extends `${infer a}${infer AR}`
  ? B extends `${infer b}${infer BR}`
    ? AR extends ""
      ? BR extends ""
        ? Cat<O, T.AND[`${a}${b}`]>
        : T.EXT[a] extends "0"
          ? Cat<O, T.AND[`${a}${b}`]>
          : Cat<`${O}${T.AND[`${a}${b}`]}`, BR>
      : BR extends ""
        ? T.EXT[b] extends "0"
          ? Cat<O, T.AND[`${a}${b}`]>
          : Cat<`${O}${T.AND[`${a}${b}`]}`, AR>
        : AndL<AR, BR, `${O}${T.AND[`${a}${b}`]}`>
    : never
  : never;

type OrL<A extends string, B extends string, O extends string> = A extends `${infer a}${infer AR}`
  ? B extends `${infer b}${infer BR}`
    ? AR extends ""
      ? BR extends ""
        ? Cat<O, T.OR[`${a}${b}`]>
        : T.EXT[a] extends "f"
          ? Cat<O, T.OR[`${a}${b}`]>
          : Cat<`${O}${T.OR[`${a}${b}`]}`, BR>
      : BR extends ""
        ? T.EXT[b] extends "f"
          ? Cat<O, T.OR[`${a}${b}`]>
          : Cat<`${O}${T.OR[`${a}${b}`]}`, AR>
        : OrL<AR, BR, `${O}${T.OR[`${a}${b}`]}`>
    : never
  : never;

type XorL<A extends string, B extends string, O extends string> = A extends `${infer a}${infer AR}`
  ? B extends `${infer b}${infer BR}`
    ? AR extends ""
      ? BR extends ""
        ? Cat<O, T.XOR[`${a}${b}`]>
        : Cat<`${O}${T.XOR[`${a}${b}`]}`, T.EXT[a] extends "0" ? BR : NotL<BR, "">>
      : BR extends ""
        ? Cat<`${O}${T.XOR[`${a}${b}`]}`, T.EXT[b] extends "0" ? AR : NotL<AR, "">>
        : XorL<AR, BR, `${O}${T.XOR[`${a}${b}`]}`>
    : never
  : never;

/** A nibble table applied to the 12-bit patterns of two forms of up to three nibbles. */
type Bit3<
  Tab extends Record<string, string>,
  A extends string,
  B extends string,
> = T.RAW3[`${Tab[`${T.LO3[A]}${T.LO3[B]}`]}${Tab[`${T.N1[A]}${T.N1[B]}`]}${Tab[`${T.N2[A]}${T.N2[B]}`]}`];

/** Whether both operands are forms of up to three nibbles. */
type Both3<A extends string, B extends string> = A extends keyof T.TODEC
  ? B extends keyof T.TODEC
    ? true
    : false
  : false;

type And64<A extends string, B extends string> =
  Both3<A, B> extends true ? Bit3<T.AND, A, B> : AndL<A, B, "">;

// ---- shifts (64-bit) ----

/** A shifted left r (1..3) bits, P being the nibble below; then the extension nibble. */
type ShlBits<
  A extends string,
  R extends string,
  P extends string,
  O extends string,
> = A extends `${infer a}${infer AR}`
  ? ShlBits<AR, R, a, `${O}${T.SHL[`${R}${P}${a}`]}`>
  : `${O}${T.SHL[`${R}${P}${T.EXT[P]}`]}`;

/**
 * A shifted right r (1..3) bits, P being the nibble below; zeros come in at
 * the top (or copies of the sign bit when Arith is true).
 */
type ShrBits<
  A extends string,
  R extends string,
  P extends string,
  O extends string,
  Arith extends boolean,
> = A extends `${infer a}${infer AR}`
  ? ShrBits<AR, R, a, `${O}${T.SHR[`${R}${P}${a}`]}`, Arith>
  : `${O}${T.SHR[`${R}${P}${Arith extends true ? T.EXT[P] : "0"}`]}`;

/** a << 4 q + r for 0 <= 4 q + r < 64, 64-bit. */
type ShlL<A extends string, Q extends string, R extends string> = Trim<
  Take16<`${T.ZEROS[Q]}${R extends "0" ? A : ShlBits<A, R, "0", "">}`>
>;

/** The 64-bit pattern of a, shifted right 4 q + r bits logically (0 <= 4 q + r < 64). */
type ShrBy<A extends string, Q extends string, R extends string> =
  Drop<A extends NegForm ? Take16<`${A}ffffffffffffffff`> : A, T.ZEROS[Q]> extends infer S extends
    string
    ? S extends `${infer s}${infer SR}`
      ? Trim<`${R extends "0" ? S : ShrBits<SR, R, s, "", false>}0`>
      : "0"
    : never;

/** a >> 4 q + r, arithmetic (floor(a / 2^n)), for 0 <= 4 q + r < 64. */
type SarL<A extends string, Q extends string, R extends string> =
  Drop<A, T.ZEROS[Q]> extends infer S extends string
    ? S extends `${infer s}${infer SR}`
      ? R extends "0"
        ? S
        : Trim<ShrBits<SR, R, s, "", true>>
      : Ext<A>
    : never;

/** Short counts for forms of up to three nibbles: ZEROS[q] then four nibbles stay within 16. */
type ShortQ = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "a" | "b" | "c";

/** a << 4 q + r (64-bit), one lookup for forms of up to three nibbles. */
type ShlBy<A extends string, Q extends string, R extends string> = A extends "0"
  ? "0"
  : A extends keyof T.TODEC
    ? Q extends ShortQ
      ? `${T.ZEROS[Q]}${R extends "0" ? A : T.SHL3[`${A}_${R}`]}`
      : ShlL<A, Q, R>
    : ShlL<A, Q, R>;

/** a >> r bits (r 0..3) for a form of up to three nibbles. */
type Sar3<A extends string, R extends string> = R extends "0" ? A : T.SAR3[`${A}_${R}`];

/** a >> 4 q + r, arithmetic, with table steps for forms of up to three nibbles. */
type SarBy<A extends string, Q extends string, R extends string> = A extends keyof T.TODEC
  ? Q extends "0"
    ? Sar3<A, R>
    : Q extends "1"
      ? Sar3<T.HI3[A], R>
      : Q extends "2"
        ? Sar3<T.HI3[T.HI3[A]], R>
        : Ext<A>
  : SarL<A, Q, R>;

// ---- comparison (64-bit) ----
//
// Canonical forms of one sign are ordered by length first (longer is further
// from zero), then by the highest differing nibble, compared unsigned (the
// sign nibble included). Unsigned order differs only across signs.

/** Walk both: "A" or "B" when that one is longer, else the verdict of the highest differing nibble. */
type CmpL<A extends string, B extends string, F extends string> = A extends `${infer a}${infer AR}`
  ? B extends `${infer b}${infer BR}`
    ? CmpL<AR, BR, a extends b ? F : T.ULT[`${a}${b}`]>
    : "A"
  : B extends ""
    ? F
    : "B";

/** a < b for a != b of the same sign extension S. */
type LtSame<A extends string, B extends string, S extends string> =
  CmpL<A, B, "="> extends infer F
    ? F extends "A"
      ? S extends "f"
        ? true
        : false
      : F extends "B"
        ? S extends "0"
          ? true
          : false
        : F extends "<"
          ? true
          : false
    : never;

/** a < b for a != b, signed (U false) or unsigned (U true). */
type LtG<A extends string, B extends string, U extends boolean> =
  Ext<A> extends infer SA extends string
    ? SA extends Ext<B>
      ? LtSame<A, B, SA>
      : SA extends "f"
        ? U extends true
          ? false
          : true
        : U
    : never;

type LtS<A extends string, B extends string> = A extends keyof T.TODEC
  ? B extends keyof T.TODEC
    ? Lt3<A, B, T.HI3>
    : LtM<A, B, false, T.HI3>
  : A extends B
    ? false
    : LtM<A, B, false, T.HI3>;

type LtU<A extends string, B extends string> = A extends keyof T.TODEC
  ? B extends keyof T.TODEC
    ? Lt3<A, B, T.HIU3>
    : LtM<A, B, true, T.HIU3>
  : A extends B
    ? false
    : LtM<A, B, true, T.HIU3>;
/** a < b (a != b): the six-nibble split, else the loop. */
type LtM<A extends string, B extends string, U extends boolean, Hi extends Record<string, string>> =
  Lt6<A, B, Hi> extends infer R extends boolean ? ([R] extends [never] ? LtG<A, B, U> : R) : never;

// ---- unsigned magnitudes ----

/** u + 1. */
type UInc<U extends string, O extends string> = U extends `${infer x}${infer R}`
  ? x extends "f"
    ? UInc<R, `${O}0`>
    : `${O}${T.SUCC[x]}${R}`
  : `${O}1`;

/** [negative, |a|] of a canonical form as a signed value (|MinInt64| = 2^63 is 16 nibbles). */
type ToMag<A extends string> = A extends NegForm
  ? [true, UInc<StripZ<NotL<A, "">>, "">]
  : [false, A extends `${infer H}0` ? H : A];

/** The unsigned value of A's w-bit pattern as a magnitude (no trailing zeros). */
type UMag<K extends W, A extends string> = A extends NegForm
  ? PadF<K, A>
  : A extends `${infer H}0`
    ? H
    : A;

/** The integer -u (Neg true) or u, for |result| <= 2^63 (64-bit wrapping of 2^63). */
type FromS<N, U extends string> =
  Trim<Take16<`${U}0`>> extends infer P extends string ? (N extends true ? Neg64<P> : P) : never;

/** The integer -u (N true) or u for u < 2^63 (quotients and remainders: no wraparound). */
type FromD<N, U extends string> =
  Trim<`${U}0`> extends infer P extends string ? (N extends true ? Neg64<P> : P) : never;

/** The kind-K form of magnitude u < 2^w. */
type FromU<K extends W, U extends string> = Wrap<K, Trim<`${U}0`>>;

type UAdd<
  X extends string,
  Y extends string,
  C extends string,
  O extends string,
> = X extends `${infer x}${infer XR}`
  ? Y extends `${infer y}${infer YR}`
    ? T.ADD[`${C}${x}${y}`] extends `${infer d}${infer c}`
      ? UAdd<XR, YR, c, `${O}${d}`>
      : never
    : C extends "0"
      ? `${O}${X}`
      : T.ADD[`1${x}0`] extends `${infer d}${infer c}`
        ? UAdd<XR, "", c, `${O}${d}`>
        : never
  : Y extends ""
    ? C extends "0"
      ? O
      : `${O}1`
    : C extends "0"
      ? `${O}${Y}`
      : UAdd<Y, "", C, O>;

/** x - y with trailing zeros stripped, or false when x < y (x, y without trailing zeros). */
type USub<
  X extends string,
  Y extends string,
  C extends string,
  O extends string,
> = X extends `${infer x}${infer XR}`
  ? Y extends `${infer y}${infer YR}`
    ? T.SUB[`${C}${x}${y}`] extends `${infer d}${infer c}`
      ? USub<XR, YR, c, `${O}${d}`>
      : never
    : C extends "0"
      ? `${O}${X}`
      : T.SUB[`1${x}0`] extends `${infer d}${infer c}`
        ? USub<XR, "", c, `${O}${d}`>
        : never
  : Y extends ""
    ? C extends "0"
      ? StripZ<O>
      : false
    : false;

// ---- multiplication (64-bit) ----

/** x * y + acc for one nibble y (acc is at most as long as x). */
type MulRow<
  X extends string,
  Y extends string,
  Acc extends string,
  C extends string,
  O extends string,
> = X extends `${infer a}${infer XR}`
  ? T.MULC[`${a}${Y}${C}`] extends `${infer lo}${infer hi}`
    ? Acc extends `${infer x}${infer AR}`
      ? T.ADDH[`${lo}${x}${hi}`] extends `${infer d}${infer c}`
        ? MulRow<XR, Y, AR, c, `${O}${d}`>
        : never
      : MulRow<XR, Y, "", hi, `${O}${lo}`>
    : never
  : C extends "0"
    ? O
    : `${O}${C}`;

/** Schoolbook x * y: one row per nibble of y; each row's low nibble is final. */
type UMul<
  X extends string,
  Y extends string,
  Acc extends string,
  Out extends string,
> = Y extends `${infer y}${infer YR}`
  ? (y extends "0" ? Acc : MulRow<X, y, Acc, "0", "">) extends `${infer r}${infer RR}`
    ? UMul<X, YR, RR, `${Out}${r}`>
    : UMul<X, YR, "", `${Out}0`>
  : `${Out}${Acc}`;

type Mul64<A extends string, B extends string> = string extends T.MUL1[`${A}${B}`]
  ? Short<A, B> extends true
    ? Mul3<A, B>
    : Short<B, A> extends true
      ? Mul3<B, A>
      : MulG<A, B>
  : T.MUL1[`${A}${B}`];

/**
 * a * b for |a| < 2048 and |b| < 16: the product fits 16 signed bits, so it
 * is one multiply row over the 16-bit pattern of a (or of -a when b < 0).
 */
type Mul3<A extends string, B extends string> = MRow<
  T.SGN3[B] extends "-" ? T.NEGX[A] : A,
  T.DMAGX[B]
>;
type MRow<X extends string, D extends string> = M0<T.MULC[`${T.LO3[X]}${D}0`], X, D>;
type M0<P extends string, X extends string, D extends string> = P extends `${infer lo}${infer hi}`
  ? M1<T.MULC[`${T.N1[X]}${D}${hi}`], lo, X, D>
  : never;
type M1<
  P extends string,
  R0 extends string,
  X extends string,
  D extends string,
> = P extends `${infer lo}${infer hi}` ? M2<T.MULC[`${T.N2[X]}${D}${hi}`], R0, lo, X, D> : never;
type M2<
  P extends string,
  R0 extends string,
  R1 extends string,
  X extends string,
  D extends string,
> = P extends `${infer lo}${infer hi}`
  ? M3<T.MULC[`${T.EXT[T.N2[X]]}${D}${hi}`], R0, R1, lo>
  : never;
type M3<
  P extends string,
  R0 extends string,
  R1 extends string,
  R2 extends string,
> = P extends `${infer lo}${string}` ? Trim4<R0, R1, R2, lo> : never;

/** The canonical form of a 16-bit pattern r0..r3 read as signed. */
type Trim4<
  R0 extends string,
  R1 extends string,
  R2 extends string,
  R3 extends string,
> = T.EXT[R2] extends R3
  ? T.EXT[R1] extends R2
    ? T.EXT[R0] extends R1
      ? R0
      : `${R0}${R1}`
    : `${R0}${R1}${R2}`
  : `${R0}${R1}${R2}${R3}`;

type MulG<A extends string, B extends string> = B extends keyof T.POW2
  ? T.POW2[B] extends `${infer q}${infer r}`
    ? ShlBy<A, q, r>
    : never
  : A extends keyof T.POW2
    ? T.POW2[A] extends `${infer q}${infer r}`
      ? ShlBy<B, q, r>
      : never
    : MulN<A, B>;

type MulN<A extends string, B extends string> = A extends "0"
  ? "0"
  : B extends "0"
    ? "0"
    : A extends "1"
      ? B
      : B extends "1"
        ? A
        : A extends "f"
          ? Neg64<B>
          : B extends "f"
            ? Neg64<A>
            : ToMag<A> extends [infer NA, infer UA extends string]
              ? ToMag<B> extends [infer NB, infer UB extends string]
                ? FromS<NA extends NB ? false : true, UMul<UA, UB, "", "">>
                : never
              : never;

// ---- division of magnitudes ----

/** Short division by one nibble d, most significant nibble first: [quotient, remainder]. */
type ShortDiv<
  N extends string,
  D extends string,
  R extends string,
  Q extends string,
> = N extends `${infer n}${infer NR}`
  ? T.DIV1[`${R}${n}${D}`] extends `${infer q}${infer r}`
    ? ShortDiv<NR, D, r, Q extends "" ? (q extends "0" ? "" : q) : `${q}${Q}`>
    : never
  : [Q, R extends "0" ? "" : R];

/** { 1: d, 2: 2 d, 4: 4 d, 8: 8 d }. */
type Mults<D extends string> =
  UAdd<D, D, "0", ""> extends infer D2 extends string
    ? UAdd<D2, D2, "0", ""> extends infer D4 extends string
      ? UAdd<D4, D4, "0", ""> extends infer D8 extends string
        ? { "1": D; "2": D2; "4": D4; "8": D8 }
        : never
      : never
    : never;

interface NextStep {
  "8": "4";
  "4": "2";
  "2": "1";
  "1": "";
}

/** The quotient nibble of r / d (r < 16 d), restoring one bit at a time: [q, r - q d]. */
type FindQ<
  R extends string,
  Ms extends Record<"1" | "2" | "4" | "8", string>,
  Q extends string,
  Step extends string,
> = Step extends keyof NextStep
  ? USub<R, Ms[Step], "0", ""> extends infer S extends string
    ? FindQ<S, Ms, T.OR[`${Q}${Step}`], NextStep[Step]>
    : FindQ<R, Ms, Q, NextStep[Step]>
  : [Q, R];

/** Long division, most significant nibble of n first: [quotient, remainder]. */
type LongDiv<
  N extends string,
  Ms extends Record<"1" | "2" | "4" | "8", string>,
  R extends string,
  Q extends string,
> = N extends `${infer n}${infer NR}`
  ? FindQ<R extends "" ? (n extends "0" ? "" : n) : `${n}${R}`, Ms, "0", "8"> extends [
      infer q extends string,
      infer R2 extends string,
    ]
    ? LongDiv<NR, Ms, R2, Q extends "" ? (q extends "0" ? "" : q) : `${q}${Q}`>
    : never
  : [Q, R];

/**
 * Long division after moving the top len(d) - 1 nibbles of n (most
 * significant first) into the remainder: they are below d, so no trials.
 */
type PrimeDiv<
  N extends string,
  K extends string,
  D extends string,
  R extends string,
> = K extends `${string}${infer KR}`
  ? KR extends ""
    ? LongDiv<N, Mults<D>, R, "">
    : N extends `${infer n}${infer NR}`
      ? PrimeDiv<NR, KR, D, `${n}${R}`>
      : ["", R]
  : never;

/** [n / d, n % d] of magnitudes (d nonzero, no trailing zeros). */
type UDivMod<N extends string, D extends string> = D extends Nib
  ? ShortDiv<Rev<N, "">, D, "0", "">
  : PrimeDiv<Rev<N, "">, D, D, "">;

type Fst<X> = X extends [infer F, unknown] ? F : never;
type Snd<X> = X extends [unknown, infer S] ? S : never;

/** Short division of a form n < 2048 by a nibble d, most significant nibble first: [n / d, n % d]. */
type QR3<N extends string, D extends string> = QStep2<
  T.DIV1[`0${T.LO3[T.HI3[T.HI3[N]]]}${D}`],
  N,
  D
>;
type QStep2<X extends string, N extends string, D extends string> = X extends `${infer q}${infer r}`
  ? QStep1<T.DIV1[`${r}${T.LO3[T.HI3[N]]}${D}`], q, N, D>
  : never;
type QStep1<
  X extends string,
  Q extends string,
  N extends string,
  D extends string,
> = X extends `${infer q}${infer r}` ? QStep0<T.DIV1[`${r}${T.LO3[N]}${D}`], `${q}${Q}`> : never;
type QStep0<X extends string, Q extends string> = X extends `${infer q}${infer r}`
  ? [T.MAG3[`${q}${Q}`], T.MAG3[`${r}00`]]
  : never;

/** [a / b, a % b] for |a| < 2048 and |b| < 16: signs SA, SB ("-" or "+"), |a| AA, |b| D. */
type QRS3<SA extends string, SB extends string, AA extends string, D extends string> =
  QR3<AA, D> extends [infer Q extends string, infer R extends string]
    ? [`${SA}${SB}` extends "-+" | "+-" ? T.NEGX[Q] : Q, SA extends "-" ? T.NEGX[R] : R]
    : never;

/** Whether the short division applies: |a| < 2048 (not -2048) and 0 < |b| < 16. */
type Short<A extends string, B extends string> = A extends keyof T.NEG3
  ? B extends keyof T.DMAG
    ? true
    : false
  : false;

/** [a / b, a % b] signed, truncated (b is not 0). */
type QuoRemS<A extends string, B extends string> =
  Short<A, B> extends true ? QRS3<T.SGN3[A], T.SGN3[B], T.ABS3[A], T.DMAGX[B]> : QuoRemSG<A, B>;

type QuoRemSG<A extends string, B extends string> =
  ToMag<A> extends [infer NA, infer UA extends string]
    ? ToMag<B> extends [infer NB, infer UB extends string]
      ? UDivMod<UA, UB> extends [infer Q extends string, infer R extends string]
        ? [FromD<NA extends NB ? false : true, Q>, FromD<NA, R>]
        : never
      : never
    : never;

/** [a / b, a % b] unsigned of kind K (b is not 0). */
type QuoRemU<K extends W, A extends string, B extends string> =
  Short<A, B> extends true
    ? `${T.SGN3[A]}${T.SGN3[B]}` extends "++"
      ? QR3<A, T.DMAGX[B]>
      : QuoRemUG<K, A, B>
    : QuoRemUG<K, A, B>;

type QuoRemUG<K extends W, A extends string, B extends string> =
  UDivMod<UMag<K, A>, UMag<K, B>> extends [infer Q extends string, infer R extends string]
    ? [FromU<K, Q>, FromU<K, R>]
    : never;

// ---- decimal ----

/** 16 d + c on decimal digits (least significant first); c is a nibble. */
type Mul16<D extends string, C extends string, O extends string> = D extends `${infer x}${infer DR}`
  ? T.D16[`${x}${C}`] extends `${infer d}${infer c}`
    ? Mul16<DR, c, `${O}${d}`>
    : never
  : `${O}${T.CDEC[C]}`;

/** Horner's rule over nibbles, most significant first: decimal digits, least significant first. */
type DecL<H extends string, D extends string> = H extends `${infer h}${infer HR}`
  ? Mul16<D, h, ""> extends infer D2 extends string
    ? DecL<HR, D2>
    : never
  : D;

/** The decimal digits of a magnitude ("" is "0"). */
type MagDec<U extends string> =
  Rev<DecL<Rev<U, "">, "">, ""> extends infer S extends string ? (S extends "" ? "0" : S) : never;

// =============================================================== the API

/** a + b. */
export type Add<K extends W, A extends string, B extends string> = Fit<K, AddS<A, B>>;
/** a - b. */
export type Sub<K extends W, A extends string, B extends string> = Fit<K, SubS<A, B>>;
/** a * b. */
export type Mul<K extends W, A extends string, B extends string> = Fit<K, Mul64<A, B>>;

/** a / b, truncated; MinInt / -1 is MinInt; `DivZero` when b is 0. */
export type Quo<K extends W, A extends string, B extends string> = B extends "0"
  ? DivZero
  : K extends US
    ? QuoU<K, A, B>
    : QuoS<K, A, B>;

type QuoS<K extends W, A extends string, B extends string> = string extends T.QUO1[`${A}${B}`]
  ? Short<A, B> extends true
    ? Fit<K, Fst<QuoRemS<A, B>>>
    : QuoSG<K, A, B>
  : T.QUO1[`${A}${B}`];

type QuoSG<K extends W, A extends string, B extends string> = B extends "1"
  ? A
  : B extends "f"
    ? Fit<K, Neg64<A>>
    : B extends keyof T.POW2
      ? T.POW2[B] extends `${infer q}${infer r}`
        ? A extends NegForm
          ? SarBy<Add64<A, T.POW2M1[B]>, q, r>
          : SarBy<A, q, r>
        : never
      : Fst<QuoRemS<A, B>>;

type QuoU<K extends W, A extends string, B extends string> =
  Short<A, B> extends true
    ? `${T.SGN3[A]}${T.SGN3[B]}` extends "++"
      ? Fst<QR3<A, T.DMAGX[B]>>
      : QuoUG<K, A, B>
    : QuoUG<K, A, B>;

type QuoUG<K extends W, A extends string, B extends string> = B extends "1"
  ? A
  : B extends keyof T.POW2
    ? T.POW2[B] extends `${infer q}${infer r}`
      ? A extends NegForm
        ? ShrU<K, A, q, r>
        : SarBy<A, q, r>
      : never
    : Fst<QuoRemU<K, A, B>>;

/** a % b, with the sign of a; MinInt % -1 is 0; `DivZero` when b is 0. */
export type Rem<K extends W, A extends string, B extends string> = B extends "0"
  ? DivZero
  : K extends US
    ? RemU<K, A, B>
    : RemS<A, B>;

type RemS<A extends string, B extends string> = string extends T.REM1[`${A}${B}`]
  ? Short<A, B> extends true
    ? Snd<QuoRemS<A, B>>
    : RemSG<A, B>
  : T.REM1[`${A}${B}`];

type RemSG<A extends string, B extends string> = B extends "1" | "f"
  ? "0"
  : B extends keyof T.POW2
    ? A extends NegForm
      ? Snd<QuoRemS<A, B>>
      : AndL<A, T.POW2M1[B], "">
    : Snd<QuoRemS<A, B>>;

type RemU<K extends W, A extends string, B extends string> =
  Short<A, B> extends true
    ? `${T.SGN3[A]}${T.SGN3[B]}` extends "++"
      ? Snd<QR3<A, T.DMAGX[B]>>
      : RemUG<K, A, B>
    : RemUG<K, A, B>;

type RemUG<K extends W, A extends string, B extends string> = B extends "1"
  ? "0"
  : B extends keyof T.POW2
    ? AndL<A, T.POW2M1[B], "">
    : Snd<QuoRemU<K, A, B>>;

/** a & b. */
export type And<_K extends W, A extends string, B extends string> = And64<A, B>;
/** a | b. */
export type Or<_K extends W, A extends string, B extends string> =
  Both3<A, B> extends true ? Bit3<T.OR, A, B> : OrL<A, B, "">;
/** a ^ b. */
export type Xor<_K extends W, A extends string, B extends string> =
  Both3<A, B> extends true ? Bit3<T.XOR, A, B> : XorL<A, B, "">;
/** a &^ b (and not). */
export type AndNot<_K extends W, A extends string, B extends string> = And64<A, Not64<B>>;

/** -a (wrapping: -MinInt is MinInt). */
export type Neg<K extends W, A extends string> = Fit<K, Neg64<A>>;
/** ^a (bitwise complement; never needs a cut). */
export type Not<_K extends W, A extends string> = Not64<A>;

/**
 * a << c. CK is the kind of the count c (only its signedness matters): a
 * negative signed count is `NegShift`; a count >= the width gives "0".
 */
export type Shl<
  K extends W,
  A extends string,
  CK extends W,
  C extends string,
> = C extends keyof T.SHAMT
  ? A extends "0"
    ? "0"
    : T.SHAMT[C] extends `${infer q}${infer r}`
      ? Fit<K, ShlBy<A, q, r>>
      : never
  : C extends NegForm
    ? CK extends US
      ? "0"
      : NegShift
    : "0";

/**
 * a >> c: arithmetic for signed K, logical for unsigned K. CK is the kind of
 * the count: a negative signed count is `NegShift`; a count >= the width
 * gives the sign fill ("f" or "0") for signed K and "0" for unsigned K.
 */
export type Shr<K extends W, A extends string, CK extends W, C extends string> = C extends "0"
  ? A
  : C extends keyof T.SHAMT
    ? T.SHAMT[C] extends `${infer q}${infer r}`
      ? K extends US
        ? A extends NegForm
          ? ShrU<K, A, q, r>
          : SarBy<A, q, r>
        : SarBy<A, q, r>
      : never
    : C extends NegForm
      ? CK extends US
        ? ShrBig<K, A>
        : NegShift
      : ShrBig<K, A>;

type ShrBig<K extends W, A extends string> = K extends US ? "0" : Ext<A>;

/** The w-bit pattern of negative-looking a shifted right logically by 4 q + r > 0 bits. */
type ShrU<K extends W, A extends string, Q extends string, R extends string> = K extends "u64"
  ? ShrBy<A, Q, R>
  : SarBy<`${PadF<K, A>}0`, Q, R>;

/** a == b. */
export type Eq<A extends string, B extends string> = A extends B ? true : false;
/** a != b. */
export type Ne<A extends string, B extends string> = A extends B ? false : true;
/** a < b. */
export type Lt<K extends W, A extends string, B extends string> = K extends US
  ? LtU<A, B>
  : LtS<A, B>;
/** a <= b. */
export type Le<K extends W, A extends string, B extends string> = A extends B
  ? true
  : K extends US
    ? LtU<A, B>
    : LtS<A, B>;
/** a > b. */
export type Gt<K extends W, A extends string, B extends string> = Lt<K, B, A>;
/** a >= b. */
export type Ge<K extends W, A extends string, B extends string> = Le<K, B, A>;

/** The kind-To value of a kind-From value a (truncate, sign- or zero-extend as Go does). */
export type Conv<
  From extends W,
  To extends W,
  A extends string,
> = T.CONV[`${From}${To}`] extends "="
  ? A
  : T.CONV[`${From}${To}`] extends "z"
    ? ZExt<From, A>
    : Fit<To, A>;

/** a of unsigned kind K < 64 bits zero-extended (into any wider kind). */
export type ZExt<K extends W, A extends string> = A extends NegForm ? `${PadF<K, A>}0` : A;

/** The decimal string of a (`print`, `strconv`; "-" for negative signed values). */
export type ToDec<K extends W, A extends string> = A extends keyof T.TODEC
  ? K extends US
    ? A extends NegForm
      ? UDec<K, A>
      : T.TODEC[A]
    : T.TODEC[A]
  : K extends US
    ? A extends NegForm
      ? UDec<K, A>
      : MagDec<UMag<K, A>>
    : ToMag<A> extends [infer N, infer U extends string]
      ? `${N extends true ? "-" : ""}${MagDec<U>}`
      : never;

type UDec<K extends W, A extends string> = K extends "u8"
  ? A extends keyof T.UDEC8
    ? T.UDEC8[A]
    : never
  : MagDec<UMag<K, A>>;

/**
 * a as a tuple index key: its decimal string ("0", "12", "-1" for negative
 * signed values; huge unsigned values are long decimals). An index is in
 * range for a tuple X when the key is in `keyof X`; the string is also the
 * `[i]` of Go's "index out of range" message.
 */
export type ToIndex<K extends W, A extends string> = ToDec<K, A>;

/** a == 0. */
export type IsZero<A extends string> = A extends "0" ? true : false;
/** a < 0 (always false for unsigned K). */
export type IsNeg<K extends W, A extends string> = K extends US
  ? false
  : A extends NegForm
    ? true
    : false;
/** The sign of a: -1, 0 or 1 as "-", "0" or "+" (unsigned K is never "-"). */
export type Sign<K extends W, A extends string> = A extends "0"
  ? "0"
  : K extends US
    ? "+"
    : A extends NegForm
      ? "-"
      : "+";
