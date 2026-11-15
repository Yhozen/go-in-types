// Command census measures what the TypeScript 7 compiler (cmd/tsgo) needs
// from a Go engine: reachable functions and SSA size (RTA and VTA), the
// functions a set of real runs executed (from a Go coverage profile), and a
// feature census over both sets. See README.md.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/token"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"golang.org/x/tools/go/callgraph"
	"golang.org/x/tools/go/callgraph/rta"
	"golang.org/x/tools/go/callgraph/vta"
	"golang.org/x/tools/go/packages"
	"golang.org/x/tools/go/ssa"
	"golang.org/x/tools/go/ssa/ssautil"
)

var (
	flagDir     = flag.String("dir", "", "module root of typescript-go (required)")
	flagPattern = flag.String("pattern", "./cmd/tsgo", "main package to load")
	flagOverlay = flag.String("overlay", "", "go build -overlay JSON file ({\"Replace\": {...}})")
	flagGOOS    = flag.String("goos", "", "GOOS (default: host)")
	flagGOARCH  = flag.String("goarch", "", "GOARCH (default: host)")
	flagTags    = flag.String("tags", "", "build tags")
	flagCover   = flag.String("cover", "", "coverage profile (go tool covdata textfmt output); enables the dynamic set")
	flagVTA     = flag.Bool("vta", true, "also compute VTA reachability")
	flagOut     = flag.String("out", "out", "output directory")
	flagName    = flag.String("name", "census", "output file prefix")
	flagWhy     = flag.String("why", "", "print a VTA call path from main to the first function whose name contains this")
	flagFns     = flag.Bool("functions", false, "write <name>.functions.json")
)

// Fn is the per-function record written to <name>.functions.json.
type Fn struct {
	Name      string         `json:"name"`
	Pkg       string         `json:"pkg"`
	Kind      string         `json:"kind"` // source, closure, instance, synthetic, init, nobody
	Blocks    int            `json:"blocks"`
	Instrs    int            `json:"instrs"`
	VTA       bool           `json:"vta,omitempty"`
	Exec      string         `json:"exec,omitempty"` // yes, no, unknown (file not instrumented)
	ExecBlk   int            `json:"execBlocks,omitempty"`
	ExecIns   int            `json:"execInstrs,omitempty"`
	Pos       string         `json:"pos,omitempty"`
	Features  map[string]int `json:"f,omitempty"`
	fn        *ssa.Function
	execBlock []bool
}

