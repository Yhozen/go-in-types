// internal/chacha8rand.block in types (mirrors src/ref/intrinsics.ts
// chacha8block, Go's block_generic): fills *[32]uint64 from the *[4]uint64
// seed and a uint32 counter. Values are int.ts nibble strings; u32 lanes.
import type * as Hp from "../types/heap.ts";
import type * as I from "../types/int.ts";

type Add<A, B> = I.Add<"u32", A & string, B & string>;
type Xor<A, B> = I.Xor<"u32", A & string, B & string>;
/** Rotate left by N bits (M = 32 - N); counts are nibble strings. */
type Rotl<A, N extends string, M extends string> = I.Or<
  "u32",
  I.Shl<"u32", A & string, "u64", N>,
  I.Shr<"u32", A & string, "u64", M>
>;

/** The quarter round on (a, b, c, d): [a, b, c, d]. */
type QR<A, B, C, D> =
  Add<A, B> extends infer a
    ? Rotl<Xor<D, a>, "01", "01"> extends infer d
      ? Add<C, d> extends infer c
        ? QR2<a, Rotl<Xor<B, c>, "c0", "41">, c, d>
        : never
      : never
    : never;
type QR2<A, B, C, D> =
  Add<A, B> extends infer a
    ? Rotl<Xor<D, a>, "80", "81"> extends infer d
      ? Add<C, d> extends infer c
        ? [a, Rotl<Xor<B, c>, "7", "91">, c, d]
        : never
      : never
    : never;

type X16 = unknown[];
/** One double round (columns, then diagonals) of the 16-word state X. */
type DR<X extends X16> =
  QR<X[0], X[4], X[8], X[12]> extends infer q0 extends X16
    ? QR<X[1], X[5], X[9], X[13]> extends infer q1 extends X16
      ? QR<X[2], X[6], X[10], X[14]> extends infer q2 extends X16
        ? QR<X[3], X[7], X[11], X[15]> extends infer q3 extends X16
          ? Diag<q0, q1, q2, q3>
          : never
        : never
      : never
    : never;
// after the columns: x[4c + r]... column c's result q_c = [x_c, x_{c+4}, x_{c+8}, x_{c+12}]
type Diag<Q0 extends X16, Q1 extends X16, Q2 extends X16, Q3 extends X16> =
  QR<Q0[0], Q1[1], Q2[2], Q3[3]> extends infer r0 extends X16
    ? QR<Q1[0], Q2[1], Q3[2], Q0[3]> extends infer r1 extends X16
      ? QR<Q2[0], Q3[1], Q0[2], Q1[3]> extends infer r2 extends X16
        ? QR<Q3[0], Q0[1], Q1[2], Q2[3]> extends infer r3 extends X16
          ? DiagOut<r0, r1, r2, r3>
          : never
        : never
      : never
    : never;
// r0 = (x0, x5, x10, x15), r1 = (x1, x6, x11, x12), r2 = (x2, x7, x8, x13), r3 = (x3, x4, x9, x14)
type DiagOut<R0 extends X16, R1 extends X16, R2 extends X16, R3 extends X16> = [
  R0[0],
  R1[0],
  R2[0],
  R3[0],
  R3[1],
  R0[1],
  R1[1],
  R2[1],
  R2[2],
  R3[2],
  R0[2],
  R1[2],
  R1[3],
  R2[3],
  R3[3],
  R0[3],
];

/** 4 double rounds (8 rounds). */
type Rounds<X extends X16> =
  DR<X> extends infer a extends X16
    ? DR<a> extends infer b extends X16
      ? DR<b> extends infer c extends X16
        ? DR<c>
        : never
      : never
    : never;

/** The lane's output: rows 4..11 get the input added back. */
type Fin<In extends X16, X extends X16> = [
  X[0],
  X[1],
  X[2],
  X[3],
  Add<In[4], X[4]>,
  Add<In[5], X[5]>,
  Add<In[6], X[6]>,
  Add<In[7], X[7]>,
  Add<In[8], X[8]>,
  Add<In[9], X[9]>,
  Add<In[10], X[10]>,
  Add<In[11], X[11]>,
  X[12],
  X[13],
  X[14],
  X[15],
];

