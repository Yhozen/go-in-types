// The type-level runtime of emitted programs (docs/EMIT.md): the driver
// state, continuations, the trampoline (calls, returns, entries), fuel.
// Rules H1-H5 (docs/stage0/HEAP.md): the heap H and every tuple holding it
// (the state S, an entry's argument object) travel only as alias arguments
// and are read by indexed access; conditionals test small values.

/** The driver state (EMIT.md "The driver state"). */
export type St<Tag, Key, H, K, X, A, F> = Tag extends unknown ? [Tag, Key, H, K, X, A, F] : never;
/** A continuation (EMIT.md "Continuations"). */
export type Ct<Kind, Key, Regs, D, Fid, Mode> = Kind extends unknown
  ? [Kind, Key, Regs, D, Fid, Mode]
  : never;
/** A cons cell (stack, defer list, panic chain). */
export type Cons<A, B> = A extends unknown ? [A, B] : never;
/** Machine extras: stdout, stderr, panic chain, next panic serial. */
export type Xt<O, E, Pn, Ns> = O extends unknown ? [O, E, Pn, Ns] : never;

/** The base of entry interfaces: an entry is `(E & { h; k; x; f; a })["o"]`. */
export interface EB {
  h: unknown;
  k: unknown;
  x: unknown;
  f: unknown;
  a: unknown;
  o: unknown;
}

/** Fuel of one chunk (EMIT.md "Fuel"): 900 units. */
export type FUEL =
  "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

// ---------------------------------------------------------------- yields

/** Yield: resume entry Key with A (fuel out at a block entry). */
export type Y<Key, H, K, X, A, F> = St<"j", Key, H, K, X, A, F>;
/** Return V to the continuation on top of K. */
export type Rt<H, K, X, F, V> = St<"r", "", H, K, X, V, F>;
/** Call function Fid with Args and Env (the continuation is already on K). */
export type Cl<H, K, X, F, Fid, Args, Env> = St<"c", "", H, K, X, Mk3<Fid, Args, Env>, F>;
/** Panic with interface value V in the running frame Fr = [Key, Regs, D, Fid]. */
export type Pc<H, K, X, F, V, Fr> = St<"p", "", H, K, X, Mk2<V, Fr>, F>;
/** The end of the run with exit status C (a number literal). */
export type Ex<H, K, X, C> = St<"x", "", H, K, X, C, "">;

type Mk2<A, B> = A extends unknown ? [A, B] : never;
type Mk3<A, B, C> = A extends unknown ? [A, B, C] : never;

// ---------------------------------------------------------------- driver

type Mk6<A, B, C, D, E, F> = A extends unknown ? [A, B, C, D, E, F] : never;
type I0<T> = T["0" & keyof T];
type I1<T> = T["1" & keyof T];
type I2<T> = T["2" & keyof T];
type I3<T> = T["3" & keyof T];
type I4<T> = T["4" & keyof T];
type I5<T> = T["5" & keyof T];

/** The program interface the driver reads (emitted per program). */
export interface ProgB {
  /** entries by key */
  e: unknown;
  /** panic print kinds by dynamic type: [kind, named, name] */
  pk: unknown;
  /** zero results by function id */
  zr: unknown;
  /** recover entry keys by function id */
  rc: unknown;
  /** fuel per chunk (FUEL unless probing) */
  fuel: unknown;
  /** method tables for printing panics */
  mErr: unknown;
  mStr: unknown;
}

/**
 * Apply entry Key of table E: `(E[Key] & {...})["o"]` (the entry interface's
 * `o` reads its arguments from `this`).
 */
type Ent<E, Key, H, K, X, F, A> = Key extends keyof E
  ? (E[Key] & EA<H, K, X, F, A>)["o"]
  : St<"x", "", H, K, XErr<X, `fatal error: no entry ${Key & string}\n`>, 2, "">;

/** An entry's arguments (intersected with the entry interface). */
interface EA<H, K, X, F, A> {
  h: H;
  k: K;
  x: X;
  f: F;
  a: A;
  o: unknown;
}

