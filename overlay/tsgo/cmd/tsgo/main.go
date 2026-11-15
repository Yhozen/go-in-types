// go-in-types overlay for cmd/tsgo/main.go (from the stage 0 census harness).
// Census overlay for cmd/tsgo/main.go: a harness close to what the engine
// will run. Files named on the command line are read from disk once, before
// the check, into an in-memory FS rooted at /p; the check itself runs on
// that FS with no OS access, output goes to a buffer printed at exit.
// Does not import internal/execute (no build/watch/LSP/format/pprof).
// main itself is per build: main_os.go (native: reads the files with os)
// and main_engine.go (-tags gointypes: the engine calls check directly), so
// the engine's program does not import os.
package main

import (
	"bytes"
	"encoding/binary"
	"gointypes/rt"
	"io"
	"time"
	"unicode/utf16"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/compiler"
	"github.com/microsoft/typescript-go/internal/execute/tsc"
	"github.com/microsoft/typescript-go/internal/tsoptions"
	"github.com/microsoft/typescript-go/internal/vfs"
	"github.com/microsoft/typescript-go/internal/vfs/vfstest"
)

type memSys struct {
	fs  vfs.FS
	out *bytes.Buffer
}

// fixedClock: the check never reads the real clock (deterministic runs).
type fixedClock struct{}

func (fixedClock) Now() time.Time            { return time.Time{} }
func (fixedClock) SinceStart() time.Duration { return 0 }

func (s *memSys) SinceStart() time.Duration            { return 0 }
func (s *memSys) Now() time.Time                       { return time.Time{} }
func (s *memSys) FS() vfs.FS                           { return s.fs }
func (s *memSys) DefaultLibraryPath() string           { return "/lib" }
func (s *memSys) GetCurrentDirectory() string          { return "/p" }
func (s *memSys) Writer() io.Writer                    { return s.out }
func (s *memSys) WriteOutputIsTTY() bool               { return false }
func (s *memSys) GetWidthOfTerminal() int              { return 0 }
func (s *memSys) GetEnvironmentVariable(string) string { return "" }

// beforeCheck is set only in native coverage builds (cover_hook.go).
var beforeCheck func()

// check is the engine's entry point: no OS access below this line.
func check(files map[string]string, args []string) int {
	if beforeCheck != nil {
		beforeCheck()
	}
	sys := newSys(files)
	status := run(sys, tsoptions.ParseCommandLine(args, sys), nil)
	rt.Write(1, sys.out.Bytes())
	return status
}

// Boot image entries (ts-in-types stage 3). boot runs one full check (the
// warm-up) and keeps its parsed command line and every parsed and bound
// source file but /p/main.ts (the libs); checkWarm then checks a new
// /p/main.ts with both reused, as a watch compiler host reuses unchanged
// files. A host snapshots the machine after boot returns (the image) and
// calls checkWarm from it.
type warmState struct {
	files       map[string]string
	commandLine *tsoptions.ParsedCommandLine
	sources     map[string]*ast.SourceFile
	fs          *memoFS
}

var warm *warmState

const mainPath = "/p/main.ts"

func boot(files map[string]string, args []string) int {
	status, out := bootQuiet(files, args)
	rt.Write(1, out)
	return status
}

// bootQuiet is boot without printing the warm-up's output.
func bootQuiet(files map[string]string, args []string) (int, []byte) {
	sys := newSys(files)
	fs := &memoFS{FS: sys.fs, fileExists: map[string]bool{}, dirExists: map[string]bool{}}
	sys.fs = fs
	warm = &warmState{files: files, commandLine: tsoptions.ParseCommandLine(args, sys), sources: map[string]*ast.SourceFile{}, fs: fs}
	return run(sys, warm.commandLine, warm), sys.out.Bytes()
}

func checkWarm(main string) int {
	files := make(map[string]string, len(warm.files))
	for k, v := range warm.files {
		files[k] = v
	}
	files[mainPath] = main
	sys := &memSys{fs: &warmFS{base: warm.fs, files: files, main: main}, out: &bytes.Buffer{}}
	status := run(sys, warm.commandLine, warm)
	rt.Write(1, sys.out.Bytes())
	return status
}

// reuseHost returns the kept source files and keeps new ones but main.ts.
type reuseHost struct {
	compiler.CompilerHost
	w *warmState
}

func (h *reuseHost) GetSourceFile(opts ast.SourceFileParseOptions) *ast.SourceFile {
	if f, ok := h.w.sources[opts.FileName]; ok {
		return f
	}
	f := h.CompilerHost.GetSourceFile(opts)
	if f != nil && opts.FileName != mainPath {
		h.w.sources[opts.FileName] = f
	}
	return f
}

// memoFS is the boot FS with FileExists and DirectoryExists memoised. Their
// answers depend only on the set of paths, which checkWarm keeps (it only
// replaces /p/main.ts's text), so the answers of the warm-up check stay in
// the image and later checks reuse them.
type memoFS struct {
	vfs.FS
	fileExists, dirExists map[string]bool
}

func (m *memoFS) FileExists(path string) bool {
	r, ok := m.fileExists[path]
	if !ok {
		r = m.FS.FileExists(path)
		m.fileExists[path] = r
	}
	return r
}

func (m *memoFS) DirectoryExists(path string) bool {
	r, ok := m.dirExists[path]
	if !ok {
		r = m.FS.DirectoryExists(path)
		m.dirExists[path] = r
	}
	return r
}

