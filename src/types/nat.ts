// Non-negative integer arithmetic for the heap: slot indices, lengths,
// capacities and the growslice formula. Values are in the stage 4 int
// encoding (docs/DESIGN.md "Type-level encodings"): lowercase hex nibbles,
// least significant first, shortest two's complement ("0", "80" for 8,
// "01" for 16, "f" for -1). Everything here assumes operands >= 0 unless an
// alias says otherwise (IsNeg, ZExt); src/types/int.ts (stage4-ints) is the
// general integer library. This file is heap-owned so the heap does not
// wait on it; the two agree on every value because the encoding is canonical.
//
// Internally, "U" strings are unsigned magnitudes: nibbles least
// significant first, no sign nibble; zero is "". Tables: heap.gen.ts.
import type { AddT, Class128, Class8, CmpT, DecD, IncD, MulT, ShrT, SubT } from "./heap.gen.ts";

type HighNib = "8" | "9" | "a" | "b" | "c" | "d" | "e" | "f";

/** Strip trailing zero nibbles of a U string. */
type Strip<S extends string> = S extends `${infer H}0` ? Strip<H> : S;
/** Canonical (>= 0) -> U. */
export type ToU<C extends string> = Strip<C>;
/** U -> canonical (adds the sign nibble when the top nibble is >= 8). */
export type FromU<U extends string> = U extends ""
  ? "0"
  : U extends `${string}${HighNib}`
    ? `${U}0`
    : U;

/** Whether a canonical int is negative (as a signed 64-bit pattern). */
export type IsNeg<C extends string> = C extends `${string}${HighNib}` ? true : false;

// ---- U arithmetic

type AddU<
  A extends string,
  B extends string,
  C extends string = "0",
  O extends string = "",
> = A extends `${infer a}${infer AR}`
  ? B extends `${infer b}${infer BR}`
    ? AddT[`${a}${b}${C}`] extends `${infer s}${infer c}`
      ? AddU<AR, BR, c, `${O}${s}`>
      : never
    : C extends "0"
      ? `${O}${A}`
      : AddT[`${a}0${C}`] extends `${infer s}${infer c}`
        ? AddU<AR, "", c, `${O}${s}`>
        : never
  : B extends ""
    ? C extends "1"
      ? `${O}1`
      : O
    : AddU<B, "", C, O>;

/** A - B for A >= B (result may have trailing zeros). */
type SubU<
  A extends string,
  B extends string,
  C extends string = "0",
  O extends string = "",
> = A extends `${infer a}${infer AR}`
  ? B extends `${infer b}${infer BR}`
    ? SubT[`${a}${b}${C}`] extends `${infer s}${infer c}`
      ? SubU<AR, BR, c, `${O}${s}`>
      : never
    : C extends "0"
      ? `${O}${A}`
      : SubT[`${a}0${C}`] extends `${infer s}${infer c}`
        ? SubU<AR, "", c, `${O}${s}`>
        : never
  : O;

/** Compare stripped U strings: "<", "=" or ">". */
type CmpU<
  A extends string,
  B extends string,
  R extends string = "=",
> = A extends `${infer a}${infer AR}`
  ? B extends `${infer b}${infer BR}`
    ? CmpU<AR, BR, CmpT[`${a}${b}`] extends "=" ? R : CmpT[`${a}${b}`]>
    : ">"
  : B extends ""
    ? R
    : "<";

/** U times one digit. */
type MulD<
  A extends string,
  D extends string,
  C extends string = "0",
  O extends string = "",
> = A extends `${infer a}${infer AR}`
  ? MulT[`${a}${D}${C}`] extends `${infer lo}${infer hi}`
    ? MulD<AR, D, hi, `${O}${lo}`>
    : never
  : C extends "0"
    ? O
    : `${O}${C}`;

type MulU<
  A extends string,
  B extends string,
  Acc extends string = "",
  Sh extends string = "",
> = B extends `${infer b}${infer BR}`
  ? b extends "0"
    ? MulU<A, BR, Acc, `${Sh}0`>
    : MulU<A, BR, AddU<Acc, `${Sh}${MulD<A, b>}`>, `${Sh}0`>
  : Acc;

