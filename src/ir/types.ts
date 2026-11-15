/**
 * The go-in-types IR: the contract between the front end (`frontend/`, Go)
 * and everything downstream (reference interpreter, emitter). See
 * `docs/DESIGN.md` for semantics. The front end writes one `Program` as JSON.
 *
 * Shape: close to golang.org/x/tools/go/ssa after lowering (generics
 * instantiated, floats lowered to soft-float calls, unsupported features
 * turned into traps, intrinsics resolved by name).
 *
 * Bump `IR_VERSION` on any incompatible change.
 */

export const IR_VERSION = 2;

/** Index into `Program.types`. */
export type TypeId = number;
/** Index into `Program.funcs`. */
export type FuncId = number;
/** Index into `Program.globals`. */
export type GlobalId = number;
/** A register of the current function: params, then free vars, then results. */
export type Reg = number;

export interface Program {
  version: typeof IR_VERSION;
  /** Build facts: GOOS/GOARCH, tags, Go version, source module, overlay. */
  build: Record<string, string>;
  types: Type[];
  globals: Global[];
  funcs: Func[];
  /** Synthetic function that runs every package initializer in Go order. */
  init: FuncId;
  /** `main.main`, or null for a library program driven through `entries`. */
  main: FuncId | null;
  /** Named entry points callable by a host (e.g. "check"). */
  entries: Record<string, FuncId>;
}

// ---------------------------------------------------------------- types

export type IntKind =
  | "int8"
  | "int16"
  | "int32"
  | "int64"
  | "uint8"
  | "uint16"
  | "uint32"
  | "uint64";

/**
 * `int`, `uint` and `uintptr` are 64-bit and appear as int64/uint64 with
 * `name` kept for printing. Every type has a fixed number of slots: scalars
 * take 1, `array` takes len * elem slots, `struct` the sum of its fields.
 */
export type Type =
  | { k: "bool"; slots: 1 }
  /** `name` is set for `int`, `uint`, `uintptr` (distinct types from int64/uint64). */
  | { k: "int"; int: IntKind; name?: "int" | "uint" | "uintptr"; slots: 1 }
  /** Bit pattern of the float (uint32 or uint64); arithmetic is soft-float. */
  | { k: "float"; bits: 32 | 64; slots: 1 }
  | { k: "string"; slots: 1 }
  | { k: "pointer"; elem: TypeId; slots: 1 }
  | { k: "slice"; elem: TypeId; slots: 1 }
  | { k: "array"; elem: TypeId; len: number; slots: number }
  | {
      k: "struct";
      fields: Field[];
      slots: number;
      /** Unnamed struct with embedded fields: promoted method sets of the struct and of a pointer to it (as `NamedType`); absent when empty. */
      methods?: Record<string, FuncId>;
      ptrMethods?: Record<string, FuncId>;
    }
  | { k: "map"; key: TypeId; elem: TypeId; slots: 1 }
  | { k: "chan"; elem: TypeId; slots: 1 }
  | { k: "func"; params: TypeId[]; results: TypeId[]; variadic: boolean; slots: 1 }
  /** `sigs[i]`: signature (k: "func", no receiver) of `methods[i]`; dynamic types implement an interface only if names and signatures match. */
  | { k: "interface"; methods: string[]; sigs: TypeId[]; slots: 1 }
  /** Multiple results of a call; never stored in memory. */
  | { k: "tuple"; elems: TypeId[]; slots: number }
  /** unsafe.Pointer and complex types: values exist only to be trapped on; "deferstack": a frame reference (see the deferstack builtin). */
  | { k: "opaque"; what: string; slots: 1 }
  | NamedType;

export interface NamedType {
  k: "named";
  /** Fully qualified, as Go prints it in panics and %T (e.g. "*ast.Node" is the pointer, this is "ast.Node"). */
  name: string;
  underlying: TypeId;
  slots: number;
  /** Method sets for dynamic dispatch: method name -> function. */
  methods: Record<string, FuncId>;
  /** Methods of the pointer type *T (includes promoted value methods). */
  ptrMethods: Record<string, FuncId>;
}

export interface Field {
  name: string;
  type: TypeId;
  /** Slot offset of the field inside the struct. */
  offset: number;
  embedded: boolean;
}

// -------------------------------------------------------------- globals

export interface Global {
  /** Qualified name, e.g. "github.com/microsoft/typescript-go/internal/ast.someVar". */
  name: string;
  /** The type of the variable (the global itself is a pointer to it). */
  type: TypeId;
}

// ---------------------------------------------------------------- funcs

export interface Func {
  /** Qualified name as go/ssa prints it (unique within the program). */
  name: string;
  /** Signature type (k: "func"). */
  sig: TypeId;
  params: number;
  freeVars: number;
  /** Total registers (params + freeVars + instruction results). */
  regs: number;
  /** Type of each register. */
  regTypes: TypeId[];
  /** Entry block is 0. Empty for `body: "trap"` and `"intrinsic"`. */
  blocks: Block[];
  /**
   * "ir": normal; "trap": calling it aborts with `trap` (unsupported or
   * pruned); "intrinsic": implemented by the runtime under `intrinsic`.
   */
  body: "ir" | "trap" | "intrinsic";
  trap?: string;
  intrinsic?: string;
  /** Has a `recover()` and defers (go/ssa's Recover block), else -1. */
  recover: number;
  pos?: string;
}

export interface Block {
  /** Predecessor block indices, in go/ssa order (Phi edges follow this). */
  preds: number[];
  /** Successors: `jump` -> [next]; `if` -> [then, else]; else []. */
  succs: number[];
  instrs: Instr[];
}

