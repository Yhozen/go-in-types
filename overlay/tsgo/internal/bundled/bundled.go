// go-in-types overlay of internal/bundled/bundled.go (typescript-go v7.0.2):
// no testing import (TestingLibPath always panics outside tests).

// Package bundled provides access to files bundled with TypeScript.
package bundled

import (
	"github.com/microsoft/typescript-go/internal/vfs"
)

//go:generate go run generate.go

// Define the below here to consolidate documentation.

// Embedded is true if the bundled files are implemented through an embedded FS.
const Embedded = embedded

// WrapFS returns an FS which redirects embedded paths to the embedded file system.
// If the embedded file system is not available, it returns the original FS.
func WrapFS(fs vfs.FS) vfs.FS {
	return wrapFS(fs)
}

// LibPath returns the path to the directory containing the bundled lib.d.ts files.
// If embedding is not enabled, this is a path on disk, and must be accessed through
// a real OS filesystem.
func LibPath() string {
	return libPath()
}

var testingLibPath = func() string {
	panic("bundled: TestingLibPath should only be called during tests")
}

// TestingLibPath returns the path to the source bundled libs directory.
// It's only valid to use in tests where the source code is available.
func TestingLibPath() string {
	return testingLibPath()
}
