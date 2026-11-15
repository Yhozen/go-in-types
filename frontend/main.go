// Command frontend compiles a Go program to go-in-types IR (prog.json):
// go/packages load -> go/ssa with instantiated generics -> reachable
// functions -> lowered IR. The contract is docs/DESIGN.md ("Front end")
// and src/ir/types.ts.
//
//	frontend [-C dir] [-overlay json] [-o prog.json] [-keep file] <pkg or file.go>... [-entry name=pkg.Func]...
package main

import (
	"bufio"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"go/types"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"golang.org/x/tools/go/callgraph"
	"golang.org/x/tools/go/callgraph/rta"
	"golang.org/x/tools/go/callgraph/vta"
	"golang.org/x/tools/go/packages"
	"golang.org/x/tools/go/ssa"
	"golang.org/x/tools/go/ssa/ssautil"
	"golang.org/x/tools/go/types/typeutil"
)

//go:embed softfloat/api.go softfloat/softfloat64.go
var softfloatFS embed.FS

const softfloatPkg = "gointypes/softfloat"

type entryFlags []string

func (e *entryFlags) String() string     { return strings.Join(*e, ",") }
func (e *entryFlags) Set(s string) error { *e = append(*e, s); return nil }

var (
	flagDir      = flag.String("C", ".", "directory to load from (module root or the file's directory)")
	flagOverlay  = flag.String("overlay", "", "go build -overlay JSON ({\"Replace\": {dst: src}})")
	flagOut      = flag.String("o", "prog.json", "output file (- for stdout)")
	flagKeep     = flag.String("keep", "", "size mode: only functions named in this file (one per line) get bodies")
	flagGOOS     = flag.String("goos", "linux", "GOOS")
	flagGOARCH   = flag.String("goarch", "amd64", "GOARCH")
	flagTags     = flag.String("tags", "purego", "build tags")
	flagDispatch = flag.Bool("dispatch", true, "add methods reachable by interface dispatch (types made into interfaces x invoked names)")
	flagMapping  = flag.Bool("mapping", false, "print the go/ssa -> IR instruction mapping and exit")
	flagBodyless = flag.Bool("bodyless", false, "list emitted functions that trap because they have no body")
	flagIndent   = flag.Bool("indent", false, "indent the JSON")
	entries      entryFlags
)

type frontend struct {
	prog     *ssa.Program
	tt       *typeTable
	funcIDs  map[*ssa.Function]int
	funcs    []*Func
	ssaFuncs []*ssa.Function
	queue    []*ssa.Function
	globals  map[*ssa.Global]int
	globList []Global
	sf       *ssa.Package
	keep     map[string]bool
	sizes    types.Sizes
	names    map[string]int

	ifaceTypes typeutil.Map // dynamic types put in interfaces
	ifaceList  []types.Type
	invoked    map[string]bool
	stats      struct{ trapInstrs, trapFuncs, intrinsics int }
	bodyless   []string
}

func main() {
	log.SetFlags(0)
	log.SetPrefix("frontend: ")
	flag.Var(&entries, "entry", "name=pkgpath.Func: a host entry point (repeatable)")
	// Flags may follow the positional arguments.
	var patterns []string
	args := os.Args[1:]
	for {
		if err := flag.CommandLine.Parse(args); err != nil {
			os.Exit(2)
		}
		args = flag.Args()
		if len(args) == 0 {
			break
		}
		patterns = append(patterns, args[0])
		args = args[1:]
	}
	if *flagMapping {
		for _, m := range instrMapping {
			fmt.Printf("%-28s %s\n", m[0], m[1])
		}
		return
	}
	if len(patterns) == 0 {
		log.Fatal("usage: frontend [flags] <pkg or file.go>...")
	}
	t0 := time.Now()
	prog, build := run(patterns)
	write(prog)
	log.Printf("%s: %d funcs (%d trap, %d intrinsic), %d blocks, %d instrs (%d trap), %d types, %d globals in %s",
		*flagOut, len(prog.Funcs), build.stats.trapFuncs, build.stats.intrinsics, countBlocks(prog), countInstrs(prog),
		build.stats.trapInstrs, len(prog.Types), len(prog.Globals), time.Since(t0).Round(time.Millisecond))
	if *flagBodyless {
		for _, n := range build.bodyless {
			fmt.Fprintln(os.Stderr, "bodyless:", n)
		}
	}
}

func countBlocks(p *Program) (n int) {
	for _, f := range p.Funcs {
		n += len(f.Blocks)
	}
	return
}