// warmFS is checkWarm's FS: the same answers as
// vfstest.FromMapWithClock(files, true, fixedClock{}) (newSys), without
// building it unless needed. Queries that depend only on the paths go to the
// boot FS (same paths); ReadFile of exactly /p/main.ts decodes the new text
// as vfstest does; everything else (and everything after a write) goes to a
// full FS of the files, built on first use.
type warmFS struct {
	base  *memoFS
	files map[string]string
	main  string
	full  vfs.FS
	dirty bool
}

func (w *warmFS) fullFS() vfs.FS {
	if w.full == nil {
		w.full = vfstest.FromMapWithClock(w.files, true, fixedClock{})
	}
	return w.full
}

func (w *warmFS) UseCaseSensitiveFileNames() bool { return true }

func (w *warmFS) FileExists(path string) bool {
	if w.dirty {
		return w.full.FileExists(path)
	}
	return w.base.FileExists(path)
}

func (w *warmFS) DirectoryExists(path string) bool {
	if w.dirty {
		return w.full.DirectoryExists(path)
	}
	return w.base.DirectoryExists(path)
}

func (w *warmFS) GetAccessibleEntries(path string) vfs.Entries {
	if w.dirty {
		return w.full.GetAccessibleEntries(path)
	}
	return w.base.GetAccessibleEntries(path)
}

func (w *warmFS) Realpath(path string) string {
	if w.dirty {
		return w.full.Realpath(path)
	}
	return w.base.Realpath(path)
}

func (w *warmFS) ReadFile(path string) (string, bool) {
	if !w.dirty && path == mainPath {
		return decodeBytes(w.main), true
	}
	return w.fullFS().ReadFile(path)
}

func (w *warmFS) Stat(path string) vfs.FileInfo { return w.fullFS().Stat(path) }

func (w *warmFS) WalkDir(root string, walkFn vfs.WalkDirFunc) error {
	return w.fullFS().WalkDir(root, walkFn)
}

func (w *warmFS) WriteFile(path string, data string) error {
	w.dirty = true
	return w.fullFS().WriteFile(path, data)
}

func (w *warmFS) AppendFile(path string, data string) error {
	w.dirty = true
	return w.fullFS().AppendFile(path, data)
}

func (w *warmFS) Remove(path string) error {
	w.dirty = true
	return w.fullFS().Remove(path)
}

func (w *warmFS) Chtimes(path string, aTime time.Time, mTime time.Time) error {
	w.dirty = true
	return w.fullFS().Chtimes(path, aTime, mTime)
}

// decodeBytes is internal/vfs/internal.decodeBytes (v7.0.2), which
// vfstest's ReadFile applies to a file's bytes: a UTF-16 BOM decodes the
// rest as UTF-16 (a trailing odd byte is dropped, as binary.Read does), a
// UTF-8 BOM is dropped.
func decodeBytes(s string) string {
	if len(s) >= 2 {
		var order binary.ByteOrder
		switch {
		case s[0] == 0xFF && s[1] == 0xFE:
			order = binary.LittleEndian
		case s[0] == 0xFE && s[1] == 0xFF:
			order = binary.BigEndian
		}
		if order != nil {
			b := []byte(s[2:])
			ints := make([]uint16, len(b)/2)
			for i := range ints {
				ints[i] = order.Uint16(b[2*i:])
			}
			return string(utf16.Decode(ints))
		}
	}
	if len(s) >= 3 && s[0] == 0xEF && s[1] == 0xBB && s[2] == 0xBF {
		return s[3:]
	}
	return s
}

func newSys(files map[string]string) *memSys {
	return &memSys{fs: vfstest.FromMapWithClock(files, true, fixedClock{}), out: &bytes.Buffer{}}
}

// run is the rest of a check (tsc's performCompilation for this command
// line), printing to sys.out; with w, source files are reused through w.
func run(sys *memSys, commandLine *tsoptions.ParsedCommandLine, w *warmState) int {
	locale := commandLine.Locale()
	reportDiagnostic := tsc.CreateDiagnosticReporter(sys, sys.Writer(), locale, commandLine.CompilerOptions())
	status := tsc.ExitStatusDiagnosticsPresent_OutputsSkipped
	if len(commandLine.Errors) > 0 {
		for _, e := range commandLine.Errors {
			reportDiagnostic(e)
		}
	} else {
		reportErrorSummary := tsc.CreateReportErrorSummary(sys, locale, commandLine.CompilerOptions())
		host := compiler.NewCachedFSCompilerHost(sys.GetCurrentDirectory(), sys.FS(), sys.DefaultLibraryPath(), &tsc.ExtendedConfigCache{}, nil)
		if w != nil {
			host = &reuseHost{CompilerHost: host, w: w}
		}
		program := compiler.NewProgram(compiler.ProgramOptions{Config: commandLine, Host: host})
		result, _ := tsc.EmitAndReportStatistics(tsc.EmitInput{
			Sys: sys, ProgramLike: program, Program: program, Config: commandLine,
			ReportDiagnostic: reportDiagnostic, ReportErrorSummary: reportErrorSummary,
			Writer: sys.Writer(), CompileTimes: &tsc.CompileTimes{},
		})
		status = result.Status
	}
	return int(status)
}