/** An operand. Constants are inline; aggregates of constants are allowed. */
export type Operand =
  | { r: Reg }
  | { c: Const; t: TypeId }
  /** Address of a global (pointer to its type). */
  | { g: GlobalId }
  /** A function value with no free variables. */
  | { f: FuncId }
  /** The zero value of a type (any type, including aggregates). */
  | { zero: TypeId };

/**
 * Constant scalars. Integers as decimal strings (64-bit safe); floats as the
 * bit pattern in hex ("0x3ff0000000000000"); strings as byte strings where
 * each char code is one byte 0..255 (UTF-8 already encoded); nil as null.
 */
export type Const = boolean | string | null | { i: string } | { fbits: string };

export type BinOpKind =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "&"
  | "|"
  | "^"
  | "&^"
  | "<<"
  | ">>"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">=";

/** Callee forms. */
export type Callee =
  | { static: FuncId }
  /** Call a func value (closure, bound method, or {f}). */
  | { value: Operand }
  /** Interface method call: dynamic dispatch on the receiver's type. */
  | { invoke: Operand; method: string }
  | { builtin: Builtin };

export type Builtin =
  | "len"
  | "cap"
  | "append"
  | "copy"
  | "delete"
  | "clear"
  | "min"
  | "max"
  | "print"
  | "println"
  | "recover"
  | "close"
  /** go/ssa's "ssa:wrapnilchk": panics if the pointer is nil. */
  | "wrapnilchk"
  /**
   * go/ssa's "ssa:deferstack": no args; the result (type opaque
   * "deferstack") names the calling frame's defer list, for `defer` with
   * `stack` in range-over-func bodies.
   */
  | "deferstack";

/**
 * Instructions. `dst` is the result register when the instruction has a
 * value. `t` on value instructions is the result type.
 */
export type Instr =
  // memory
  | { op: "alloc"; dst: Reg; t: TypeId; elem: TypeId; heap: boolean }
  | { op: "load"; dst: Reg; t: TypeId; ptr: Operand }
  | { op: "store"; ptr: Operand; val: Operand }
  | { op: "fieldAddr"; dst: Reg; t: TypeId; x: Operand; field: number }
  | { op: "field"; dst: Reg; t: TypeId; x: Operand; field: number }
  | { op: "indexAddr"; dst: Reg; t: TypeId; x: Operand; index: Operand }
  | { op: "index"; dst: Reg; t: TypeId; x: Operand; index: Operand }
  // arithmetic
  | { op: "binop"; dst: Reg; t: TypeId; kind: BinOpKind; x: Operand; y: Operand }
  | { op: "unop"; dst: Reg; t: TypeId; kind: "-" | "!" | "^"; x: Operand }
  /** Integer/bool/string conversions; float conversions are lowered to calls. */
  | { op: "convert"; dst: Reg; t: TypeId; x: Operand }
  /** Same underlying type, no value change. */
  | { op: "changeType"; dst: Reg; t: TypeId; x: Operand }
  // composite
  | { op: "makeSlice"; dst: Reg; t: TypeId; len: Operand; cap: Operand }
  | { op: "slice"; dst: Reg; t: TypeId; x: Operand; low?: Operand; high?: Operand; max?: Operand }
  | { op: "sliceToArrayPtr"; dst: Reg; t: TypeId; x: Operand }
  | { op: "makeMap"; dst: Reg; t: TypeId; reserve?: Operand }
  | { op: "lookup"; dst: Reg; t: TypeId; x: Operand; index: Operand; commaOk: boolean }
  | { op: "mapUpdate"; map: Operand; key: Operand; val: Operand }
  | { op: "makeChan"; dst: Reg; t: TypeId; size: Operand }
  | { op: "send"; chan: Operand; val: Operand }
  | { op: "recv"; dst: Reg; t: TypeId; chan: Operand; commaOk: boolean }
  // interfaces
  | { op: "makeInterface"; dst: Reg; t: TypeId; x: Operand; xt: TypeId }
  | { op: "changeInterface"; dst: Reg; t: TypeId; x: Operand }
  /** x.(T): T concrete or interface. commaOk => tuple (value, ok). */
  | { op: "typeAssert"; dst: Reg; t: TypeId; x: Operand; assert: TypeId; commaOk: boolean }
  // closures
  | { op: "makeClosure"; dst: Reg; t: TypeId; fn: FuncId; bindings: Operand[] }
  // calls and tuples
  | { op: "call"; dst?: Reg; t?: TypeId; callee: Callee; args: Operand[] }
  | { op: "extract"; dst: Reg; t: TypeId; tuple: Operand; index: number }
  // iteration (maps and strings; range-over-func is plain closures)
  | { op: "range"; dst: Reg; t: TypeId; x: Operand }
  /** Tuple (ok, key, value). Map iteration order: insertion order. */
  | { op: "next"; dst: Reg; t: TypeId; iter: Operand; isString: boolean }
  // control
  | { op: "phi"; dst: Reg; t: TypeId; edges: Operand[] }
  | { op: "jump" }
  | { op: "if"; cond: Operand }
  | { op: "return"; results: Operand[] }
  | { op: "panic"; x: Operand }
  /**
   * Pushes a deferred call onto the current frame's defer list, or, with
   * `stack` (a "deferstack" value), onto that frame's: a `defer` in a
   * range-over-func body targets the enclosing function's frame.
   */
  | { op: "defer"; callee: Callee; args: Operand[]; stack?: Operand }
  | { op: "runDefers" }
  /** Unsupported operation reached at run time (go, select, unsafe, ...). */
  | { op: "trap"; what: string };
