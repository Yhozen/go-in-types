package main

import (
	"fmt"
	"sort"
	"strings"

	"golang.org/x/tools/go/ssa"
)

func staticCallee(in ssa.Instruction) *ssa.Function {
	if call, ok := in.(ssa.CallInstruction); ok {
		return call.Common().StaticCallee()
	}
	return nil
}

// Size is a function/block/instruction count.
type Size struct {
	Fns    int `json:"fns"`
	Blocks int `json:"blocks"`
	Instrs int `json:"instrs"`
}

func (s *Size) add(fns, blocks, instrs int) {
	s.Fns += fns
	s.Blocks += blocks
	s.Instrs += instrs
}

// PkgRow is one package's sizes in each set.
type PkgRow struct {
	Pkg  string `json:"pkg"`
	RTA  Size   `json:"rta"`
	VTA  Size   `json:"vta"`
	Exec Size   `json:"exec"`       // executed functions, whole bodies
	Blk  Size   `json:"execBlocks"` // executed blocks only (estimate)
}

// Report is <name>.summary.json.
type Report struct {
	Config   map[string]string `json:"config"`
	Packages int               `json:"packages"`
	Dynamic  bool              `json:"dynamic"`

	Totals  map[string]Size            `json:"totals"`  // rta, vta, exec, execBlocks, execUnknown
	ByGroup map[string]map[string]Size `json:"byGroup"` // set -> tsgo/std/third-party
	ByKind  map[string]map[string]Size `json:"byKind"`  // set -> kind
	ByPkg   []PkgRow                   `json:"byPkg"`

	Generics struct {
		InstancesVTA  int            `json:"instancesVTA"`
		OriginsVTA    int            `json:"originsVTA"`
		InstancesExec int            `json:"instancesExec"`
		OriginsExec   int            `json:"originsExec"`
		TopVTA        map[string]int `json:"topVTA"`
	} `json:"generics"`

	NoBody struct {
		VTA        map[string][]string `json:"vta"`        // pkg -> names
		CalledExec map[string][]string `json:"calledExec"` // called from an executed block
	} `json:"noBody"`

	Inits []string `json:"inits"` // top package initializers by instructions

	ExecNotVTA        []string `json:"execNotVTA"`
	CoveredNotReached []string `json:"coveredNotReached"`

	Static   *Tally `json:"static"`
	DynamicT *Tally `json:"dynamicTally"`
}

