package main

import (
	"bufio"
	"fmt"
	"go/token"
	"os"
	"sort"
	"strings"

	"golang.org/x/tools/go/callgraph"
	"golang.org/x/tools/go/ssa"
)

// A coverage block from a textfmt profile: lines and columns are 1-based,
// End is inclusive of the closing position as `go tool cover` reports it.
type covBlock struct {
	l0, c0, l1, c1 int
	count          int
}

// Coverage maps a coverage file key (importpath/base.go) to its blocks,
// sorted by start.
type Coverage struct {
	files map[string][]covBlock
}

func readCoverage(path string) (*Coverage, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	merged := map[string]map[[4]int]int{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "mode:") || line == "" {
			continue
		}
		colon := strings.LastIndexByte(line, ':')
		if colon < 0 {
			return nil, fmt.Errorf("bad line %q", line)
		}
		file := line[:colon]
		var b covBlock
		var n int
		if _, err := fmt.Sscanf(line[colon+1:], "%d.%d,%d.%d %d %d", &b.l0, &b.c0, &b.l1, &b.c1, &n, &b.count); err != nil {
			return nil, fmt.Errorf("bad line %q: %v", line, err)
		}
		m := merged[file]
		if m == nil {
			m = map[[4]int]int{}
			merged[file] = m
		}
		m[[4]int{b.l0, b.c0, b.l1, b.c1}] += b.count
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	c := &Coverage{files: map[string][]covBlock{}}
	for file, m := range merged {
		bs := make([]covBlock, 0, len(m))
		for k, n := range m {
			bs = append(bs, covBlock{k[0], k[1], k[2], k[3], n})
		}
		sort.Slice(bs, func(i, j int) bool {
			if bs[i].l0 != bs[j].l0 {
				return bs[i].l0 < bs[j].l0
			}
			return bs[i].c0 < bs[j].c0
		})
		c.files[file] = bs
	}
	return c, nil
}

const (
	stNoPos = iota
	stUninstrumented
	stOutside // instrumented file, but no block contains the position
	stUncovered
	stCovered
)

func (c *Coverage) status(key string, line, col int) int {
	bs, ok := c.files[key]
	if !ok {
		return stUninstrumented
	}
	before := func(l, cc, l2, c2 int) bool { return l < l2 || (l == l2 && cc <= c2) }
	// last block starting at or before (line, col)
	i := sort.Search(len(bs), func(i int) bool { return !before(bs[i].l0, bs[i].c0, line, col) }) - 1
	// blocks do not nest, but scan a few back for safety
	for j := i; j >= 0 && j >= i-3; j-- {
		b := bs[j]
		if before(b.l0, b.c0, line, col) && before(line, col, b.l1, b.c1) {
			if b.count > 0 {
				return stCovered
			}
			return stUncovered
		}
	}
	return stOutside
}

func (c *Coverage) instrStatus(fset *token.FileSet, fileKey map[string]string, in ssa.Instruction) int {
	pos := in.Pos()
	if !pos.IsValid() {
		return stNoPos
	}
	p := fset.Position(pos)
	key, ok := fileKey[p.Filename]
	if !ok {
		return stUninstrumented
	}
	return c.status(key, p.Line, p.Column)
}