/** One chunk: refuel S and run trampoline steps until the fuel is spent or the run is over. */
export type Chunk<P extends ProgB, S> =
  I0<S> extends "x" ? S : Drive<P, St<I0<S>, I1<S>, I2<S>, I3<S>, I4<S>, I5<S>, P["fuel"]>>;

/** Steps while fuel lasts (each step spends 1). */
type Drive<P extends ProgB, S> = S["0" & keyof S] extends "x"
  ? S
  : S["6" & keyof S] extends `x${infer F extends string}`
    ? Drive<P, Step<P, S, F>>
    : S;

/** One trampoline step with fuel F. */
type Step<P extends ProgB, S, F> = S["0" & keyof S] extends "j"
  ? Ent<
      P["e"],
      S["1" & keyof S],
      S["2" & keyof S],
      S["3" & keyof S],
      S["4" & keyof S],
      F,
      S["5" & keyof S]
    >
  : S["0" & keyof S] extends "r"
    ? Ret<P, S["2" & keyof S], S["3" & keyof S], S["4" & keyof S], F, S["5" & keyof S]>
    : S["0" & keyof S] extends "c"
      ? Ent<
          P["e"],
          `f${I0<S["5" & keyof S]> & string}`,
          S["2" & keyof S],
          S["3" & keyof S],
          S["4" & keyof S],
          F,
          S["5" & keyof S]
        >
      : S["0" & keyof S] extends "p"
        ? DoPanic<
            P,
            S["2" & keyof S],
            S["3" & keyof S],
            S["4" & keyof S],
            F,
            I0<S["5" & keyof S]>,
            I1<S["5" & keyof S]>
          >
        : S;

/** Return V to the top of K. */
type Ret<P extends ProgB, H, K, X, F, V> = RetC<P, H, I0<K>, I1<K>, X, F, V>;
type RetC<P extends ProgB, H, C, K, X, F, V> =
  I0<C> extends "n"
    ? Ent<P["e"], I1<C>, H, K, X, F, Mk3<V, I2<C>, I3<C>>>
    : I0<C> extends "d"
      ? RunD<P, H, Cons<C, K>, X, F>
      : I0<C> extends "b"
        ? Ex<H, K, X, 0>
        : I0<C> extends "m"
          ? Ent<
              P["e"],
              `f${I4<C> & string}`,
              H,
              Cons<Ct<"b", "", [], null, "0", "">, K>,
              X,
              F,
              Mk3<I4<C>, [], []>
            >
          : I0<C> extends "q"
            ? FatalI<
                P,
                H,
                K,
                XPn<X, PnSet<I2<X>, I4<PnNth<I2<X>, I5<C>>>, "5", V>>,
                F,
                `${I5<C> & string}x`
              >
            : St<"x", "", H, K, XErr<X, "fatal error: bad continuation\n">, 2, "">;

// ---------------------------------------------------------------- panics and defers
//
// The reference's algorithm (src/ref/interp.ts startPanic, stepDefers,
// recover, finishStep) on the type-level state. Depths are strings of "x"
// (one per continuation below the frame); panic serials "s", "sx", ...

/** Records of the panic chain: [V, Recovered, Repanicked, Depth, Serial, Str]. */
export type KLen<K, A extends string> = K extends null ? A : KLen<I1<K>, `${A}x`>;
/** The canonical map key of a float's bits V (Fb "32"/"64"): -0 is 0, a NaN is Nan. */
export type KeyFloat<V, Fb, Nan> = Fb extends "64"
  ? V extends "0000000000000008"
    ? "0"
    : I.And<"u64", V & string, "0000000000000ff7"> extends "0000000000000ff7"
      ? I.And<"u64", V & string, "fffffffffffff0"> extends "0"
        ? V
        : Nan
      : V
  : V extends "00000008"
    ? "0"
    : I.And<"u32", V & string, "000008f7"> extends "000008f7"
      ? I.And<"u32", V & string, "fffff7"> extends "0"
        ? V
        : Nan
      : V;
