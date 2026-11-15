package main

// JSON shapes of src/ir/types.ts. Field order follows the TypeScript
// declarations; encoding/json writes struct fields in declaration order and
// map keys sorted, so the output is deterministic.

import (
	"encoding/json"
	"strconv"
)

const irVersion = 1

type Program struct {
	Version int               `json:"version"`
	Build   map[string]string `json:"build"`
	Types   []any             `json:"types"`
	Globals []Global          `json:"globals"`
	Funcs   []*Func           `json:"funcs"`
	Init    int               `json:"init"`
	Main    *int              `json:"main"`
	Entries map[string]int    `json:"entries"`
}

type Global struct {
	Name string `json:"name"`
	Type int    `json:"type"`
}

type Func struct {
	Name      string   `json:"name"`
	Sig       int      `json:"sig"`
	Params    int      `json:"params"`
	FreeVars  int      `json:"freeVars"`
	Regs      int      `json:"regs"`
	RegTypes  []int    `json:"regTypes"`
	Blocks    []*Block `json:"blocks"`
	Body      string   `json:"body"`
	Trap      string   `json:"trap,omitempty"`
	Intrinsic string   `json:"intrinsic,omitempty"`
	Recover   int      `json:"recover"`
	Pos       string   `json:"pos,omitempty"`
}

type Block struct {
	Preds  []int `json:"preds"`
	Succs  []int `json:"succs"`
	Instrs []any `json:"instrs"`
}

// ---------------------------------------------------------------- types

type TBasic struct {
	K     string `json:"k"`
	Slots int    `json:"slots"`
}
type TInt struct {
	K     string `json:"k"`
	Int   string `json:"int"`
	Name  string `json:"name,omitempty"`
	Slots int    `json:"slots"`
}
type TFloat struct {
	K     string `json:"k"`
	Bits  int    `json:"bits"`
	Slots int    `json:"slots"`
}
type TElem struct { // pointer, slice, chan
	K     string `json:"k"`
	Elem  int    `json:"elem"`
	Slots int    `json:"slots"`
}
type TArray struct {
	K     string `json:"k"`
	Elem  int    `json:"elem"`
	Len   int64  `json:"len"`
	Slots int    `json:"slots"`
}
type TStruct struct {
	K      string  `json:"k"`
	Fields []Field `json:"fields"`
	Slots  int     `json:"slots"`
}
type Field struct {
	Name     string `json:"name"`
	Type     int    `json:"type"`
	Offset   int    `json:"offset"`
	Embedded bool   `json:"embedded"`
}
type TMap struct {
	K     string `json:"k"`
	Key   int    `json:"key"`
	Elem  int    `json:"elem"`
	Slots int    `json:"slots"`
}
type TFunc struct {
	K        string `json:"k"`
	Params   []int  `json:"params"`
	Results  []int  `json:"results"`
	Variadic bool   `json:"variadic"`
	Slots    int    `json:"slots"`
}
type TInterface struct {
	K       string   `json:"k"`
	Methods []string `json:"methods"`
	Slots   int      `json:"slots"`
}
type TTuple struct {
	K     string `json:"k"`
	Elems []int  `json:"elems"`
	Slots int    `json:"slots"`
}
type TOpaque struct {
	K     string `json:"k"`
	What  string `json:"what"`
	Slots int    `json:"slots"`
}
type TNamed struct {
	K          string         `json:"k"`
	Name       string         `json:"name"`
	Underlying int            `json:"underlying"`
	Slots      int            `json:"slots"`
	Methods    map[string]int `json:"methods"`
	PtrMethods map[string]int `json:"ptrMethods"`
}

// ------------------------------------------------------------- operands

type Operand struct {
	R    *int            `json:"r,omitempty"`
	C    json.RawMessage `json:"c,omitempty"`
	T    *int            `json:"t,omitempty"`
	G    *int            `json:"g,omitempty"`
	F    *int            `json:"f,omitempty"`
	Zero *int            `json:"zero,omitempty"`
}

func ip(i int) *int { return &i }

func opReg(r int) Operand    { return Operand{R: ip(r)} }
func opGlobal(g int) Operand { return Operand{G: ip(g)} }
func opFunc(f int) Operand   { return Operand{F: ip(f)} }
func opZero(t int) Operand   { return Operand{Zero: ip(t)} }
func opConst(c string, t int) Operand {
	return Operand{C: json.RawMessage(c), T: ip(t)}
}
func opInt(v int64, t int) Operand { return opConst(`{"i":"`+strconv.FormatInt(v, 10)+`"}`, t) }

type Callee struct {
	Static  *int     `json:"static,omitempty"`
	Value   *Operand `json:"value,omitempty"`
	Invoke  *Operand `json:"invoke,omitempty"`
	Method  string   `json:"method,omitempty"`
	Builtin string   `json:"builtin,omitempty"`
}

// --------------------------------------------------------- instructions
// One struct per op; field names and order as in src/ir/types.ts.

