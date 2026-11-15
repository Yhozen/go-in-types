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
	"gointypes/rt"
	"io"
	"time"

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
	warm = &warmState{files: files, commandLine: tsoptions.ParseCommandLine(args, sys), sources: map[string]*ast.SourceFile{}}
	return run(sys, warm.commandLine, warm), sys.out.Bytes()
}

func checkWarm(main string) int {
	files := make(map[string]string, len(warm.files))
	for k, v := range warm.files {
		files[k] = v
	}
	files[mainPath] = main
	sys := newSys(files)
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