func countInstrs(p *Program) (n int) {
	for _, f := range p.Funcs {
		for _, b := range f.Blocks {
			n += len(b.Instrs)
		}
	}
	return
}

func write(p *Program) {
	var w *os.File
	if *flagOut == "-" {
		w = os.Stdout
	} else {
		f, err := os.Create(*flagOut)
		if err != nil {
			log.Fatal(err)
		}
		defer f.Close()
		w = f
	}
	bw := bufio.NewWriterSize(w, 1<<20)
	enc := json.NewEncoder(bw)
	enc.SetEscapeHTML(false)
	if *flagIndent {
		enc.SetIndent("", " ")
	}
	if err := enc.Encode(p); err != nil {
		log.Fatal(err)
	}
	if err := bw.Flush(); err != nil {
		log.Fatal(err)
	}
}

func goEnv(env []string, name string) string {
	cmd := exec.Command("go", "env", name)
	cmd.Env = env
	out, err := cmd.Output()
	if err != nil {
		log.Fatalf("go env %s: %v", name, err)
	}
	return strings.TrimSpace(string(out))
}

func run(patterns []string) (*Program, *frontend) {
	dir, err := filepath.Abs(*flagDir)
	if err != nil {
		log.Fatal(err)
	}
	env := append(os.Environ(), "CGO_ENABLED=0", "GOOS="+*flagGOOS, "GOARCH="+*flagGOARCH, "GOFLAGS=")
	goroot := goEnv(env, "GOROOT")
	overlay := map[string][]byte{}
	if *flagOverlay != "" {
		overlay = readOverlay(*flagOverlay)
	}
	for _, name := range []string{"api.go", "softfloat64.go"} {
		b, _ := softfloatFS.ReadFile("softfloat/" + name)
		overlay[filepath.Join(goroot, "src", softfloatPkg, name)] = b
	}
	buildFlags := []string{}
	if *flagTags != "" {
		buildFlags = append(buildFlags, "-tags="+*flagTags)
	}

	// Find the first package's directory and name, then add a file that
	// imports the soft-float package to it (file patterns name it too).
	probe, err := packages.Load(&packages.Config{Mode: packages.NeedName | packages.NeedFiles, Dir: dir, Env: env, BuildFlags: buildFlags, Overlay: overlay}, patterns...)
	if err != nil {
		log.Fatal(err)
	}
	if len(probe) == 0 || len(probe[0].GoFiles) == 0 {
		log.Fatalf("no Go files for %v", patterns)
	}
	pdir := filepath.Dir(probe[0].GoFiles[0])
	sfImport := filepath.Join(pdir, "zz_gointypes_softfloat.go")
	overlay[sfImport] = []byte("package " + probe[0].Name + "\n\nimport _ \"" + softfloatPkg + "\"\n\n// runtime: the panic value types (errorString, plainError) the reference uses.\nimport _ \"runtime\"\n")
	if strings.HasSuffix(patterns[len(patterns)-1], ".go") {
		for i, p := range patterns {
			if !filepath.IsAbs(p) {
				patterns[i] = filepath.Join(dir, p)
			}
		}
		patterns = append(patterns, sfImport)
	}

	cfg := &packages.Config{
		Mode: packages.NeedName | packages.NeedFiles | packages.NeedCompiledGoFiles | packages.NeedImports |
			packages.NeedDeps | packages.NeedTypes | packages.NeedSyntax | packages.NeedTypesInfo |
			packages.NeedTypesSizes | packages.NeedModule,
		Dir: dir, Env: env, BuildFlags: buildFlags, Overlay: overlay,
	}
	initial, err := packages.Load(cfg, patterns...)
	if err != nil {
		log.Fatal(err)
	}
	if packages.PrintErrors(initial) > 0 {
		log.Fatal("package errors")
	}
	sp, pkgs := ssautil.AllPackages(initial, ssa.InstantiateGenerics|ssa.BuildSerially)
	sp.Build()

	fe := &frontend{prog: sp, tt: &typeTable{}, funcIDs: map[*ssa.Function]int{}, globals: map[*ssa.Global]int{},
		invoked: map[string]bool{}, names: map[string]int{}}
	fe.sizes = types.SizesFor("gc", *flagGOARCH)
	fe.sf = sp.ImportedPackage(softfloatPkg)
	if fe.sf == nil {
		log.Fatal("soft-float package not loaded")
	}
	if *flagKeep != "" {
		fe.keep = readKeep(*flagKeep)
	}

	// Roots: package initializers, main, entries.
	var roots []*ssa.Function
	var mainFn *ssa.Function
	for _, p := range pkgs {
		if p == nil {
			continue
		}
		roots = append(roots, p.Func("init"))
		if p.Pkg.Name() == "main" && mainFn == nil {
			mainFn = p.Func("main")
		}
	}
	if mainFn != nil {
		roots = append(roots, mainFn)
	}
	entryFns := map[string]*ssa.Function{}
	for _, e := range entries {
		name, target, ok := strings.Cut(e, "=")
		dot := strings.LastIndex(target, ".")
		if !ok || dot < 0 {
			log.Fatalf("bad -entry %q (want name=pkgpath.Func)", e)
		}
		p := sp.ImportedPackage(target[:dot])
		if p == nil || p.Func(target[dot+1:]) == nil {
			log.Fatalf("-entry %q: function not found", e)
		}
		entryFns[name] = p.Func(target[dot+1:])
		roots = append(roots, entryFns[name])
	}

	// Reachability: VTA over RTA's graph, then (while lowering) every
	// function referenced by a reachable one (closures, func values, static
	// callees) and the interface-dispatch methods.
	reach := vtaReachable(roots, fe.compiled)
	sorted := make([]*ssa.Function, 0, len(reach))
	for f := range reach {
		sorted = append(sorted, f)
	}
	sort.Slice(sorted, func(i, j int) bool { return funcLess(sp, sorted[i], sorted[j]) })

	// The synthetic init is function 0.
	initSig := fe.tt.id(types.NewSignatureType(nil, nil, nil, nil, nil, false))
	initF := &Func{Name: "gointypes.init", Sig: initSig, RegTypes: []int{}, Body: "ir", Recover: -1}
	fe.funcs = append(fe.funcs, initF)
	fe.ssaFuncs = append(fe.ssaFuncs, nil)
	fe.names[initF.Name] = 0
	initCalls := []any{}
	for _, p := range pkgs {
		if p != nil && p != fe.sf {
			initCalls = append(initCalls, ICall{Op: "call", Callee: Callee{Static: ip(fe.funcID(p.Func("init")))}, Args: []Operand{}})
		}
	}
	initF.Blocks = []*Block{{Preds: []int{}, Succs: []int{}, Instrs: append(initCalls, IReturn{Op: "return", Results: []Operand{}})}}

	for _, f := range sorted {
		fe.funcID(f)
	}
	// The runtime error types the reference uses for runtime panics
	// (errorString: "runtime error: " prefix; plainError: none).
	if rp := sp.ImportedPackage("runtime"); rp != nil {
		for _, name := range []string{"errorString", "plainError"} {
			if tn, ok := rp.Pkg.Scope().Lookup(name).(*types.TypeName); ok {
				fe.tt.id(tn.Type())
				ms := sp.MethodSets.MethodSet(tn.Type())
				for i := 0; i < ms.Len(); i++ {
					fe.funcID(sp.MethodValue(ms.At(i)))
				}
			}
		}
	}
	for {
		for len(fe.queue) > 0 {
			f := fe.queue[0]
			fe.queue = fe.queue[1:]
			fe.lowerFunc(f)
		}
		if !*flagDispatch || !fe.addDispatch() {
			break
		}
	}
	fe.fillMethods()

	out := &Program{
		Version: irVersion,
		Build: map[string]string{
			"goos": *flagGOOS, "goarch": *flagGOARCH, "tags": *flagTags, "cgo": "0",
			"go": runtime.Version(), "dir": dir, "overlay": *flagOverlay, "packages": strings.Join(patterns, " "),
			"keep": *flagKeep, "frontend": "go-in-types/frontend",
		},
		Globals: fe.globList,
		Init:    0,
		Entries: map[string]int{},
	}
	if out.Globals == nil {
		out.Globals = []Global{}
	}
	if mainFn != nil {
		out.Main = ip(fe.funcIDs[mainFn])
	}
	for name, f := range entryFns {
		out.Entries[name] = fe.funcIDs[f]
	}
	out.Funcs = fe.funcs
	out.Types = fe.tt.list
	return out, fe
}