/** U >> bits (bits "1".."3"). */
type ShrU<
  U extends string,
  B extends string,
  O extends string = "",
> = U extends `${infer x}${infer R}`
  ? ShrU<R, B, `${O}${ShrT[`${B}${x}${R extends `${infer y}${string}` ? y : "0"}`]}`>
  : Strip<O>;

/** U >> 4k: drop k nibbles. */
type Drop1<U extends string> = U extends `${string}${infer R}` ? R : "";

type Rev<S extends string, O extends string = ""> = S extends `${infer H}${infer R}`
  ? Rev<R, `${H}${O}`>
  : O;

/** Multiples B*0 .. B*15 of a U string, as a 16-tuple. */
type Mults<
  B extends string,
  Acc extends string[] = [""],
  Cur extends string = B,
> = Acc["length"] extends 16 ? Acc : Mults<B, [...Acc, Cur], AddU<Cur, B>>;
type Digits = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"];
/** Largest k with M[k] <= R (scan down from 15). */
type QDigit<M extends string[], R extends string, K extends number[] = Down> = K extends [
  infer k extends number,
  ...infer KR extends number[],
]
  ? CmpU<M[k], R> extends ">"
    ? QDigit<M, R, KR>
    : k
  : 0;
type Down = [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
/** Long division of U strings: P is A's digits most significant first; Q the quotient MSB first. */
type DivL<
  P extends string,
  M extends string[],
  Rem extends string,
  Q extends string,
> = P extends `${infer d}${infer PR}` ? DivS<PR, M, Strip<`${d}${Rem}`>, Q> : Strip<Rev<Q>>;
type DivS<PR extends string, M extends string[], R extends string, Q extends string> =
  QDigit<M, R> extends infer k extends number
    ? DivL<PR, M, Strip<SubU<R, M[k]>>, `${Q}${Digits[k]}`>
    : never;
type DivU<A extends string, B extends string> = DivL<Rev<A>, Mults<B>, "", "">;

// ---- canonical API (operands >= 0)

/** A + B. */
export type Add<A extends string, B extends string> = B extends "0"
  ? A
  : A extends "0"
    ? B
    : FromU<AddU<ToU<A>, ToU<B>>>;
/** A - B (A >= B). */
export type Sub<A extends string, B extends string> = B extends "0"
  ? A
  : FromU<Strip<SubU<ToU<A>, ToU<B>>>>;
/** A * B. */
export type Mul<A extends string, B extends string> = B extends "1"
  ? A
  : A extends "1"
    ? B
    : A extends "0"
      ? "0"
      : B extends "0"
        ? "0"
        : FromU<MulU<ToU<A>, ToU<B>>>;
/** floor(A / B), B > 0. */
export type Div<A extends string, B extends string> = B extends "1"
  ? A
  : B extends "2"
    ? FromU<ShrU<ToU<A>, "1">>
    : B extends "4"
      ? FromU<ShrU<ToU<A>, "2">>
      : B extends "80"
        ? FromU<ShrU<ToU<A>, "3">>
        : B extends "01"
          ? FromU<Drop1<ToU<A>>>
          : FromU<DivU<ToU<A>, ToU<B>>>;
/** "<", "=" or ">". */
export type Cmp<A extends string, B extends string> = CmpU<ToU<A>, ToU<B>>;
export type Lt<A extends string, B extends string> = Cmp<A, B> extends "<" ? true : false;
export type Le<A extends string, B extends string> = Cmp<A, B> extends ">" ? false : true;
export type Min<A extends string, B extends string> = Cmp<A, B> extends ">" ? B : A;

/** A + 1. */
export type Inc<N extends string> = N extends `${infer D extends keyof IncD}${infer R}`
  ? D extends "f"
    ? R extends ""
      ? "01"
      : `0${Inc<R>}`
    : R extends ""
      ? D extends "7"
        ? "80"
        : IncD[D]
      : `${IncD[D]}${R}`
  : "1";
/** A - 1 (A >= 1). */
export type Dec<N extends string> = FromU<Strip<DecU<ToU<N>>>>;
type DecU<U extends string> = U extends `${infer D extends keyof DecD}${infer R}`
  ? D extends "0"
    ? `f${DecU<R>}`
    : `${DecD[D]}${R}`
  : "";

/** Number of hex digits of a canonical N >= 0, as "1".."6" ("1" for 0). */
export type Digits16<N extends string> = DLen<ToU<N>>;
type DLen<U extends string> = U extends `${string}${infer R}`
  ? R extends `${string}${infer R2}`
    ? R2 extends `${string}${infer R3}`
      ? R3 extends `${string}${infer R4}`
        ? R4 extends `${string}${infer R5}`
          ? R5 extends `${string}${string}`
            ? "6"
            : "5"
          : "4"
        : "3"
      : "2"
    : "1"
  : "1";

/**
 * Zero-extend a canonical int holding a W-bit unsigned value (W in nibbles,
 * "2" uint8, "4" uint16, "8" uint32): the encoding sign-extends the pattern,
 * so uint8 200 is "8c"; this gives "8c0".
 */
export type ZExt<C extends string, W extends "2" | "4" | "8"> =
  IsNeg<C> extends true ? `${Take<`${C}ffffffff`, W>}0` : C;
type Take<
  S extends string,
  W extends string,
> = S extends `${infer a}${infer b}${infer c}${infer d}${infer e}${infer f}${infer g}${infer h}${string}`
  ? W extends "2"
    ? `${a}${b}`
    : W extends "4"
      ? `${a}${b}${c}${d}`
      : `${a}${b}${c}${d}${e}${f}${g}${h}`
  : never;

// ---- growslice (Go 1.27; src/ref/values.ts growCap)

/** 256 */
type N256 = "001";
/** 768 */
type N768 = "003";
/** 32760 (32768 - 8) */
type NSmallMax = "8ff7";
/** 512 */
type N512 = "002";
/** 1016 (1024 - 8) */
type N1016 = "8f3";

/** nextslicecap(newLen, oldCap). */
export type NextSliceCap<NewLen extends string, OldCap extends string> =
  Add<OldCap, OldCap> extends infer Dbl extends string
    ? Lt<Dbl, NewLen> extends true
      ? NewLen
      : Lt<OldCap, N256> extends true
        ? Dbl
        : CapLoop<OldCap, NewLen>
    : never;
type CapLoop<C extends string, NewLen extends string> =
  Add<C, FromU<ShrU<ToU<Add<C, N768>>, "2">>> extends infer C2 extends string
    ? Lt<C2, NewLen> extends true
      ? CapLoop<C2, NewLen>
      : C2
    : never;

/** roundupsize(size, noscan). */
export type RoundUpSize<Size extends string, Noscan extends boolean> =
  Le<Size, NSmallMax> extends true
    ? (
        Noscan extends false ? (Lt<N512, Size> extends true ? Add<Size, "80"> : Size) : Size
      ) extends infer Req extends string
      ? Le<Req, N1016> extends true
        ? Sub<Class8[FromU<ShrU<ToU<Add<Req, "7">>, "3">>], Sub<Req, Size>>
        : Sub<Class128[Ix128<Sub<Add<Req, "f7">, "004">>], Sub<Req, Size>>
      : never
    : RoundUp8192<Add<Size, "fff1">>;
/** ceil((req - 1024) / 128) from req - 1024 + 127. */
type Ix128<X extends string> = FromU<ShrU<Drop1<ToU<X>>, "3">>;
/** Clear the low 13 bits. */
type RoundUp8192<C extends string> = C extends `${string}${string}${string}${infer d}${infer R}`
  ? FromU<Strip<`000${ClearLo1[d & keyof ClearLo1]}${R}`>>
  : "0";
interface ClearLo1 {
  "0": "0";
  "1": "0";
  "2": "2";
  "3": "2";
  "4": "4";
  "5": "4";
  "6": "6";
  "7": "6";
  "8": "8";
  "9": "8";
  a: "a";
  b: "a";
  c: "c";
  d: "c";
  e: "e";
  f: "e";
}

/** The capacity growslice gives: growCap(newLen, oldCap, elemSize, noscan). */
export type GrowCap<
  NewLen extends string,
  OldCap extends string,
  Size extends string,
  Noscan extends boolean,
> = Size extends "0"
  ? NewLen
  : Div<RoundUpSize<Mul<NextSliceCap<NewLen, OldCap>, Size>, Noscan>, Size>;