// markExecuted decides, for each reachable function, whether it ran and
// which of its basic blocks ran (estimate: a block ran if one of its
// positioned instructions lies in a covered coverage block; blocks with no
// positioned instruction follow their function).
func markExecuted(fset *token.FileSet, fns []*Fn, cov *Coverage, fileKey map[string]string, cg *callgraph.Graph, roots []*ssa.Function) {
	byFn := map[*ssa.Function]*Fn{}
	for _, r := range fns {
		byFn[r.fn] = r
	}
	for _, r := range fns {
		f := r.fn
		r.execBlock = make([]bool, len(f.Blocks))
		state := make([]int, len(f.Blocks)) // max status seen per block
		any, instrumented, anyPos := false, false, false
		for i, b := range f.Blocks {
			for _, in := range b.Instrs {
				s := cov.instrStatus(fset, fileKey, in)
				if s > state[i] {
					state[i] = s
				}
				if s >= stOutside {
					instrumented = true
				}
				if s != stNoPos {
					anyPos = true
				}
			}
			if state[i] == stCovered {
				any = true
			}
		}
		switch {
		case r.Kind == "init":
			r.Exec = "yes" // every reachable package initializer runs at startup
		case any:
			r.Exec = "yes"
		case instrumented:
			r.Exec = "no"
		case !anyPos && len(f.Blocks) > 0:
			r.Exec = "pending" // synthetic: decided from its callees below
		default:
			r.Exec = "unknown"
		}
		if r.Exec == "yes" {
			for i := range f.Blocks {
				r.execBlock[i] = state[i] == stCovered || (state[i] < stUncovered && r.Kind != "init") || r.Kind == "init"
			}
		}
	}
	if cg != nil {
		refine(fns, byFn, cg, roots)
	}
	for _, r := range fns {
		if r.Exec == "pending" {
			r.Exec = "no"
		}
		if r.Exec != "yes" {
			for i := range r.execBlock {
				r.execBlock[i] = false
			}
		}
		for i, b := range r.fn.Blocks {
			if r.execBlock[i] {
				r.ExecBlk++
				r.ExecIns += len(b.Instrs)
			}
		}
	}
}

// refine keeps only functions reached from the roots (and every package
// initializer) through VTA call edges whose call site lies in an executed
// block. Coverage is per source position, so this is what separates the
// instances of a generic function, and decides synthetic wrappers (which
// have no positions). A covered function that is not reached this way
// (called by reflection or the runtime only) is kept and listed in
// CoveredNotReached.
func refine(fns []*Fn, byFn map[*ssa.Function]*Fn, cg *callgraph.Graph, roots []*ssa.Function) {
	reached := map[*ssa.Function]bool{}
	var stack []*ssa.Function
	push := func(f *ssa.Function) {
		if !reached[f] {
			reached[f] = true
			stack = append(stack, f)
		}
	}
	for _, f := range roots {
		push(f)
	}
	for _, r := range fns {
		if r.Kind == "init" {
			push(r.fn)
		}
	}
	for len(stack) > 0 {
		f := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		r := byFn[f]
		if r == nil {
			continue
		}
		if r.Exec == "pending" {
			r.Exec = "yes"
			for i := range r.execBlock {
				r.execBlock[i] = true
			}
		}
		n := cg.Nodes[f]
		if n == nil {
			continue
		}
		for _, e := range n.Out {
			b := e.Site.Block()
			if b == nil || b.Index >= len(r.execBlock) || !r.execBlock[b.Index] {
				continue
			}
			g := byFn[e.Callee.Func]
			if g == nil {
				continue
			}
			if g.Exec == "yes" || g.Exec == "pending" || g.Exec == "unknown" {
				push(g.fn)
			}
		}
	}
	for _, r := range fns {
		if r.Exec == "yes" && !reached[r.fn] {
			if r.Kind == "instance" || r.Kind == "synthetic" || r.Kind == "rangefunc" || (r.Kind == "closure" && len(r.fn.TypeArgs()) > 0) || isInstanceClosure(r.fn) {
				r.Exec = "no" // another instance of the same source ran
			} else {
				CoveredNotReached = append(CoveredNotReached, r.Name)
			}
		}
		if r.Exec == "unknown" && !reached[r.fn] {
			r.Exec = "no"
		}
	}
}

// CoveredNotReached lists covered functions no executed call edge reaches.
var CoveredNotReached []string

func isInstanceClosure(f *ssa.Function) bool {
	for p := f.Parent(); p != nil; p = p.Parent() {
		if len(p.TypeArgs()) > 0 {
			return true
		}
	}
	return false
}
