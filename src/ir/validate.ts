/**
 * Strict structural validator of a prog.json against `src/ir/types.ts`:
 * every object has exactly the keys its variant allows, with the right
 * value kinds; every TypeId, FuncId, GlobalId, register and block index is
 * in range; blocks end in one terminator and phis match predecessors.
 * Returns a list of problems (empty = valid); `assertValid` throws.
 */
import { IR_VERSION } from "./types.ts";
import type { Program } from "./types.ts";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isByteString = (s: string) => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 255) return false;
  return true;
};
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

const INT_KINDS = new Set([
  "int8",
  "int16",
  "int32",
  "int64",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
]);
const BINOPS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "&",
  "|",
  "^",
  "&^",
  "<<",
  ">>",
  "==",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
]);
const BUILTINS = new Set([
  "len",
  "cap",
  "append",
  "copy",
  "delete",
  "clear",
  "min",
  "max",
  "print",
  "println",
  "recover",
  "close",
  "wrapnilchk",
]);
const TERMINATORS = new Set(["jump", "if", "return", "panic"]);

/** Instruction shapes: key -> kind of value. "?" suffix = optional. */
type Kind =
  | "reg"
  | "dst"
  | "type"
  | "func"
  | "op"
  | "ops"
  | "bool"
  | "int"
  | "str"
  | "callee"
  | "binop"
  | "unop";
const INSTRS: Record<string, Record<string, Kind | `${Kind}?`>> = {
  alloc: { dst: "dst", t: "type", elem: "type", heap: "bool" },
  load: { dst: "dst", t: "type", ptr: "op" },
  store: { ptr: "op", val: "op" },
  fieldAddr: { dst: "dst", t: "type", x: "op", field: "int" },
  field: { dst: "dst", t: "type", x: "op", field: "int" },
  indexAddr: { dst: "dst", t: "type", x: "op", index: "op" },
  index: { dst: "dst", t: "type", x: "op", index: "op" },
  binop: { dst: "dst", t: "type", kind: "binop", x: "op", y: "op" },
  unop: { dst: "dst", t: "type", kind: "unop", x: "op" },
  convert: { dst: "dst", t: "type", x: "op" },
  changeType: { dst: "dst", t: "type", x: "op" },
  makeSlice: { dst: "dst", t: "type", len: "op", cap: "op" },
  slice: { dst: "dst", t: "type", x: "op", low: "op?", high: "op?", max: "op?" },
  sliceToArrayPtr: { dst: "dst", t: "type", x: "op" },
  makeMap: { dst: "dst", t: "type", reserve: "op?" },
  lookup: { dst: "dst", t: "type", x: "op", index: "op", commaOk: "bool" },
  mapUpdate: { map: "op", key: "op", val: "op" },
  makeChan: { dst: "dst", t: "type", size: "op" },
  send: { chan: "op", val: "op" },
  recv: { dst: "dst", t: "type", chan: "op", commaOk: "bool" },
  makeInterface: { dst: "dst", t: "type", x: "op", xt: "type" },
  changeInterface: { dst: "dst", t: "type", x: "op" },
  typeAssert: { dst: "dst", t: "type", x: "op", assert: "type", commaOk: "bool" },
  makeClosure: { dst: "dst", t: "type", fn: "func", bindings: "ops" },
  call: { dst: "dst?", t: "type?", callee: "callee", args: "ops" },
  extract: { dst: "dst", t: "type", tuple: "op", index: "int" },
  range: { dst: "dst", t: "type", x: "op" },
  next: { dst: "dst", t: "type", iter: "op", isString: "bool" },
  phi: { dst: "dst", t: "type", edges: "ops" },
  jump: {},
  if: { cond: "op" },
  return: { results: "ops" },
  panic: { x: "op" },
  defer: { callee: "callee", args: "ops" },
  runDefers: {},
  trap: { what: "str" },
};