func main() {
	log.SetFlags(0)
	flag.Parse()
	if *flagDir == "" {
		log.Fatal("-dir is required")
	}
	t0 := time.Now()
	env := append(os.Environ(), "CGO_ENABLED=0")
	if *flagGOOS != "" {
		env = append(env, "GOOS="+*flagGOOS)
	}
	if *flagGOARCH != "" {
		env = append(env, "GOARCH="+*flagGOARCH)
	}
	cfg := &packages.Config{
		Mode: packages.NeedName | packages.NeedFiles | packages.NeedCompiledGoFiles | packages.NeedImports |
			packages.NeedDeps | packages.NeedTypes | packages.NeedSyntax | packages.NeedTypesInfo |
			packages.NeedTypesSizes | packages.NeedModule,
		Dir: *flagDir,
		Env: env,
	}
	if *flagTags != "" {
		cfg.BuildFlags = append(cfg.BuildFlags, "-tags="+*flagTags)
	}
	if *flagOverlay != "" {
		cfg.Overlay = readOverlay(*flagOverlay)
	}
	initial, err := packages.Load(cfg, *flagPattern)
	if err != nil {
		log.Fatal(err)
	}
	if packages.PrintErrors(initial) > 0 {
		log.Fatal("package errors")
	}
	fileKey := map[string]string{} // absolute file -> importpath/base (coverage key)
	nPkgs := 0
	cgo := []string{}
	packages.Visit(initial, nil, func(p *packages.Package) {
		nPkgs++
		for _, f := range p.CompiledGoFiles {
			fileKey[f] = p.PkgPath + "/" + filepath.Base(f)
		}
		for _, f := range p.GoFiles {
			fileKey[f] = p.PkgPath + "/" + filepath.Base(f)
		}
		if _, ok := p.Imports["C"]; ok || p.PkgPath == "runtime/cgo" {
			cgo = append(cgo, p.PkgPath)
		}
	})
	log.Printf("loaded %d packages in %s", nPkgs, time.Since(t0))

	prog, pkgs := ssautil.AllPackages(initial, ssa.InstantiateGenerics)
	prog.Build()
	mainPkg := pkgs[0]
	roots := []*ssa.Function{mainPkg.Func("init"), mainPkg.Func("main")}
	log.Printf("built SSA in %s", time.Since(t0))

	res := rta.Analyze(roots, true)
	log.Printf("RTA: %d reachable functions (%s)", len(res.Reachable), time.Since(t0))

	vtaReach := map[*ssa.Function]bool{}
	var vtaCG *callgraph.Graph
	if *flagVTA {
		funcs := map[*ssa.Function]bool{}
		for f := range res.Reachable {
			funcs[f] = true
		}
		vtaCG = vta.CallGraph(funcs, res.CallGraph)
		vtaReach = reachableFrom(vtaCG, roots)
		if *flagWhy != "" {
			why(vtaCG, roots, *flagWhy)
		}
		log.Printf("VTA: %d reachable functions (%s)", len(vtaReach), time.Since(t0))
	}

	var cov *Coverage
	if *flagCover != "" {
		cov, err = readCoverage(*flagCover)
		if err != nil {
			log.Fatal(err)
		}
	}

	fns := make([]*Fn, 0, len(res.Reachable))
	for f := range res.Reachable {
		r := &Fn{fn: f, Name: f.String(), Pkg: pkgOf(f), Kind: kindOf(f), Blocks: len(f.Blocks), VTA: vtaReach[f]}
		for _, b := range f.Blocks {
			r.Instrs += len(b.Instrs)
		}
		if p := prog.Fset.Position(f.Pos()); p.IsValid() {
			r.Pos = fmt.Sprintf("%s:%d", fileKey[p.Filename], p.Line)
		}
		fns = append(fns, r)
	}
	sort.Slice(fns, func(i, j int) bool { return fns[i].Name < fns[j].Name })

	if cov != nil {
		markExecuted(prog.Fset, fns, cov, fileKey, vtaCG, roots)
	}

	census := newCensus(prog.Fset, fileKey)
	if *flagVTA {
		census.StaticFilter = func(r *Fn) bool { return r.VTA }
	}
	for _, r := range fns {
		census.function(r)
	}

	rep := &Report{
		Config: map[string]string{
			"dir": *flagDir, "pattern": *flagPattern, "overlay": *flagOverlay, "goos": envOr(*flagGOOS, "GOOS"),
			"goarch": envOr(*flagGOARCH, "GOARCH"), "tags": *flagTags, "cover": *flagCover, "cgo": strings.Join(cgo, ","),
		},
		Packages: nPkgs,
	}
	rep.build(fns, census, cov != nil)

	if err := os.MkdirAll(*flagOut, 0o755); err != nil {
		log.Fatal(err)
	}
	writeJSON(filepath.Join(*flagOut, *flagName+".summary.json"), rep)
	if *flagFns {
		// VTA-reachable or executed functions, with their rarer features only.
		var keep []*Fn
		for _, r := range fns {
			if !(r.VTA || r.Exec == "yes") {
				continue
			}
			for k := range r.Features {
				if commonFeature(k) {
					delete(r.Features, k)
				}
			}
			if len(r.Features) == 0 {
				r.Features = nil
			}
			keep = append(keep, r)
		}
		writeJSON(filepath.Join(*flagOut, *flagName+".functions.json"), keep)
	}
	if err := os.WriteFile(filepath.Join(*flagOut, *flagName+".report.md"), []byte(rep.markdown()), 0o644); err != nil {
		log.Fatal(err)
	}
	log.Printf("done in %s", time.Since(t0))
}

func envOr(v, name string) string {
	if v != "" {
		return v
	}
	if e := os.Getenv(name); e != "" {
		return e
	}
	return "host"
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
		b, err := os.ReadFile(src)
		if err != nil {
			log.Fatal(err)
		}
		m[dst] = b
	}
	return m
}