type IAlloc struct {
	Op   string `json:"op"`
	Dst  int    `json:"dst"`
	T    int    `json:"t"`
	Elem int    `json:"elem"`
	Heap bool   `json:"heap"`
}
type ILoad struct {
	Op  string  `json:"op"`
	Dst int     `json:"dst"`
	T   int     `json:"t"`
	Ptr Operand `json:"ptr"`
}
type IStore struct {
	Op  string  `json:"op"`
	Ptr Operand `json:"ptr"`
	Val Operand `json:"val"`
}
type IField struct { // fieldAddr, field
	Op    string  `json:"op"`
	Dst   int     `json:"dst"`
	T     int     `json:"t"`
	X     Operand `json:"x"`
	Field int     `json:"field"`
}
type IIndex struct { // indexAddr, index
	Op    string  `json:"op"`
	Dst   int     `json:"dst"`
	T     int     `json:"t"`
	X     Operand `json:"x"`
	Index Operand `json:"index"`
}
type IBinop struct {
	Op   string  `json:"op"`
	Dst  int     `json:"dst"`
	T    int     `json:"t"`
	Kind string  `json:"kind"`
	X    Operand `json:"x"`
	Y    Operand `json:"y"`
}
type IUnop struct {
	Op   string  `json:"op"`
	Dst  int     `json:"dst"`
	T    int     `json:"t"`
	Kind string  `json:"kind"`
	X    Operand `json:"x"`
}
type IX struct { // convert, changeType, sliceToArrayPtr, changeInterface, range
	Op  string  `json:"op"`
	Dst int     `json:"dst"`
	T   int     `json:"t"`
	X   Operand `json:"x"`
}
type IMakeSlice struct {
	Op  string  `json:"op"`
	Dst int     `json:"dst"`
	T   int     `json:"t"`
	Len Operand `json:"len"`
	Cap Operand `json:"cap"`
}
type ISlice struct {
	Op   string   `json:"op"`
	Dst  int      `json:"dst"`
	T    int      `json:"t"`
	X    Operand  `json:"x"`
	Low  *Operand `json:"low,omitempty"`
	High *Operand `json:"high,omitempty"`
	Max  *Operand `json:"max,omitempty"`
}
type IMakeMap struct {
	Op      string   `json:"op"`
	Dst     int      `json:"dst"`
	T       int      `json:"t"`
	Reserve *Operand `json:"reserve,omitempty"`
}
type ILookup struct {
	Op      string  `json:"op"`
	Dst     int     `json:"dst"`
	T       int     `json:"t"`
	X       Operand `json:"x"`
	Index   Operand `json:"index"`
	CommaOk bool    `json:"commaOk"`
}
type IMapUpdate struct {
	Op  string  `json:"op"`
	Map Operand `json:"map"`
	Key Operand `json:"key"`
	Val Operand `json:"val"`
}
type IMakeChan struct {
	Op   string  `json:"op"`
	Dst  int     `json:"dst"`
	T    int     `json:"t"`
	Size Operand `json:"size"`
}
type ISend struct {
	Op   string  `json:"op"`
	Chan Operand `json:"chan"`
	Val  Operand `json:"val"`
}
type IRecv struct {
	Op      string  `json:"op"`
	Dst     int     `json:"dst"`
	T       int     `json:"t"`
	Chan    Operand `json:"chan"`
	CommaOk bool    `json:"commaOk"`
}
type IMakeInterface struct {
	Op  string  `json:"op"`
	Dst int     `json:"dst"`
	T   int     `json:"t"`
	X   Operand `json:"x"`
	XT  int     `json:"xt"`
}
type ITypeAssert struct {
	Op      string  `json:"op"`
	Dst     int     `json:"dst"`
	T       int     `json:"t"`
	X       Operand `json:"x"`
	Assert  int     `json:"assert"`
	CommaOk bool    `json:"commaOk"`
}
type IMakeClosure struct {
	Op       string    `json:"op"`
	Dst      int       `json:"dst"`
	T        int       `json:"t"`
	Fn       int       `json:"fn"`
	Bindings []Operand `json:"bindings"`
}
type ICall struct {
	Op     string    `json:"op"`
	Dst    *int      `json:"dst,omitempty"`
	T      *int      `json:"t,omitempty"`
	Callee Callee    `json:"callee"`
	Args   []Operand `json:"args"`
}
type IExtract struct {
	Op    string  `json:"op"`
	Dst   int     `json:"dst"`
	T     int     `json:"t"`
	Tuple Operand `json:"tuple"`
	Index int     `json:"index"`
}
type INext struct {
	Op       string  `json:"op"`
	Dst      int     `json:"dst"`
	T        int     `json:"t"`
	Iter     Operand `json:"iter"`
	IsString bool    `json:"isString"`
}
type IPhi struct {
	Op    string    `json:"op"`
	Dst   int       `json:"dst"`
	T     int       `json:"t"`
	Edges []Operand `json:"edges"`
}
type IOp struct { // jump, runDefers
	Op string `json:"op"`
}
type IIf struct {
	Op   string  `json:"op"`
	Cond Operand `json:"cond"`
}
type IReturn struct {
	Op      string    `json:"op"`
	Results []Operand `json:"results"`
}
type IPanic struct {
	Op string  `json:"op"`
	X  Operand `json:"x"`
}
type IDefer struct {
	Op     string    `json:"op"`
	Callee Callee    `json:"callee"`
	Args   []Operand `json:"args"`
}
type ITrap struct {
	Op   string `json:"op"`
	What string `json:"what"`
}