/**
 * The canonical map key of interface value V (P the program tables, Nan the
 * NaN key): `${T}|${form}` by T's equality kind, or the "hash of unhashable
 * type" panic (Hp.Panic).
 */
export type IKey<P, V, Nan> = V extends null
  ? "nil"
  : Look<P["eqk" & keyof P], I0<V>> extends infer k
    ? k extends "unc"
      ? Hp.Panic<"e", [`hash of unhashable type ${Look<P["names" & keyof P], I0<V>> & string}`]>
      : KeyK<P, I1<V>, k, Nan> extends infer f
        ? f extends string
          ? `${I0<V> & string}|${f}`
          : f
        : never
    : never;
type KeyK<P, V, K, Nan> = K extends "="
  ? V extends string
    ? `${Len<V>}:${V}`
    : V extends boolean
      ? V extends true
        ? "t"
        : "f"
      : V extends null
        ? "nil"
        : `${I0<V> & string}.${I1<V> & string}`
  : K extends "f64"
    ? KeyFloat<V, "64", Nan>
    : K extends "f32"
      ? KeyFloat<V, "32", Nan>
      : K extends "i"
        ? IKey<P, V, Nan>
        : KeyAgg<P, V, K, Nan, "">;
type KeyAgg<P, V, K, Nan, Acc extends string> = K extends [infer k, ...infer KR]
  ? V extends [infer v, ...infer VR]
    ? KeyK<P, v, k, Nan> extends infer f
      ? f extends string
        ? KeyAgg<P, VR, KR, Nan, `${Acc},${f}`>
        : f
      : never
    : never
  : Acc;
type Len<S> = S extends `${string}${infer R}` ? `x${Len<R>}` : "";
/** true, or the Hp.Panic a key canonicalisation produced. */
export type KeyOk<C> = C extends string ? true : C;
/** The sequence number the next new key of map M gets. */
export type MapSeq<H, M> = Hp.GetObj<H, M>["1" & keyof Hp.GetObj<H, M>];
/** A frame's stack index (DESIGN.md deferstack): KLen - 1 as an int, for the frame running on K. */
export type StackIx<K> = KIx<K, "f">;
type KIx<K, A extends string> = K extends null ? A : KIx<I1<K>, I.Add<"i64", A, "1">>;
/** K with Rec pushed onto the defer list of the frame at stack index Ix (range-over-func). */
export type DeferAt<K, Ix, Rec> = DeferAtW<K, Ix, Rec, StackIx<I1<K>>>;
type DeferAtW<K, Ix, Rec, Cur> = K extends null
  ? null
  : Cur extends Ix
    ? Cons<Ct<I0<I0<K>>, I1<I0<K>>, I2<I0<K>>, Cons<Rec, I3<I0<K>>>, I4<I0<K>>, I5<I0<K>>>, I1<K>>
    : Cons<I0<K>, DeferAtW<I1<K>, Ix, Rec, I.Sub<"i64", Cur & string, "1">>>;
/** [K, D] after a defer onto frame Ix: the running frame (defer list D) when it is Ix. */
export type DeferOn<K, D, Ix, Rec> =
  StackIx<K> extends Ix ? Mk2<K, Cons<Rec, D>> : Mk2<DeferAt<K, Ix, Rec>, D>;
type LtX<A, B> = B extends `${A & string}x${string}` ? true : false;
type XPn<X, Pn> = Xt<I0<X>, I1<X>, Pn, I3<X>>;
/** X with stderr extended by S. */
export type XErr<X, S> = Xt<I0<X>, `${I1<X> & string}${S & string}`, I2<X>, I3<X>>;
/** X with S written to fd Fd (an int: "1" stdout, "2" stderr). */
export type XWrite<X, Fd, S> = Fd extends "2"
  ? XErr<X, S>
  : Xt<`${I0<X> & string}${S & string}`, I1<X>, I2<X>, I3<X>>;