func funcLess(sp *ssa.Program, a, b *ssa.Function) bool {
	as, bs := funcName(a), funcName(b)
	if as != bs {
		return as < bs
	}
	return sp.Fset.Position(a.Pos()).String() < sp.Fset.Position(b.Pos()).String()
}

func vtaReachable(roots []*ssa.Function, expand func(*ssa.Function) bool) map[*ssa.Function]bool {
	res := rta.Analyze(roots, true)
	funcs := map[*ssa.Function]bool{}
	for f := range res.Reachable {
		funcs[f] = true
	}
	cg := vta.CallGraph(funcs, res.CallGraph)
	seen := map[*ssa.Function]bool{}
	stack := []*ssa.Function{}
	for _, r := range roots {
		if !seen[r] {
			seen[r] = true
			stack = append(stack, r)
		}
	}
	for len(stack) > 0 {
		f := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		n := cg.Nodes[f]
		if n == nil || !expand(f) {
			continue
		}
		for _, e := range n.Out {
			if g := e.Callee.Func; !seen[g] {
				seen[g] = true
				stack = append(stack, g)
			}
		}
	}
	return seen
}

var _ = callgraph.Graph{}

// funcID returns f's id, queueing f for lowering the first time.
func (fe *frontend) funcID(f *ssa.Function) int {
	if id, ok := fe.funcIDs[f]; ok {
		return id
	}
	name := funcName(f)
	if n, dup := fe.names[name]; dup {
		// go/ssa may create several identical wrappers or thunks for one
		// method (one per creating package); they share one function.
		if f.Synthetic != "" && f.Parent() == nil && f.Synthetic != "package initializer" && fe.ssaFuncs[n] != nil && fe.ssaFuncs[n].Synthetic == f.Synthetic {
			fe.funcIDs[f] = n
			return n
		}
		name = fmt.Sprintf("%s#%d", name, len(fe.funcs))
	}
	id := len(fe.funcs)
	fe.funcIDs[f] = id
	fe.names[name] = id
	fe.funcs = append(fe.funcs, &Func{Name: name})
	fe.ssaFuncs = append(fe.ssaFuncs, f)
	fe.queue = append(fe.queue, f)
	return id
}