func (rep *Report) build(fns []*Fn, c *Census, dynamic bool) {
	rep.Dynamic = dynamic
	rep.Totals = map[string]Size{}
	rep.ByGroup = map[string]map[string]Size{}
	rep.ByKind = map[string]map[string]Size{}
	pkgs := map[string]*PkgRow{}
	addTo := func(m map[string]map[string]Size, set, key string, fns, b, i int) {
		if m[set] == nil {
			m[set] = map[string]Size{}
		}
		s := m[set][key]
		s.add(fns, b, i)
		m[set][key] = s
	}
	tot := func(set string, fns, b, i int) {
		s := rep.Totals[set]
		s.add(fns, b, i)
		rep.Totals[set] = s
	}
	byFn := map[string]*Fn{}
	instOrig := map[string]map[string]bool{}
	execOrig := map[string]bool{}
	rep.Generics.TopVTA = map[string]int{}
	rep.NoBody.VTA = map[string][]string{}
	rep.NoBody.CalledExec = map[string][]string{}
	type ini struct {
		name string
		n    int
	}
	var inits []ini
	for _, r := range fns {
		byFn[r.Name] = r
		p := pkgs[r.Pkg]
		if p == nil {
			p = &PkgRow{Pkg: r.Pkg}
			pkgs[r.Pkg] = p
		}
		g := group(r.Pkg)
		cls := ""
		switch {
		case r.Kind == "init":
			cls = "-init"
		case isRuntime(r.Pkg):
			cls = "-runtime"
		default:
			cls = "-code"
		}
		if r.VTA {
			tot("vta"+cls, 1, r.Blocks, r.Instrs)
		}
		if r.Exec == "yes" {
			tot("exec"+cls, 1, r.Blocks, r.Instrs)
			tot("execBlocks"+cls, 1, r.ExecBlk, r.ExecIns)
		}
		p.RTA.add(1, r.Blocks, r.Instrs)
		tot("rta", 1, r.Blocks, r.Instrs)
		addTo(rep.ByGroup, "rta", g, 1, r.Blocks, r.Instrs)
		addTo(rep.ByKind, "rta", r.Kind, 1, r.Blocks, r.Instrs)
		if r.VTA {
			p.VTA.add(1, r.Blocks, r.Instrs)
			tot("vta", 1, r.Blocks, r.Instrs)
			addTo(rep.ByGroup, "vta", g, 1, r.Blocks, r.Instrs)
			addTo(rep.ByKind, "vta", r.Kind, 1, r.Blocks, r.Instrs)
			if r.Kind == "instance" {
				o := r.fn.Origin().String()
				rep.Generics.InstancesVTA++
				rep.Generics.TopVTA[o]++
				if instOrig[o] == nil {
					instOrig[o] = map[string]bool{}
				}
			}
			if r.Kind == "nobody" {
				rep.NoBody.VTA[r.Pkg] = append(rep.NoBody.VTA[r.Pkg], r.Name)
			}
			if r.Kind == "init" {
				inits = append(inits, ini{r.Name, r.Instrs})
			}
		}
		if r.Exec == "yes" {
			p.Exec.add(1, r.Blocks, r.Instrs)
			p.Blk.add(1, r.ExecBlk, r.ExecIns)
			tot("exec", 1, r.Blocks, r.Instrs)
			tot("execBlocks", 1, r.ExecBlk, r.ExecIns)
			addTo(rep.ByGroup, "exec", g, 1, r.Blocks, r.Instrs)
			addTo(rep.ByGroup, "execBlocks", g, 1, r.ExecBlk, r.ExecIns)
			addTo(rep.ByKind, "exec", r.Kind, 1, r.Blocks, r.Instrs)
			if r.Kind == "instance" {
				rep.Generics.InstancesExec++
				execOrig[r.fn.Origin().String()] = true
			}
			if !r.VTA && *flagVTA {
				rep.ExecNotVTA = append(rep.ExecNotVTA, r.Name)
			}
			for i, b := range r.fn.Blocks {
				if !r.execBlock[i] {
					continue
				}
				for _, in := range b.Instrs {
					if g := staticCallee(in); g != nil && len(g.Blocks) == 0 {
						pk := pkgOf(g)
						if !contains(rep.NoBody.CalledExec[pk], g.String()) {
							rep.NoBody.CalledExec[pk] = append(rep.NoBody.CalledExec[pk], g.String())
						}
					}
				}
			}
		} else if r.Exec == "unknown" {
			tot("execUnknown", 1, r.Blocks, r.Instrs)
		}
	}
	rep.Generics.OriginsVTA = len(instOrig)
	rep.Generics.OriginsExec = len(execOrig)
	// keep the top 40 origins
	rep.Generics.TopVTA = topN(rep.Generics.TopVTA, 40)
	for _, v := range rep.NoBody.VTA {
		sort.Strings(v)
	}
	for _, v := range rep.NoBody.CalledExec {
		sort.Strings(v)
	}
	sort.Slice(inits, func(i, j int) bool { return inits[i].n > inits[j].n })
	for i, in := range inits {
		if i == 25 {
			break
		}
		rep.Inits = append(rep.Inits, fmt.Sprintf("%s %d", in.name, in.n))
	}
	for _, p := range pkgs {
		rep.ByPkg = append(rep.ByPkg, *p)
	}
	sort.Slice(rep.ByPkg, func(i, j int) bool {
		a, b := rep.ByPkg[i], rep.ByPkg[j]
		if a.VTA.Instrs != b.VTA.Instrs {
			return a.VTA.Instrs > b.VTA.Instrs
		}
		return a.Pkg < b.Pkg
	})
	sort.Strings(rep.ExecNotVTA)
	rep.CoveredNotReached = CoveredNotReached
	sort.Strings(rep.CoveredNotReached)
	rep.Static = c.Static
	if dynamic {
		rep.DynamicT = c.Dynamic
	}
	trimSites(rep.Static)
	if dynamic {
		trimSites(rep.DynamicT)
	}
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

func topN(m map[string]int, n int) map[string]int {
	ks := sortedByValue(m)
	out := map[string]int{}
	for i, k := range ks {
		if i == n {
			break
		}
		out[k] = m[k]
	}
	return out
}

func sortedByValue(m map[string]int) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Slice(ks, func(i, j int) bool {
		if m[ks[i]] != m[ks[j]] {
			return m[ks[i]] > m[ks[j]]
		}
		return ks[i] < ks[j]
	})
	return ks
}

