// Command opsharness runs the TypeScript 7 compiler (typescript-go v7.0.2)
// on the one-liner with an in-memory file system, so that it can be run
// natively and under the counting SSA interpreter (../count).
//
// It is compiled into the typescript-go module through an overlay (see
// ../README.md) because it imports internal packages.
//
//	opsharness cli    <lib>   execute.CommandLine, as cmd/tsgo does
//	opsharness phased <lib>   the same pipeline by hand, with phase marks,
//	                          then a warm second check that reuses the
//	                          parsed and bound lib file
//
// <lib> is "mini" or "es5"; the lib text is read from $OPS_LIB_DIR.
package main

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strings"
	"time"

	"github.com/microsoft/typescript-go/internal/ast"
	"github.com/microsoft/typescript-go/internal/compiler"
	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/execute"
	"github.com/microsoft/typescript-go/internal/execute/tsc"
	"github.com/microsoft/typescript-go/internal/tsoptions"
	"github.com/microsoft/typescript-go/internal/tspath"
	"github.com/microsoft/typescript-go/internal/vfs"
)

const mainText = "const x: number = 'hello';\n"

// Mark starts a new accounting phase. The counting interpreter intercepts
// it (by name, main.Mark); under wasmtime it calls the host (ops.mark, see
// mark_wasip1.go) so the runner can read the fuel; natively it does nothing.
//
//go:noinline
func Mark(name string) { hostMark(name) }

// Input returns the run's mode, lib name and lib text. The counting
// interpreter intercepts it (main.Input); natively it reads os.Args.
//
//go:noinline
func Input() (mode, lib, libText string) {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: opsharness cli|phased mini|es5")
		os.Exit(2)
	}
	mode, lib = os.Args[1], os.Args[2]
	b, err := os.ReadFile(os.Getenv("OPS_LIB_DIR") + "/lib." + lib + ".d.ts")
	if err != nil {
		panic(err)
	}
	return mode, lib, string(b)
}

// Output receives everything the compiler printed. Intercepted as
// main.Output by the interpreter.
//
//go:noinline
func Output(s string) { os.Stdout.WriteString(s) }

func main() {
	Mark("start")
	mode, lib, libText := Input()
	libName := "lib." + lib + ".d.ts"
	fsys := newMapFS(map[string]string{
		"/p/main.ts":    mainText,
		"/p/" + libName: libText,
	})
	var out strings.Builder
	sys := &memSys{fs: fsys, w: &out}
	args := []string{"--noLib", "--noEmit", "--skipLibCheck", "--singleThreaded", libName, "main.ts"}
	switch mode {
	case "cli":
		Mark("cli")
		res := execute.CommandLine(context.Background(), sys, args, nil)
		Mark("end")
		Output(out.String())
		Output(fmt.Sprintf("exit %d\n", int(res.Status)))
	case "phased":
		cache := &sourceCache{files: map[string]*ast.SourceFile{}, keep: "/p/" + libName}
		phased(sys, args, cache, "")
		Mark("end")
		Output(out.String())
		out.Reset()
		phased(sys, args, cache, "warm:")
		Mark("end")
		Output(out.String())
	default:
		panic("bad mode " + mode)
	}
}

// phased replicates execute.CommandLine → tscCompilation →
// performCompilation → EmitFilesAndReportErrors for this command line
// (no tsconfig, not pretty, --noEmit), with phase marks.
func phased(sys *memSys, args []string, cache *sourceCache, prefix string) {
	ctx := context.Background()
	Mark(prefix + "options")
	commandLine := tsoptions.ParseCommandLine(args, sys)
	locale := commandLine.Locale()
	reportDiagnostic := tsc.CreateDiagnosticReporter(sys, sys.Writer(), locale, commandLine.CompilerOptions())
	reportErrorSummary := tsc.CreateReportErrorSummary(sys, locale, commandLine.CompilerOptions())
	extendedConfigCache := &tsc.ExtendedConfigCache{}
	inner := compiler.NewCachedFSCompilerHost(sys.GetCurrentDirectory(), sys.FS(), sys.DefaultLibraryPath(), extendedConfigCache, nil)
	host := &markingHost{CompilerHost: inner, cache: cache, prefix: prefix}
	Mark(prefix + "program")
	program := compiler.NewProgram(compiler.ProgramOptions{Config: commandLine, Host: host})
	Mark(prefix + "diagnostics")
	allDiagnostics := compiler.GetDiagnosticsOfAnyProgram(ctx, program, nil, false,
		func(ctx context.Context, file *ast.SourceFile) []*ast.Diagnostic {
			Mark(prefix + "bind")
			d := program.GetBindDiagnostics(ctx, file)
			Mark(prefix + "global")
			return d
		},
		func(ctx context.Context, file *ast.SourceFile) []*ast.Diagnostic {
			Mark(prefix + "check")
			d := program.GetSemanticDiagnostics(ctx, file)
			Mark(prefix + "diagnostics")
			return d
		},
	)
	Mark(prefix + "emit")
	emitResult := program.Emit(ctx, compiler.EmitOptions{})
	if emitResult != nil {
		allDiagnostics = append(allDiagnostics, emitResult.Diagnostics...)
	}
	Mark(prefix + "print")
	allDiagnostics = compiler.SortAndDeduplicateDiagnostics(allDiagnostics)
	for _, d := range allDiagnostics {
		reportDiagnostic(d)
	}
	reportErrorSummary(allDiagnostics)
}