type PnFind<Pn, Sr> = Pn extends null ? null : I4<I0<Pn>> extends Sr ? I0<Pn> : PnFind<I1<Pn>, Sr>;
/** Pn with field Fi of record Sr set to V. */
type PnSet<Pn, Sr, Fi, V> = Pn extends null
  ? null
  : I4<I0<Pn>> extends Sr
    ? Cons<RecSet<I0<Pn>, Fi, V>, I1<Pn>>
    : Cons<I0<Pn>, PnSet<I1<Pn>, Sr, Fi, V>>;
type RecSet<R, Fi, V> = Fi extends "1"
  ? Mk6<I0<R>, V, I2<R>, I3<R>, I4<R>, I5<R>>
  : Fi extends "2"
    ? Mk6<I0<R>, I1<R>, V, I3<R>, I4<R>, I5<R>>
    : Fi extends "3"
      ? Mk6<I0<R>, I1<R>, I2<R>, V, I4<R>, I5<R>>
      : Mk6<I0<R>, I1<R>, I2<R>, I3<R>, I4<R>, V>;
/** The chain from the first record whose depth is below D. */
type PnDrop<Pn, D> = Pn extends null
  ? null
  : LtX<I3<I0<Pn>>, D> extends true
    ? Pn
    : PnDrop<I1<Pn>, D>;
/** The k-th record (k a string of "x"), or null. */
type PnNth<Pn, Kx> = Pn extends null ? null : Kx extends `x${infer R}` ? PnNth<I1<Pn>, R> : I0<Pn>;

/** A new panic with value V in the running frame Fr = [Key, Regs, D, Fid]; K below it. */
type DoPanic<P extends ProgB, H, K, X, F, V, Fr> = RunD<
  P,
  H,
  Cons<Ct<"d", I0<Fr>, I1<Fr>, I2<Fr>, I3<Fr>, I3<X>>, K>,
  Xt<
    I0<X>,
    I1<X>,
    Cons<Mk6<V, false, false, KLen<K, "">, I3<X>, null>, I2<X>>,
    `${I3<X> & string}x`
  >,
  F
>;
/** A new panic in the frame whose "d" continuation is on top of K (a nil deferred func). */
type DoPanicTop<P extends ProgB, H, K, X, F, V> = RunD<
  P,
  H,
  Cons<Ct<"d", I1<I0<K>>, I2<I0<K>>, I3<I0<K>>, I4<I0<K>>, I3<X>>, I1<K>>,
  Xt<
    I0<X>,
    I1<X>,
    Cons<Mk6<V, false, false, KLen<I1<K>, "">, I3<X>, null>, I2<X>>,
    `${I3<X> & string}x`
  >,
  F
>;

/** Run the next deferred call of the frame whose "d" continuation is on top of K. */
type RunD<P extends ProgB, H, K, X, F> = RunDC<P, H, I0<K>, I1<K>, X, F>;
type RunDC<P extends ProgB, H, C, K, X, F> =
  I3<C> extends null
    ? DefDone<P, H, C, K, X, F>
    : RunRec<P, H, Cons<Ct<"d", I1<C>, I2<C>, I1<I3<C>>, I4<C>, I5<C>>, K>, X, F, I0<I3<C>>>;
type RunRec<P extends ProgB, H, K, X, F, Rec> =
  I0<Rec> extends null
    ? DoPanicTop<
        P,
        H,
        K,
        X,
        F,
        [P["es" & keyof P], "invalid memory address or nil pointer dereference"]
      >
    : I0<Rec> extends `b:${infer B}`
      ? RunD<P, H, K, DeferB<X, B, I1<Rec>, I2<Rec>>, F>
      : Ent<P["e"], `f${I0<Rec> & string}`, H, K, X, F, Rec>;
/** A deferred builtin (print and println; others are ignored). */
type DeferB<X, B, Args, Info> = B extends "println"
  ? XErr<X, `${PrintList<Args, Info, " ">}\n`>
  : B extends "print"
    ? XErr<X, PrintList<Args, Info, "">>
    : X;
