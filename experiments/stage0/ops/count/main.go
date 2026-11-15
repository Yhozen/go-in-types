// Command count runs the opsharness (../harness) under a counting copy of
// golang.org/x/tools/go/ssa/interp and reports executed SSA instructions.
//
//	go run ./count -tsgo <typescript-go dir> -lib <dir with lib.*.d.ts> \
//	    -mode cli|phased -libname mini|es5 [-top 30] [-o report.txt]
package main

import (
	"flag"
	"fmt"
	"go/types"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"golang.org/x/tools/go/packages"
	"golang.org/x/tools/go/ssa"
	"golang.org/x/tools/go/ssa/ssautil"

	"goops/count/interp"
)

func main() {
	tsgo := flag.String("tsgo", "", "typescript-go module directory")
	libDir := flag.String("lib", "", "directory holding lib.mini.d.ts and lib.es5.d.ts")
	mode := flag.String("mode", "phased", "harness mode: cli or phased")
	lib := flag.String("libname", "mini", "mini or es5")
	top := flag.Int("top", 30, "top functions to list")
	out := flag.String("o", "", "report file (default stdout)")
	pkgPattern := flag.String("pkg", "./cmd/opsharness", "package to run")
	mainFile := flag.String("main", "", "main.go to overlay as the package (default: harness/main.go)")
	flag.Parse()

	start := time.Now()
	here, _ := os.Getwd()
	cfg := &packages.Config{
		Mode:       packages.LoadAllSyntax,
		Dir:        *tsgo,
		BuildFlags: []string{"-tags=purego"},
		Env:        append(os.Environ(), "CGO_ENABLED=0"),
	}
	files := []string{*mainFile}
	if *mainFile == "" {
		files, _ = filepath.Glob(filepath.Join(here, "harness", "*.go"))
	}
	cfg.Overlay = map[string][]byte{}
	for _, f := range files {
		src, err := os.ReadFile(f)
		if err != nil {
			log.Fatal(err)
		}
		cfg.Overlay[filepath.Join(*tsgo, *pkgPattern, filepath.Base(f))] = src
	}
	if cfg.Overlay == nil {
		cfg.Overlay = map[string][]byte{}
	}
	addGorootOverlays(cfg.Overlay, filepath.Join(here, "count", "goroot"))
	addGenericBytealg(cfg.Overlay)
	pkgs, err := packages.Load(cfg, *pkgPattern)
	if err != nil {
		log.Fatal(err)
	}
	if packages.PrintErrors(pkgs) > 0 {
		log.Fatal("load errors")
	}
	prog, spkgs := ssautil.AllPackages(pkgs, ssa.InstantiateGenerics)
	prog.Build()
	mainPkg := spkgs[0]
	if os.Getenv("OPS_DUMP") != "" {
		for _, name := range strings.Split(os.Getenv("OPS_DUMP"), ",") {
			for _, m := range mainPkg.Members {
				if f, ok := m.(*ssa.Function); ok && f.Name() == name {
					f.WriteTo(os.Stderr)
				}
			}
			if t := mainPkg.Type(name); t != nil {
				for _, sel := range []types.Type{t.Type(), types.NewPointer(t.Type())} {
					ms := prog.MethodSets.MethodSet(sel)
					for m := range ms.Methods() {
						if f := prog.MethodValue(m); f != nil && f.Synthetic == "" {
							f.WriteTo(os.Stderr)
						}
					}
				}
			}
		}
	}
	fmt.Fprintf(os.Stderr, "loaded and built SSA in %v\n", time.Since(start))

	c := interp.TheCounter
	c.Mode, c.Lib = *mode, *lib
	if *libDir != "" {
		b, err := os.ReadFile(filepath.Join(*libDir, "lib."+*lib+".d.ts"))
		if err != nil {
			log.Fatal(err)
		}
		c.LibText = string(b)
	}
	var target strings.Builder
	c.Out = &target
	start = time.Now()
	sizes := types.SizesFor("gc", "arm64")
	var imode interp.Mode
	if os.Getenv("OPS_CRASH") != "" {
		imode = interp.DisableRecover
	}
	code := interp.Interpret(mainPkg, imode, sizes, "opsharness", nil)
	fmt.Fprintf(os.Stderr, "interpreted in %v, exit %d\n", time.Since(start), code)

	w := os.Stdout
	if *out != "" {
		f, err := os.Create(*out)
		if err != nil {
			log.Fatal(err)
		}
		defer f.Close()
		w = f
	}
	fmt.Fprintf(w, "# %s %s\n\ntarget output:\n%s\n", *mode, *lib, target.String())
	fmt.Fprintf(w, "phases:\n")
	var total int64
	for _, n := range c.Order {
		total += c.Phases[n].Instrs
	}
	for _, n := range c.Order {
		fmt.Fprintf(w, "  %-28s %12d\n", n, c.Phases[n].Instrs)
	}
	fmt.Fprintf(w, "  %-28s %12d\n\n", "TOTAL", total)
	fmt.Fprintf(w, "package initializers not interpreted: %s\n\n", strings.Join(interp.SkippedInits, " "))
	cold := c.PhaseNames(func(s string) bool { return !strings.HasPrefix(s, "warm:") })
	warm := c.PhaseNames(func(s string) bool { return strings.HasPrefix(s, "warm:") })
	interp.Write(w, "whole run except warm phases", c.Sum(cold), *top)
	if len(warm) > 0 {
		interp.Write(w, "warm check (second program, lib reused)", c.Sum(warm), *top)
	}
	wcp := c.PhaseNames(func(s string) bool { return s == "warm:global" || s == "warm:check" })
	if len(wcp) > 0 {
		interp.Write(w, "warm checker creation + check (warm:global + warm:check)", c.Sum(wcp), *top)
	}
	check := c.PhaseNames(func(s string) bool { return s == "check" })
	if len(check) > 0 {
		interp.Write(w, "fresh check phase only", c.Sum(check), *top)
	}
	wcheck := c.PhaseNames(func(s string) bool { return s == "warm:check" })
	if len(wcheck) > 0 {
		interp.Write(w, "warm check phase only", c.Sum(wcheck), *top)
	}
}

// addGorootOverlays maps every file under dir to the same relative path
// under $GOROOT/src (interpreter-friendly replacements of std files).
func addGorootOverlays(ov map[string][]byte, dir string) {
	goroot := runtime.GOROOT()
	filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".go") {
			return err
		}
		rel, _ := filepath.Rel(dir, path)
		src, err := os.ReadFile(path)
		if err != nil {
			log.Fatal(err)
		}
		ov[filepath.Join(goroot, "src", rel)] = src
		return nil
	})
}

// addGenericBytealg replaces internal/bytealg's assembly declarations by
// its portable Go versions (the *_generic.go files, minus build tags).
func addGenericBytealg(ov map[string][]byte) {
	dir := filepath.Join(runtime.GOROOT(), "src", "internal", "bytealg")
	for _, name := range []string{"compare", "count", "indexbyte"} {
		src, err := os.ReadFile(filepath.Join(dir, name+"_generic.go"))
		if err != nil {
			log.Fatal(err)
		}
		var lines []string
		for _, l := range strings.Split(string(src), "\n") {
			if !strings.HasPrefix(l, "//go:build") {
				lines = append(lines, l)
			}
		}
		ov[filepath.Join(dir, name+"_native.go")] = []byte(strings.Join(lines, "\n"))
	}
}