func (fe *frontend) global(g *ssa.Global) int {
	if id, ok := fe.globals[g]; ok {
		return id
	}
	id := len(fe.globList)
	fe.globals[g] = id
	fe.globList = append(fe.globList, Global{Name: g.RelString(nil), Type: fe.tt.id(deref(g.Type()))})
	return id
}

func (fe *frontend) softfloat(name string) int {
	f := fe.sf.Func(name)
	if f == nil {
		panic("softfloat." + name + " missing")
	}
	return fe.funcID(f)
}

func (fe *frontend) noteIface(t types.Type) {
	if fe.ifaceTypes.At(t) == nil {
		fe.ifaceTypes.Set(t, true)
		fe.ifaceList = append(fe.ifaceList, t)
	}
}

func (fe *frontend) noteInvoke(key string) { fe.invoked[key] = true }

// addDispatch adds, for every type made into an interface, its methods
// whose name is invoked somewhere. Reports whether anything was added.
func (fe *frontend) addDispatch() bool {
	added := false
	for _, t := range fe.ifaceList {
		if types.IsInterface(t) {
			continue
		}
		ms := fe.prog.MethodSets.MethodSet(t)
		for i := 0; i < ms.Len(); i++ {
			sel := ms.At(i)
			if !fe.invoked[methodKey(sel.Obj().(*types.Func))] {
				continue
			}
			if f := fe.prog.MethodValue(sel); f != nil {
				if _, ok := fe.funcIDs[f]; !ok {
					fe.funcID(f)
					added = true
				}
			}
		}
	}
	return added
}

// fillMethods writes the method sets of named types (only emitted methods).
func (fe *frontend) fillMethods() {
	for i := 0; i < len(fe.tt.named); i++ { // list may grow while filling
		e := fe.tt.named[i]
		var methods, ptrMethods map[string]int
		switch nt := fe.tt.list[e.id].(type) {
		case TNamed:
			methods, ptrMethods = nt.Methods, nt.PtrMethods
		case TStruct:
			methods, ptrMethods = nt.Methods, nt.PtrMethods
		}
		if types.IsInterface(e.t) {
			continue
		}
		fill := func(t types.Type, m map[string]int) {
			ms := fe.prog.MethodSets.MethodSet(t)
			for j := 0; j < ms.Len(); j++ {
				sel := ms.At(j)
				if f := fe.prog.MethodValue(sel); f != nil {
					if id, ok := fe.funcIDs[f]; ok {
						m[methodKey(sel.Obj().(*types.Func))] = id
					}
				}
			}
		}
		fill(e.t, methods)
		fill(types.NewPointer(e.t), ptrMethods)
	}
}