type PrintList<Args, Info, Sep extends string, O extends string = "", First = true> = Args extends [
  infer a,
  ...infer AR,
]
  ? Info extends [infer i, ...infer IR]
    ? PrintV<a, i> extends infer v extends string
      ? PrintList<AR, IR, Sep, `${O}${First extends true ? "" : Sep}${v}`, false>
      : O
    : O
  : O;

/** The frame's defers are done: resume after runDefers, recover, or keep unwinding. */
type DefDone<P extends ProgB, H, C, K, X, F> =
  I5<C> extends "r"
    ? Ent<P["e"], I1<C>, H, K, X, F, Mk3<null, I2<C>, null>>
    : PnFind<I2<X>, I5<C>> extends infer Rec
      ? I1<Rec> extends true
        ? Recovered<P, H, C, K, XPn<X, PnDrop<I2<X>, KLen<K, "">>>, F>
        : Unwind<P, H, I0<K>, I1<K>, X, F, I5<C>>
      : never;
type Recovered<P extends ProgB, H, C, K, X, F> =
  I4<C> extends keyof P["rc"]
    ? Ent<P["e"], P["rc"][I4<C>], H, K, X, F, Mk3<null, I2<C>, null>>
    : Rt<H, K, X, F, I4<C> extends keyof P["zr"] ? P["zr"][I4<C>] : null>;
/** Pop the frame; the frame below (top T, rest K) unwinds panic Sr. */
type Unwind<P extends ProgB, H, T, K, X, F, Sr> =
  I0<T> extends "n" | "d"
    ? RunD<
        P,
        H,
        Cons<Ct<"d", I1<T>, I2<T>, I3<T>, I4<T>, Sr>, K>,
        XPn<X, PnSet<I2<X>, Sr, "3", KLen<K, "">>>,
        F
      >
    : FatalI<P, H, Cons<T, K>, X, F, "">;

/** recover(): [value, X] (the panic value when the caller of this frame is a deferring, panicking frame). */
export type Recover<K, X> =
  I0<I0<K>> extends "d"
    ? I5<I0<K>> extends `s${string}`
      ? PnFind<I2<X>, I5<I0<K>>> extends infer Rec
        ? I1<Rec> extends false
          ? Mk2<I0<Rec>, XPn<X, PnSet<I2<X>, I5<I0<K>>, "1", true>>>
          : Mk2<null, X>
        : never
      : Mk2<null, X>
    : Mk2<null, X>;

/** A fatal panic: get each record's Error()/String() text (record Kx onwards), then print. */
type FatalI<P extends ProgB, H, K, X, F, Kx> =
  PnNth<I2<X>, Kx> extends infer Q
    ? Q extends null
      ? FatalPrint<P, H, K, X>
      : PnNth<I2<X>, `${Kx & string}x`> extends infer L
        ? L extends null
          ? FatalCall<P, H, K, X, F, Kx, I0<Q>>
          : SameE<I0<L>, I0<Q>> extends true
            ? FatalI<P, H, K, XPn<X, PnSet<I2<X>, I4<L>, "2", true>>, F, `${Kx & string}x`>
            : FatalCall<P, H, K, X, F, Kx, I0<Q>>
        : never
    : never;
type SameE<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type FatalCall<P extends ProgB, H, K, X, F, Kx, V> = V extends null
  ? FatalI<P, H, K, X, F, `${Kx & string}x`>
  : I0<V> extends keyof P["mErr"]
    ? Ent<
        P["e"],
        `f${P["mErr"][I0<V>] & string}`,
        H,
        Cons<Ct<"q", "", [], null, "0", Kx>, K>,
        X,
        F,
        Mk3<P["mErr"][I0<V>], [I1<V>], []>
      >
    : I0<V> extends keyof P["mStr"]
      ? Ent<
          P["e"],
          `f${P["mStr"][I0<V>] & string}`,
          H,
          Cons<Ct<"q", "", [], null, "0", Kx>, K>,
          X,
          F,
          Mk3<P["mStr"][I0<V>], [I1<V>], []>
        >
      : FatalI<P, H, K, X, F, `${Kx & string}x`>;