func reachableFrom(cg *callgraph.Graph, roots []*ssa.Function) map[*ssa.Function]bool {
	seen := map[*ssa.Function]bool{}
	var stack []*ssa.Function
	for _, r := range roots {
		seen[r] = true
		stack = append(stack, r)
	}
	for len(stack) > 0 {
		f := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		n := cg.Nodes[f]
		if n == nil {
			continue
		}
		for _, e := range n.Out {
			if g := e.Callee.Func; !seen[g] {
				seen[g] = true
				stack = append(stack, g)
			}
		}
		// Anonymous functions created here may be called only through
		// values VTA tracks; closures are nodes too, but keep any closure
		// made by a reachable function reachable if VTA lists it.
	}
	return seen
}

func pkgOf(f *ssa.Function) string {
	if f.Pkg != nil {
		return f.Pkg.Pkg.Path()
	}
	if o := f.Origin(); o != nil && o.Pkg != nil {
		return o.Pkg.Pkg.Path()
	}
	if obj := f.Object(); obj != nil && obj.Pkg() != nil {
		return obj.Pkg().Path()
	}
	for p := f.Parent(); p != nil; p = p.Parent() {
		if p.Pkg != nil {
			return p.Pkg.Pkg.Path()
		}
	}
	return "(synthetic)"
}

func kindOf(f *ssa.Function) string {
	switch {
	case len(f.Blocks) == 0:
		return "nobody"
	case f.Synthetic == "package initializer":
		return "init"
	case f.Synthetic == "range-over-func yield":
		return "rangefunc"
	case len(f.TypeArgs()) > 0:
		return "instance"
	case f.Parent() != nil:
		return "closure"
	case f.Synthetic != "":
		return "synthetic"
	}
	return "source"
}

func isStd(pkg string) bool {
	first := pkg
	if i := strings.IndexByte(pkg, '/'); i >= 0 {
		first = pkg[:i]
	}
	return !strings.Contains(first, ".") && pkg != "(synthetic)"
}

func group(pkg string) string {
	switch {
	case strings.HasPrefix(pkg, "github.com/microsoft/typescript-go/"):
		return "tsgo"
	case isStd(pkg):
		return "std"
	case pkg == "(synthetic)":
		return "synthetic"
	}
	return "third-party"
}

func writeJSON(path string, v any) {
	f, err := os.Create(path)
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	if strings.HasSuffix(path, ".summary.json") {
		enc.SetIndent("", " ")
	}
	if err := enc.Encode(v); err != nil {
		log.Fatal(err)
	}
}

var _ = token.NoPos

func commonFeature(k string) bool {
	for _, p := range []string{"alloc.", "call.static", "call.invoke", "call.dynamic", "builtin.", "conv.int2int", "int64.binop", "iface.make", "typeassert.", "slice.slice", "slice.make", "string.", "closure", "map.", "float", "conv.", "int64.", "call.nobody", "rundefers", "defer", "panic", "math", "strconv", "slices", "sort", "fmt", "strings.Builder", "unicode.table", "time", "os/syscall", "atomic", "sync.Mutex", "sync.RWMutex", "sync.Once", "sync.WaitGroup"} {
		if strings.HasPrefix(k, p) {
			return true
		}
	}
	return false
}

func why(cg *callgraph.Graph, roots []*ssa.Function, sub string) {
	parent := map[*ssa.Function]*ssa.Function{}
	queue := append([]*ssa.Function(nil), roots...)
	for _, r := range roots {
		parent[r] = nil
	}
	for len(queue) > 0 {
		f := queue[0]
		queue = queue[1:]
		if strings.Contains(f.String(), sub) {
			var path []string
			for g := f; g != nil; g = parent[g] {
				path = append(path, g.String())
			}
			for i := len(path) - 1; i >= 0; i-- {
				log.Printf("why: %s", path[i])
			}
			return
		}
		if n := cg.Nodes[f]; n != nil {
			for _, e := range n.Out {
				if _, ok := parent[e.Callee.Func]; !ok {
					parent[e.Callee.Func] = f
					queue = append(queue, e.Callee.Func)
				}
			}
		}
	}
	log.Printf("why: %q not reachable", sub)
}