func trimSites(t *Tally) {
	for k, v := range t.Sites {
		sort.Strings(v)
		if len(v) > 200 {
			v = v[:200]
		}
		t.Sites[k] = v
	}
}

func (rep *Report) markdown() string {
	var b strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&b, format, a...) }
	w("# census report (generated by experiments/stage0/census; do not edit)\n\n")
	w("Config: %v. %d packages loaded.\n\n", rep.Config, rep.Packages)
	w("## Totals\n\n| set | functions | blocks | instructions |\n|---|---:|---:|---:|\n")
	for _, k := range []string{"rta", "vta", "vta-code", "vta-init", "vta-runtime", "exec", "exec-code", "exec-init", "exec-runtime", "execBlocks", "execBlocks-code", "execUnknown"} {
		if s, ok := rep.Totals[k]; ok {
			w("| %s | %d | %d | %d |\n", k, s.Fns, s.Blocks, s.Instrs)
		}
	}
	w("\n## By group\n\n| set | group | functions | blocks | instructions |\n|---|---|---:|---:|---:|\n")
	for _, set := range []string{"rta", "vta", "exec", "execBlocks"} {
		for _, g := range sortedKeys(rep.ByGroup[set]) {
			s := rep.ByGroup[set][g]
			w("| %s | %s | %d | %d | %d |\n", set, g, s.Fns, s.Blocks, s.Instrs)
		}
	}
	w("\n## By kind\n\n| set | kind | functions | blocks | instructions |\n|---|---|---:|---:|---:|\n")
	for _, set := range []string{"rta", "vta", "exec"} {
		for _, g := range sortedKeys(rep.ByKind[set]) {
			s := rep.ByKind[set][g]
			w("| %s | %s | %d | %d | %d |\n", set, g, s.Fns, s.Blocks, s.Instrs)
		}
	}
	w("\n## Top 40 packages by VTA instructions\n\n| package | RTA fns | RTA instrs | VTA fns | VTA blocks | VTA instrs | exec fns | exec instrs | exec-block instrs |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n")
	for i, p := range rep.ByPkg {
		if i == 40 {
			break
		}
		w("| %s | %d | %d | %d | %d | %d | %d | %d | %d |\n", p.Pkg, p.RTA.Fns, p.RTA.Instrs, p.VTA.Fns, p.VTA.Blocks, p.VTA.Instrs, p.Exec.Fns, p.Exec.Instrs, p.Blk.Instrs)
	}
	if rep.Dynamic {
		w("\n## Top 40 packages by executed instructions\n\n| package | exec fns | exec instrs | exec-block instrs | VTA instrs |\n|---|---:|---:|---:|---:|\n")
		rows := append([]PkgRow(nil), rep.ByPkg...)
		sort.Slice(rows, func(i, j int) bool { return rows[i].Exec.Instrs > rows[j].Exec.Instrs })
		for i, p := range rows {
			if i == 40 || p.Exec.Fns == 0 {
				break
			}
			w("| %s | %d | %d | %d | %d |\n", p.Pkg, p.Exec.Fns, p.Exec.Instrs, p.Blk.Instrs, p.VTA.Instrs)
		}
	}
	w("\n## Generics\n\nVTA: %d instances of %d generic functions. Executed: %d instances of %d.\n\n", rep.Generics.InstancesVTA, rep.Generics.OriginsVTA, rep.Generics.InstancesExec, rep.Generics.OriginsExec)
	for _, k := range sortedByValue(rep.Generics.TopVTA) {
		w("- %s: %d\n", k, rep.Generics.TopVTA[k])
	}
	w("\n## Functions without bodies (assembly, linkname, runtime-provided)\n\n")
	for _, pk := range sortedKeys(rep.NoBody.VTA) {
		w("- %s (%d VTA-reachable): %s\n", pk, len(rep.NoBody.VTA[pk]), strings.Join(rep.NoBody.VTA[pk], ", "))
	}
	if rep.Dynamic {
		w("\nCalled from executed blocks:\n\n")
		for _, pk := range sortedKeys(rep.NoBody.CalledExec) {
			w("- %s: %s\n", pk, strings.Join(rep.NoBody.CalledExec[pk], ", "))
		}
	}
	w("\n## Package initializers (top by instructions)\n\n")
	for _, s := range rep.Inits {
		w("- %s\n", s)
	}
	if len(rep.ExecNotVTA) > 0 {
		w("\n## Executed but not VTA-reachable (%d)\n\n", len(rep.ExecNotVTA))
		for i, s := range rep.ExecNotVTA {
			if i == 50 {
				break
			}
			w("- %s\n", s)
		}
	}
	if len(rep.CoveredNotReached) > 0 {
		w("\n## Covered but not reached by an executed VTA edge (%d)\n\n", len(rep.CoveredNotReached))
		for i, s := range rep.CoveredNotReached {
			if i == 80 {
				break
			}
			w("- %s\n", s)
		}
	}
	tally := func(title string, t *Tally) {
		w("\n## Features: %s\n\n| feature | instructions | functions |\n|---|---:|---:|\n", title)
		for _, k := range sortedKeys(t.Features) {
			w("| %s | %d | %d |\n", k, t.Features[k], t.FeatureFns[k])
		}
		w("\n### Sites\n\n")
		for _, k := range sortedKeys(t.Sites) {
			v := t.Sites[k]
			if len(v) > 60 {
				w("- %s (%d, first 60): %s\n", k, len(v), strings.Join(v[:60], "; "))
			} else {
				w("- %s (%d): %s\n", k, len(v), strings.Join(v, "; "))
			}
		}
		w("\n### Reflect callees (caller packages)\n\n")
		for _, k := range sortedKeys(t.Reflect) {
			var ps []string
			for _, p := range sortedKeys(t.Reflect[k]) {
				ps = append(ps, fmt.Sprintf("%s %d", p, t.Reflect[k][p]))
			}
			w("- %s: %s\n", k, strings.Join(ps, ", "))
		}
		w("\n### Floats by package\n\n")
		for _, k := range sortedByValue(t.FloatByPkg) {
			w("- %s: %d\n", k, t.FloatByPkg[k])
		}
		w("\n### Map types\n\n")
		for _, k := range sortedByValue(t.MapTypes) {
			w("- `%s`: %d\n", k, t.MapTypes[k])
		}
		w("\n### Integer binops (op/width)\n\n")
		for _, k := range sortedByValue(t.IntOps) {
			w("- %s: %d\n", k, t.IntOps[k])
		}
		w("\n### Interfaces: %d distinct methods invoked, %d concrete types boxed (top 40 each)\n\n", len(t.Invokes), len(t.IfaceTypes))
		for i, k := range sortedByValue(t.Invokes) {
			if i == 40 {
				break
			}
			w("- invoke %s: %d\n", k, t.Invokes[k])
		}
		for i, k := range sortedByValue(t.IfaceTypes) {
			if i == 40 {
				break
			}
			w("- box `%s`: %d\n", k, t.IfaceTypes[k])
		}
		w("\n### Opcodes\n\n")
		for _, k := range sortedByValue(t.Opcodes) {
			w("- %s: %d\n", k, t.Opcodes[k])
		}
		w("\n### Calls by callee package (top 60)\n\n")
		for i, k := range sortedByValue(t.CallsByPkg) {
			if i == 60 {
				break
			}
			w("- %s: %d\n", k, t.CallsByPkg[k])
		}
		w("\n### Boundary: non-tsgo functions called from tsgo code (%d)\n\n", len(t.Boundary))
		for _, k := range sortedByValue(t.Boundary) {
			w("- %s: %d", k, t.Boundary[k])
			if cs := t.BoundaryCallers[k]; len(cs) > 0 {
				w(" (from %s)", strings.Join(cs, ", "))
			}
			w("\n")
		}
	}
	tally("static (VTA set)", rep.Static)
	if rep.Dynamic {
		tally("dynamic (executed blocks)", rep.DynamicT)
	}
	return b.String()
}

// isRuntime: packages the engine replaces with its own runtime.
func isRuntime(pkg string) bool {
	return pkg == "runtime" || strings.HasPrefix(pkg, "runtime/") || strings.HasPrefix(pkg, "internal/runtime/")
}