type FatalPrint<P extends ProgB, H, K, X> = Ex<
  H,
  K,
  XErr<X, `${PQ<P, I2<X>> & string}\ngoroutine 1 [running]:\n`>,
  2
>;
type PQ<P extends ProgB, L> =
  I1<L> extends null
    ? PLine<P, I0<L>>
    : I2<I0<I1<L>>> extends true
      ? PQ<P, I1<L>>
      : `${PQ<P, I1<L>> & string}\t${PLine<P, I0<L>> & string}`;
type PLine<
  P extends ProgB,
  Q,
> = `panic: ${I5<Q> extends string ? Indent<I5<Q>> : PanicVal<P, I0<Q>> & string}${I1<Q> extends true ? (I2<Q> extends true ? " [recovered, repanicked]" : " [recovered]") : ""}\n`;
type Str<X> = X extends string ? X : "";
type Indent<S> = S extends `${infer A}\n${infer B}` ? `${A}\n\t${Indent<B>}` : S;
type PanicVal<P extends ProgB, V> = V extends null
  ? "panic called with nil argument (goexit=false)"
  : I0<V> extends keyof P["pk"]
    ? PVal<P["pk"][I0<V>], I1<V>>
    : "(?) 0xc000010000";
type PVal<Pk, V> =
  I0<Pk> extends "s"
    ? I1<Pk> extends true
      ? `${I2<Pk> & string}("${Str<Indent<V>>}")`
      : Indent<V>
    : I0<Pk> extends "o"
      ? `(${I2<Pk> & string}) 0xc000010000`
      : PrintV<V, I0<Pk>> extends infer v extends string
        ? I1<Pk> extends true
          ? `${I2<Pk> & string}(${v})`
          : v
        : never;

// ---------------------------------------------------------------- helpers for emitted code

/** print/println of one value with static print kind Kd. */
export type PrintV<V, Kd> = Kd extends "b"
  ? V extends true
    ? "true"
    : "false"
  : Kd extends "s"
    ? V
    : Kd extends I.W
      ? I.ToDec<Kd, V & string>
      : Kd extends "sl"
        ? V extends null
          ? "[0/0]0x0"
          : `[${I.ToDec<"i64", I2<V> & string>}/${I.ToDec<"i64", I3<V> & string>}]0xc000010000`
        : Kd extends "if"
          ? V extends null
            ? "(0x0,0x0)"
            : "(0x10000,0xc000010000)"
          : Kd extends "f32" | "f64"
            ? "(float)"
            : V extends null
              ? "0x0"
              : "0xc000010000";

export type Not<B> = B extends true ? false : true;
export type Eq<A, B> = [A] extends [B] ? true : false;
export type Ne<A, B> = [A] extends [B] ? false : true;
/** true unless R is an int.ts / str.ts `["panic", M]`. */
export type NotP<R> = R extends ["panic", unknown] ? false : true;
/** true unless R is a heap.ts Panic. */
export type NotHP<R> = Hp.IsPanic<R> extends true ? false : true;
export type NonZero<Y> = Y extends "0" ? false : true;
export type NotNeg<Y> = Y extends `${string}${"8" | "9" | "a" | "b" | "c" | "d" | "e" | "f"}`
  ? false
  : true;
/** The interface value of a heap.ts Panic<K, M> (ES: runtime.errorString, PE: runtime.plainError). */
export type HPanicV<R, ES, PE> = Mk2<
  R["!panic" & keyof R] extends "e" ? ES : PE,
  PMsg<R["m" & keyof R], "">
>;
type PMsg<M, O extends string> = M extends [infer a, ...infer R]
  ? PMsg<R, `${O}${a extends [infer n] ? I.ToDec<"i64", n & string> : a & string}`>
  : O;
/** `true`, or the panic of converting a slice shorter than N to an array (pointer). */
export type SliceLenCk<S, N extends string> =
  N.Lt<Hp.Len<S> & string, N> extends true
    ? I.Panic<`cannot convert slice with length ${I.ToDec<"i64", Hp.Len<S> & string>} to array or pointer to array with length ${I.ToDec<"i64", N>}`>
    : true;