export function validate(p: unknown): string[] {
  const errs: string[] = [];
  const err = (where: string, msg: string) => {
    if (errs.length < 200) errs.push(`${where}: ${msg}`);
  };
  const keys = (where: string, o: Obj, req: string[], opt: string[] = []) => {
    for (const k of req) if (!(k in o)) err(where, `missing ${k}`);
    for (const k of Object.keys(o))
      if (!req.includes(k) && !opt.includes(k)) err(where, `unexpected key ${k}`);
  };
  if (!isObj(p)) return ["program: not an object"];
  keys("program", p, ["version", "build", "types", "globals", "funcs", "init", "main", "entries"]);
  if (p.version !== IR_VERSION) err("program", `version ${String(p.version)} != ${IR_VERSION}`);
  if (!isObj(p.build) || Object.values(p.build).some((v) => typeof v !== "string"))
    err("build", "not a string record");
  const types = Array.isArray(p.types) ? p.types : [];
  const globals = Array.isArray(p.globals) ? p.globals : [];
  const funcs = Array.isArray(p.funcs) ? p.funcs : [];
  if (!Array.isArray(p.types) || !Array.isArray(p.globals) || !Array.isArray(p.funcs))
    err("program", "types/globals/funcs must be arrays");
  const typeOk = (v: unknown) => isInt(v) && v < types.length;
  const funcOk = (v: unknown) => isInt(v) && v < funcs.length;

  // ---------------------------------------------------------- types
  const slotsOf = (id: number): number =>
    isObj(types[id]) && isInt(types[id].slots) ? types[id].slots : -1;
  types.forEach((t: unknown, i: number) => {
    const w = `types[${i}]`;
    if (!isObj(t)) return err(w, "not an object");
    const tid = (k: string) => {
      if (!typeOk(t[k])) err(w, `${k} is not a TypeId`);
    };
    const tids = (k: string) => {
      if (!Array.isArray(t[k]) || !t[k].every(typeOk)) err(w, `${k} is not a TypeId[]`);
    };
    const one = () => {
      if (t.slots !== 1) err(w, "slots must be 1");
    };
    switch (t.k) {
      case "bool":
      case "string":
        keys(w, t, ["k", "slots"]);
        one();
        break;
      case "int":
        keys(w, t, ["k", "int", "slots"], ["name"]);
        if (!INT_KINDS.has(t.int as string)) err(w, "bad int kind");
        if ("name" in t && !["int", "uint", "uintptr"].includes(t.name as string))
          err(w, "bad int name");
        one();
        break;
      case "float":
        keys(w, t, ["k", "bits", "slots"]);
        if (t.bits !== 32 && t.bits !== 64) err(w, "bad bits");
        one();
        break;
      case "pointer":
      case "slice":
      case "chan":
        keys(w, t, ["k", "elem", "slots"]);
        tid("elem");
        one();
        break;
      case "array":
        keys(w, t, ["k", "elem", "len", "slots"]);
        tid("elem");
        if (!isInt(t.len)) err(w, "bad len");
        break;
      case "struct": {
        keys(w, t, ["k", "fields", "slots"]);
        if (!Array.isArray(t.fields)) {
          err(w, "fields not an array");
          break;
        }
        t.fields.forEach((f: unknown, j: number) => {
          const fw = `${w}.fields[${j}]`;
          if (!isObj(f)) return err(fw, "not an object");
          keys(fw, f, ["name", "type", "offset", "embedded"]);
          if (typeof f.name !== "string") err(fw, "bad name");
          if (!typeOk(f.type)) err(fw, "bad type");
          if (!isInt(f.offset)) err(fw, "bad offset");
          if (typeof f.embedded !== "boolean") err(fw, "bad embedded");
        });
        break;
      }
      case "map":
        keys(w, t, ["k", "key", "elem", "slots"]);
        tid("key");
        tid("elem");
        one();
        break;
      case "func":
        keys(w, t, ["k", "params", "results", "variadic", "slots"]);
        tids("params");
        tids("results");
        if (typeof t.variadic !== "boolean") err(w, "bad variadic");
        one();
        break;
      case "interface":
        keys(w, t, ["k", "methods", "sigs", "slots"]);
        if (!Array.isArray(t.methods) || !t.methods.every((m) => typeof m === "string"))
          err(w, "bad methods");
        tids("sigs");
        if (Array.isArray(t.sigs) && Array.isArray(t.methods) && t.sigs.length !== t.methods.length)
          err(w, "sigs and methods differ in length");
        one();
        break;
      case "tuple":
        keys(w, t, ["k", "elems", "slots"]);
        tids("elems");
        break;
      case "opaque":
        keys(w, t, ["k", "what", "slots"]);
        if (typeof t.what !== "string") err(w, "bad what");
        one();
        break;
      case "named": {
        keys(w, t, ["k", "name", "underlying", "slots", "methods", "ptrMethods"]);
        if (typeof t.name !== "string") err(w, "bad name");
        tid("underlying");
        for (const m of ["methods", "ptrMethods"]) {
          const ms = t[m];
          if (!isObj(ms) || !Object.values(ms).every(funcOk))
            err(w, `${m} is not a name -> FuncId record`);
        }
        break;
      }
      default:
        err(w, `unknown kind ${String(t.k)}`);
    }
    if (!isInt(t.slots)) err(w, "bad slots");
  });
  // Slot counts are consistent (second pass, all types known).
  types.forEach((t: unknown, i: number) => {
    if (!isObj(t)) return;
    const w = `types[${i}]`;
    if (
      t.k === "array" &&
      typeOk(t.elem) &&
      isInt(t.len) &&
      t.slots !== t.len * slotsOf(t.elem as number)
    )
      err(w, "array slots != len * elem slots");
    if (t.k === "named" && typeOk(t.underlying) && t.slots !== slotsOf(t.underlying as number))
      err(w, "named slots != underlying slots");
    if (t.k === "struct" && Array.isArray(t.fields)) {
      let off = 0;
      for (const f of t.fields as Obj[]) {
        if (f.offset !== off)
          err(w, `field ${String(f.name)} offset ${String(f.offset)} != ${off}`);
        off += typeOk(f.type) ? slotsOf(f.type as number) : 0;
      }
      if (t.slots !== off) err(w, "struct slots != sum of fields");
    }
    if (t.k === "tuple" && Array.isArray(t.elems)) {
      const n = (t.elems as number[]).reduce((a, e) => a + (typeOk(e) ? slotsOf(e) : 0), 0);
      if (t.slots !== n) err(w, "tuple slots != sum of elems");
    }
  });

  // -------------------------------------------------------- globals
  globals.forEach((g: unknown, i: number) => {
    const w = `globals[${i}]`;
    if (!isObj(g)) return err(w, "not an object");
    keys(w, g, ["name", "type"]);
    if (typeof g.name !== "string") err(w, "bad name");
    if (!typeOk(g.type)) err(w, "bad type");
  });

  // ---------------------------------------------------------- funcs
  const names = new Set<string>();
  funcs.forEach((f: unknown, fi: number) => {
    const w = `funcs[${fi}]`;
    if (!isObj(f)) return err(w, "not an object");
    keys(
      w,
      f,
      ["name", "sig", "params", "freeVars", "regs", "regTypes", "blocks", "body", "recover"],
      ["trap", "intrinsic", "pos"],
    );
    const fw = `${w} ${String(f.name)}`;
    if (typeof f.name !== "string") err(w, "bad name");
    else if (names.has(f.name)) err(fw, "duplicate name");
    else names.add(f.name);
    if (!typeOk(f.sig) || (types[f.sig as number] as Obj)?.k !== "func")
      err(fw, "sig is not a func type");
    if (!isInt(f.params) || !isInt(f.freeVars) || !isInt(f.regs))
      return err(fw, "bad register counts");
    if (!Array.isArray(f.regTypes) || f.regTypes.length !== f.regs || !f.regTypes.every(typeOk))
      err(fw, "regTypes must be regs TypeIds");
    if (f.params + f.freeVars > f.regs) err(fw, "params + freeVars > regs");
    if (typeOk(f.sig)) {
      const sig = types[f.sig as number] as Obj;
      if (Array.isArray(sig.params) && sig.params.length !== f.params)
        err(fw, "params != signature params");
    }
    if ("pos" in f && typeof f.pos !== "string") err(fw, "bad pos");
    const blocks = Array.isArray(f.blocks) ? (f.blocks as unknown[]) : [];
    if (!Array.isArray(f.blocks)) err(fw, "blocks not an array");
    switch (f.body) {
      case "ir":
        if (blocks.length === 0) err(fw, "ir body without blocks");
        if ("trap" in f || "intrinsic" in f) err(fw, "ir body with trap/intrinsic");
        break;
      case "trap":
        if (typeof f.trap !== "string" || "intrinsic" in f) err(fw, "trap body needs trap (only)");
        if (blocks.length) err(fw, "trap body with blocks");
        break;
      case "intrinsic":
        if (typeof f.intrinsic !== "string" || "trap" in f)
          err(fw, "intrinsic body needs intrinsic (only)");
        if (blocks.length) err(fw, "intrinsic body with blocks");
        break;
      default:
        err(fw, `bad body ${String(f.body)}`);
    }
    if (!(f.recover === -1 || (isInt(f.recover) && f.recover < blocks.length)))
      err(fw, "bad recover");
    const regs = f.regs;
    const regOk = (v: unknown): v is number => isInt(v) && v < regs;
    const defined = new Set<number>();
    for (let r = 0; r < f.params + f.freeVars; r++) defined.add(r);
    const operand = (iw: string, o: unknown) => {
      if (!isObj(o)) return err(iw, "operand not an object");
      const ks = Object.keys(o);
      if (ks.length === 1 && ks[0] === "r") {
        if (!regOk(o.r)) err(iw, `register ${String(o.r)} out of range`);
      } else if (ks.length === 2 && "c" in o && "t" in o) {
        if (!typeOk(o.t)) err(iw, "const type out of range");
        const c = o.c;
        const okConst =
          c === null ||
          typeof c === "boolean" ||
          typeof c === "string" ||
          (isObj(c) &&
            Object.keys(c).length === 1 &&
            typeof c.i === "string" &&
            /^-?\d+$/.test(c.i)) ||
          (isObj(c) &&
            Object.keys(c).length === 1 &&
            typeof c.fbits === "string" &&
            /^0x[0-9a-f]+$/.test(c.fbits));
        if (!okConst) err(iw, `bad constant ${JSON.stringify(c)}`);
        if (typeof c === "string" && !isByteString(c)) err(iw, "string constant char > 255");
      } else if (ks.length === 1 && ks[0] === "g") {
        if (!(isInt(o.g) && o.g < globals.length)) err(iw, "global out of range");
      } else if (ks.length === 1 && ks[0] === "f") {
        if (!funcOk(o.f)) err(iw, "func out of range");
      } else if (ks.length === 1 && ks[0] === "zero") {
        if (!typeOk(o.zero)) err(iw, "zero type out of range");
      } else err(iw, `bad operand ${JSON.stringify(o)}`);
    };
    const callee = (iw: string, c: unknown) => {
      if (!isObj(c)) return err(iw, "callee not an object");
      const ks = Object.keys(c).sort().join(",");
      if (ks === "static") {
        if (!funcOk(c.static)) err(iw, "static callee out of range");
      } else if (ks === "value") operand(iw, c.value);
      else if (ks === "invoke,method") {
        operand(iw, c.invoke);
        if (typeof c.method !== "string") err(iw, "bad method");
      } else if (ks === "builtin") {
        if (!BUILTINS.has(c.builtin as string)) err(iw, `unknown builtin ${String(c.builtin)}`);
      } else err(iw, `bad callee ${JSON.stringify(c)}`);
    };
    blocks.forEach((b: unknown, bi: number) => {
      const bw = `${fw} block ${bi}`;
      if (!isObj(b)) return err(bw, "not an object");
      keys(bw, b, ["preds", "succs", "instrs"]);
      const preds = Array.isArray(b.preds) ? b.preds : [];
      const succs = Array.isArray(b.succs) ? b.succs : [];
      const blockOk = (v: unknown) => isInt(v) && v < blocks.length;
      if (!preds.every(blockOk) || !succs.every(blockOk)) err(bw, "pred/succ out of range");
      const instrs = Array.isArray(b.instrs) ? (b.instrs as unknown[]) : [];
      if (instrs.length === 0) return err(bw, "empty block");
      let seenNonPhi = false;
      instrs.forEach((ins: unknown, ii: number) => {
        const iw = `${bw} instr ${ii}`;
        if (!isObj(ins)) return err(iw, "not an object");
        const op = ins.op as string;
        const shape = INSTRS[op];
        if (!shape) return err(iw, `unknown op ${String(op)}`);
        const req = ["op"];
        const opt: string[] = [];
        for (const [k, kind] of Object.entries(shape)) (kind.endsWith("?") ? opt : req).push(k);
        keys(`${iw} (${op})`, ins, req, opt);
        for (const [k, kind0] of Object.entries(shape)) {
          if (!(k in ins)) continue;
          const v = ins[k];
          const kind = kind0.replace("?", "") as Kind;
          const kw = `${iw} (${op}.${k})`;
          switch (kind) {
            case "dst":
              if (!regOk(v)) err(kw, "dst out of range");
              else if (v < (f.params as number) + (f.freeVars as number))
                err(kw, "dst is a param or free var");
              else defined.add(v);
              break;
            case "type":
              if (!typeOk(v)) err(kw, "type out of range");
              break;
            case "func":
              if (!funcOk(v)) err(kw, "func out of range");
              break;
            case "op":
              operand(kw, v);
              break;
            case "ops":
              if (!Array.isArray(v)) err(kw, "not an array");
              else v.forEach((o) => operand(kw, o));
              break;
            case "bool":
              if (typeof v !== "boolean") err(kw, "not a boolean");
              break;
            case "int":
              if (!isInt(v)) err(kw, "not an index");
              break;
            case "str":
              if (typeof v !== "string") err(kw, "not a string");
              break;
            case "callee":
              callee(kw, v);
              break;
            case "binop":
              if (!BINOPS.has(v as string)) err(kw, "bad binop kind");
              break;
            case "unop":
              if (!["-", "!", "^"].includes(v as string)) err(kw, "bad unop kind");
              break;
          }
        }
        if (op === "call" && "dst" in ins !== "t" in ins)
          err(iw, "call needs both dst and t or neither");
        if (
          "dst" in ins &&
          "t" in ins &&
          regOk(ins.dst) &&
          Array.isArray(f.regTypes) &&
          f.regTypes[ins.dst as number] !== ins.t
        )
          err(iw, "t != regTypes[dst]");
        if (op === "phi") {
          if (seenNonPhi) err(iw, "phi after non-phi");
          if (Array.isArray(ins.edges) && ins.edges.length !== preds.length)
            err(iw, "phi edges != preds");
        } else seenNonPhi = true;
        const last = ii === instrs.length - 1;
        if (TERMINATORS.has(op) && !last) err(iw, `${op} not last in block`);
        if (last && !TERMINATORS.has(op)) err(iw, `block ends in ${op}, not a terminator`);
        if (last) {
          const want = op === "jump" ? 1 : op === "if" ? 2 : 0;
          if (succs.length !== want) err(iw, `${op} with ${succs.length} succs`);
        }
      });
    });
  });
  // Block pred/succ symmetry and register single assignment are not
  // re-derived here beyond range checks; go/ssa guarantees them.

  if (!funcOk(p.init)) err("program", "init out of range");
  if (!(p.main === null || funcOk(p.main))) err("program", "main out of range");
  if (!isObj(p.entries) || !Object.values(p.entries).every(funcOk)) err("program", "bad entries");
  // Method tables: every method name of a named type maps to a func.
  return errs;
}

export function assertValid(p: unknown): asserts p is Program {
  const errs = validate(p);
  if (errs.length)
    throw new Error(`invalid IR (${errs.length} problems):\n${errs.slice(0, 30).join("\n")}`);
}