// markingHost marks each file parse as its own phase and keeps the parsed
// lib file for later programs (as the watch compiler host does).
type markingHost struct {
	compiler.CompilerHost
	cache  *sourceCache
	prefix string
}

type sourceCache struct {
	files map[string]*ast.SourceFile
	keep  string
}

func (h *markingHost) GetSourceFile(opts ast.SourceFileParseOptions) *ast.SourceFile {
	if f, ok := h.cache.files[opts.FileName]; ok {
		return f
	}
	Mark(h.prefix + "parse " + tspath.GetBaseFileName(opts.FileName))
	f := h.CompilerHost.GetSourceFile(opts)
	Mark(h.prefix + "program")
	if opts.FileName == h.cache.keep {
		h.cache.files[opts.FileName] = f
	}
	return f
}

// memSys is tsc.System over an in-memory file system.
type memSys struct {
	fs vfs.FS
	w  io.Writer
}

func (s *memSys) Writer() io.Writer                         { return s.w }
func (s *memSys) FS() vfs.FS                                { return s.fs }
func (s *memSys) DefaultLibraryPath() string                { return "/lib" }
func (s *memSys) GetCurrentDirectory() string               { return "/p" }
func (s *memSys) WriteOutputIsTTY() bool                    { return false }
func (s *memSys) GetWidthOfTerminal() int                   { return 0 }
func (s *memSys) GetEnvironmentVariable(name string) string { return "" }
func (s *memSys) Now() time.Time                            { return time.Time{} }
func (s *memSys) SinceStart() time.Duration                 { return 0 }

var _ tsc.System = (*memSys)(nil)
var _ = core.TSTrue

// mapFS is a minimal read-only vfs.FS: files at absolute paths, with the
// directories implied by them.
type mapFS struct {
	files map[string]string
	dirs  map[string]bool
}

func newMapFS(files map[string]string) *mapFS {
	m := &mapFS{files: files, dirs: map[string]bool{"/": true}}
	for p := range files {
		for d := tspath.GetDirectoryPath(p); d != "/" && d != ""; d = tspath.GetDirectoryPath(d) {
			m.dirs[d] = true
		}
	}
	return m
}

func (m *mapFS) UseCaseSensitiveFileNames() bool { return true }
func (m *mapFS) FileExists(path string) bool     { _, ok := m.files[path]; return ok }
func (m *mapFS) ReadFile(path string) (string, bool) {
	s, ok := m.files[path]
	return s, ok
}
func (m *mapFS) WriteFile(path string, data string) error  { return vfs.ErrPermission }
func (m *mapFS) AppendFile(path string, data string) error { return vfs.ErrPermission }
func (m *mapFS) Remove(path string) error                  { return vfs.ErrPermission }
func (m *mapFS) Chtimes(path string, a, b time.Time) error { return vfs.ErrPermission }
func (m *mapFS) DirectoryExists(path string) bool          { return m.dirs[path] }
func (m *mapFS) GetAccessibleEntries(path string) vfs.Entries {
	var e vfs.Entries
	for p := range m.files {
		if tspath.GetDirectoryPath(p) == path {
			e.Files = append(e.Files, tspath.GetBaseFileName(p))
		}
	}
	for d := range m.dirs {
		if d != path && tspath.GetDirectoryPath(d) == path {
			e.Directories = append(e.Directories, tspath.GetBaseFileName(d))
		}
	}
	return e
}
func (m *mapFS) Stat(path string) vfs.FileInfo {
	if s, ok := m.files[path]; ok {
		return fileInfo{name: tspath.GetBaseFileName(path), size: int64(len(s))}
	}
	if m.dirs[path] {
		return fileInfo{name: tspath.GetBaseFileName(path), dir: true}
	}
	return nil
}
func (m *mapFS) WalkDir(root string, fn vfs.WalkDirFunc) error {
	return fmt.Errorf("WalkDir not supported")
}
func (m *mapFS) Realpath(path string) string { return path }

type fileInfo struct {
	name string
	size int64
	dir  bool
}

func (f fileInfo) Name() string { return f.name }
func (f fileInfo) Size() int64  { return f.size }
func (f fileInfo) Mode() fs.FileMode {
	if f.dir {
		return fs.ModeDir | 0o755
	}
	return 0o644
}
func (f fileInfo) ModTime() time.Time { return time.Time{} }
func (f fileInfo) IsDir() bool        { return f.dir }
func (f fileInfo) Sys() any           { return nil }