export type SliceToPtr<S> = S extends null ? null : Hp.PtrMk<I0<S>, I1<S>>;
/** T[K] for a big table (H3). */
export type Look<T, K> = K extends keyof T ? T[K] : never;
/** The defer record of a func value FV (nil: a record that panics when run). */
export type DeferVal<FV, Args> = FV extends null ? Mk3<null, Args, []> : Mk3<I0<FV>, Args, I1<FV>>;
/** *D = *S for an aggregate of N slots (heap to heap; Z its zero pattern). */
export type CopyAgg<H, D, S, Nn extends string, Z> = Hp.Copy<
  H,
  Hp.SliceMk<I0<D>, I1<D>, Nn, Nn>,
  Hp.SliceMk<I0<S>, I1<S>, Nn, Nn>,
  "1",
  Z
>;
/** The first N bytes of S. */
export type StrTake<S, N> = Sr.Slice<S & string, null, N & string>;
/** wrapnilchk */
export type WrapNilCk<Pt> = Pt extends null ? false : true;
export type WrapNilMsg<Typ, Meth> =
  `value method ${Typ & string}.${Meth & string} called using nil *${AfterDot<Typ & string>} pointer`;
type AfterDot<S extends string> = S extends `${string}.${infer R}` ? AfterDot<R> : S;
/** The heap after clear(s) of a slice (elements of Es slots, zero Ze). */
export type ClearSlice<H, S, Es extends string, Ze> = S extends null
  ? H
  : ClearL<H, S, "0", Hp.Len<S> & string, Es, Ze>;
type ClearL<H, S, Ix extends string, L extends string, Es extends string, Ze> = Ix extends L
  ? H
  : ClearL<Hp.StoreK<H, Hp.SliceIndexAddr<S, Ix, Es>, Ze>, S, N.Inc<Ix>, L, Es, Ze>;

/** The end of the run with exit status C (an int). */
export type ExitC<H, K, X, C> = Ex<H, K, X, NumOf<I.ToDec<"i64", C & string>>>;
type NumOf<S> = S extends `${infer N extends number}` ? N : 2;
/** An unsupported operation reached: message to stderr, exit 2. */
export type Trap<H, K, X, Msg> = Ex<H, K, XErr<X, Msg>, 2>;

// ---------------------------------------------------------------- hovers

/** Chunks per inner loop of Exec (a tail chain). */
type X500 = "4f1";
/**
 * Run to the end in one alias (hovers): before every chunk, a fresh literal
 * of the fuel pool is resolved, which zeroes the checker's instantiation
 * counter. K0: the pool chunk to start at (several runs in one session
 * need disjoint ranges).
 */
export type Exec<P extends ProgB, S, K0 extends string = "0"> = ExecO<P, S, K0>;
type ExecO<P extends ProgB, S, K extends string> =
  I0<S> extends "x" ? S : K extends keyof Pool ? ExecO<P, ExecI<P, S, K, "0">, N.Add<K, X500>> : S;
type ExecI<P extends ProgB, S, K extends string, C extends string> =
  I0<S> extends "x"
    ? S
    : C extends X500
      ? S
      : K extends keyof Pool
        ? Pool[K] extends 0
          ? ExecI<P, Chunk<P, S>, N.Inc<K>, N.Inc<C>>
          : S
        : S;

import type * as Hp from "../types/heap.ts";
import type * as I from "../types/int.ts";
import type * as N from "../types/nat.ts";
import type * as Sr from "../types/str.ts";
import type { Pool } from "./fuel.gen.ts";

// ---------------------------------------------------------------- results

export type Out<S> = I0<S["4" & keyof S]>;
export type Err<S> = I1<S["4" & keyof S]>;
export type Exit<S> = S["0" & keyof S] extends "x" ? S["5" & keyof S] : -1;
export type Done<S> = S["0" & keyof S] extends "x" ? true : false;
