// go-in-types overlay for cmd/tsgo/main.go (from the stage 0 census harness).
// Census overlay for cmd/tsgo/main.go: a harness close to what the engine
// will run. Files named on the command line are read from disk once, before
// the check, into an in-memory FS rooted at /p; the check itself runs on
// that FS with no OS access, output goes to a buffer printed at exit.
// Does not import internal/execute (no build/watch/LSP/format/pprof).
package main

import (
	"bytes"
	"gointypes/rt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/microsoft/typescript-go/internal/compiler"
	"github.com/microsoft/typescript-go/internal/core"
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

func main() {
	core.ApplyDebugStackLimit()
	args := os.Args[1:]
	files := map[string]string{}
	for _, a := range args {
		if !strings.HasPrefix(a, "-") && strings.HasSuffix(a, ".ts") {
			b, err := os.ReadFile(a)
			if err != nil {
				rt.Exit(3)
			}
			files["/p/"+filepath.Base(a)] = string(b)
		}
	}
	rt.Exit(check(files, args))
}

// check is the engine's entry point: no OS access below this line.
func check(files map[string]string, args []string) int {
	sys := &memSys{fs: vfstest.FromMapWithClock(files, true, fixedClock{}), out: &bytes.Buffer{}}
	commandLine := tsoptions.ParseCommandLine(args, sys)
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
		program := compiler.NewProgram(compiler.ProgramOptions{Config: commandLine, Host: host})
		result, _ := tsc.EmitAndReportStatistics(tsc.EmitInput{
			Sys: sys, ProgramLike: program, Program: program, Config: commandLine,
			ReportDiagnostic: reportDiagnostic, ReportErrorSummary: reportErrorSummary,
			Writer: sys.Writer(), CompileTimes: &tsc.CompileTimes{},
		})
		status = result.Status
	}
	rt.Write(1, sys.out.Bytes())
	return int(status)
}