type Lo<V> = I.Conv<"u64", "u32", V & string>;
type Hi<V> = I.Conv<"u64", "u32", I.Shr<"u64", V & string, "u64", "02">>;
type K0 = "56870716";
type K1 = "e6460233";
type K2 = "23d22697";
type K3 = "475602b6";
/** The input state of lane c (seed words S0..S3, counter Ct). */
type In<S0, S1, S2, S3, Ct> = [
  K0,
  K1,
  K2,
  K3,
  Lo<S0>,
  Hi<S0>,
  Lo<S1>,
  Hi<S1>,
  Lo<S2>,
  Hi<S2>,
  Lo<S3>,
  Hi<S3>,
  Ct,
  "0",
  "0",
  "0",
];
type Lane<B extends X16> = Rounds<B> extends infer x extends X16 ? Fin<B, x> : never;

/** a | b << 32 as a uint64 (a, b uint32). */
type Join<A, B> = I.Or<
  "u64",
  I.ZExt<"u32", A & string>,
  I.Shl<"u64", I.ZExt<"u32", B & string>, "u64", "02">
>;

/** The 32 uint64 outputs: buf[k] = lane(2(k&1))[k>>1] | lane(2(k&1)+1)[k>>1] << 32. */
type Outs<
  L0 extends X16,
  L1 extends X16,
  L2 extends X16,
  L3 extends X16,
  Acc extends unknown[],
> = Acc["length"] extends 32
  ? Acc
  : Acc["length"] extends infer n extends number
    ? Outs<L0, L1, L2, L3, [...Acc, Join<L0[Row<n>], L1[Row<n>]>, Join<L2[Row<n>], L3[Row<n>]>]>
    : never;
type Row<N extends number> = Half[N & keyof Half];
type Half = {
  0: 0;
  2: 1;
  4: 2;
  6: 3;
  8: 4;
  10: 5;
  12: 6;
  14: 7;
  16: 8;
  18: 9;
  20: 10;
  22: 11;
  24: 12;
  26: 13;
  28: 14;
  30: 15;
};

type Store<H, P, Vs, J extends unknown[]> = Vs extends [infer v, ...infer R]
  ? Store<Hp.Store1<H, Hp.FieldAddr<P, NibOf<J["length"]>>, v>, P, R, [...J, 0]>
  : H;
type NibOf<N> = N extends keyof Nibs ? Nibs[N] : "0";
type Nibs = {
  0: "0";
  1: "1";
  2: "2";
  3: "3";
  4: "4";
  5: "5";
  6: "6";
  7: "7";
  8: "80";
  9: "90";
  10: "a0";
  11: "b0";
  12: "c0";
  13: "d0";
  14: "e0";
  15: "f0";
  16: "01";
  17: "11";
  18: "21";
  19: "31";
  20: "41";
  21: "51";
  22: "61";
  23: "71";
  24: "81";
  25: "91";
  26: "a1";
  27: "b1";
  28: "c1";
  29: "d1";
  30: "e1";
  31: "f1";
};

type Seed<H, P, J extends string> = Hp.Load1<H, Hp.FieldAddr<P, J>, "0">;

/** The heap after block(seed, buf, counter). */
export type Block<H, SeedP, BufP, Ct> =
  Seed<H, SeedP, "0"> extends infer s0
    ? Seed<H, SeedP, "1"> extends infer s1
      ? Seed<H, SeedP, "2"> extends infer s2
        ? Seed<H, SeedP, "3"> extends infer s3
          ? Block2<H, BufP, In<s0, s1, s2, s3, Ct>, Ct>
          : never
        : never
      : never
    : never;
type Block2<H, BufP, B extends X16, Ct> =
  Lane<B> extends infer l0 extends X16
    ? Lane<Ctr<B, Add<Ct, "1">>> extends infer l1 extends X16
      ? Lane<Ctr<B, Add<Ct, "2">>> extends infer l2 extends X16
        ? Lane<Ctr<B, Add<Ct, "3">>> extends infer l3 extends X16
          ? Store<H, BufP, Outs<l0, l1, l2, l3, []>, []>
          : never
        : never
      : never
    : never;
type Ctr<B extends X16, C> = [
  B[0],
  B[1],
  B[2],
  B[3],
  B[4],
  B[5],
  B[6],
  B[7],
  B[8],
  B[9],
  B[10],
  B[11],
  C,
  B[13],
  B[14],
  B[15],
];