func pkgPathOf(f *ssa.Function) string {
	for g := f; g != nil; g = g.Parent() {
		if g.Pkg != nil {
			return g.Pkg.Pkg.Path()
		}
		if o := g.Origin(); o != nil && o.Pkg != nil {
			return o.Pkg.Pkg.Path()
		}
		if obj := g.Object(); obj != nil && obj.Pkg() != nil {
			return obj.Pkg().Path()
		}
	}
	return ""
}

func (fe *frontend) lowerFunc(f *ssa.Function) {
	id := fe.funcIDs[f]
	out := fe.funcs[id]
	out.Sig = fe.tt.sigID(f.Signature)
	if p := fe.prog.Fset.Position(f.Pos()); p.IsValid() {
		out.Pos = fmt.Sprintf("%s/%s:%d", pkgPathOf(f), filepath.Base(p.Filename), p.Line)
	}
	stub := func(body, what string) {
		out.Body = body
		if body == "trap" {
			out.Trap = what
			fe.stats.trapFuncs++
		} else {
			out.Intrinsic = what
			fe.stats.intrinsics++
		}
		out.Blocks = []*Block{}
		sig := f.Signature
		out.RegTypes = []int{}
		if sig.Recv() != nil {
			out.RegTypes = append(out.RegTypes, fe.tt.id(sig.Recv().Type()))
		}
		for i := 0; i < sig.Params().Len(); i++ {
			out.RegTypes = append(out.RegTypes, fe.tt.id(sig.Params().At(i).Type()))
		}
		out.Params = len(out.RegTypes)
		out.FreeVars = len(f.FreeVars)
		for _, fv := range f.FreeVars {
			out.RegTypes = append(out.RegTypes, fe.tt.id(fv.Type()))
		}
		out.Regs = len(out.RegTypes)
		out.Recover = -1
	}
	body, what := fe.bodyKind(f, out.Name)
	switch body {
	case "intrinsic":
		stub("intrinsic", what)
	case "trap":
		stub("trap", what)
		if len(f.Blocks) == 0 {
			fe.bodyless = append(fe.bodyless, originName(f))
		}
	default:
		out.Body = "ir"
		func() {
			defer func() {
				if r := recover(); r != nil {
					log.Fatalf("lowering %s: %v", out.Name, r)
				}
			}()
			fe.lowerBody(f, out)
		}()
	}
}

func readOverlay(path string) map[string][]byte {
	var o struct{ Replace map[string]string }
	data, err := os.ReadFile(path)
	if err != nil {
		log.Fatal(err)
	}
	if err := json.Unmarshal(data, &o); err != nil {
		log.Fatal(err)
	}
	m := map[string][]byte{}
	for dst, src := range o.Replace {
		if src == "" {
			m[dst] = nil
			continue
		}
		b, err := os.ReadFile(src)
		if err != nil {
			log.Fatal(err)
		}
		m[dst] = b
	}
	return m
}

func readKeep(path string) map[string]bool {
	data, err := os.ReadFile(path)
	if err != nil {
		log.Fatal(err)
	}
	m := map[string]bool{}
	for _, line := range strings.Split(string(data), "\n") {
		if line = strings.TrimSpace(line); line != "" && !strings.HasPrefix(line, "#") {
			m[line] = true
		}
	}
	return m
}

// compiled reports whether f gets an IR body (its callees matter).
func (fe *frontend) compiled(f *ssa.Function) bool {
	body, _ := fe.bodyKind(f, fe.funcs0Name(f))
	return body == "ir"
}

func (fe *frontend) funcs0Name(f *ssa.Function) string { return funcName(f) }

func originName(f *ssa.Function) string {
	if o := f.Origin(); o != nil {
		return o.String()
	}
	return f.String()
}

// bodyKind decides how f is emitted: "ir", "intrinsic" (with its name) or
// "trap" (with the message).
func (fe *frontend) bodyKind(f *ssa.Function, emitted string) (string, string) {
	name := originName(f)
	pkg := pkgPathOf(f)
	switch {
	case intrinsics[name] != "":
		return "intrinsic", name
	case (runtimePkg(pkg) || noopInitPkgs[pkg]) && f.Synthetic == "package initializer":
		return "intrinsic", "noop"
	case runtimePkg(pkg) && !runtimeCompiled[name]:
		return "trap", "runtime function " + name + " not supported"
	case len(f.Blocks) == 0:
		return "trap", "function without body: " + name
	case fe.keep != nil && !fe.keep[emitted] && pkg != softfloatPkg:
		return "trap", "pruned (-keep): " + name
	}
	return "ir", ""
}
