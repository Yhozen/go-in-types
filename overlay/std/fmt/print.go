// go-in-types overlay of fmt/print.go (Go 1.27.4), modified: no reflect, no
// sync.Pool, no os (Print* write to fd 1 through gointypes/rt). Composite
// values print through type switches (printValue); %T knows predeclared
// types only (typeString). Everything else is real fmt.
//
// Copyright 2009 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package fmt

import (
	"cmp"
	"gointypes/rt"
	"io"
	"slices"
	"strconv"
	"unicode/utf8"
)

// Strings for use with buffer.WriteString.
// This is less overhead than using buffer.Write with byte arrays.
const (
	commaSpaceString  = ", "
	nilAngleString    = "<nil>"
	nilParenString    = "(nil)"
	nilString         = "nil"
	mapString         = "map["
	percentBangString = "%!"
	missingString     = "(MISSING)"
	badIndexString    = "(BADINDEX)"
	panicString       = "(PANIC="
	extraString       = "%!(EXTRA "
	badWidthString    = "%!(BADWIDTH)"
	badPrecString     = "%!(BADPREC)"
	noVerbString      = "%!(NOVERB)"
	invReflectString  = "<invalid rvalue>"
)

// State represents the printer state passed to custom formatters.
// It provides access to the [io.Writer] interface plus information about
// the flags and options for the operand's format specifier.
type State interface {
	// Write is the function to call to emit formatted output to be printed.
	Write(b []byte) (n int, err error)
	// Width returns the value of the width option and whether it has been set.
	Width() (wid int, ok bool)
	// Precision returns the value of the precision option and whether it has been set.
	Precision() (prec int, ok bool)

	// Flag reports whether the flag c, a character, has been set.
	Flag(c int) bool
}

// Formatter is implemented by any value that has a Format method.
// The implementation controls how [State] and rune are interpreted,
// and may call [Sprint] or [Fprint](f) etc. to generate its output.
type Formatter interface {
	Format(f State, verb rune)
}

// Stringer is implemented by any value that has a String method,
// which defines the “native” format for that value.
// The String method is used to print values passed as an operand
// to any format that accepts a string or to an unformatted printer
// such as [Print].
type Stringer interface {
	String() string
}

// GoStringer is implemented by any value that has a GoString method,
// which defines the Go syntax for that value.
// The GoString method is used to print values passed as an operand
// to a %#v format.
type GoStringer interface {
	GoString() string
}

// FormatString returns a string representing the fully qualified formatting
// directive captured by the [State], followed by the argument verb. ([State] does not
// itself contain the verb.) The result has a leading percent sign followed by any
// flags, the width, and the precision. Missing flags, width, and precision are
// omitted. This function allows a [Formatter] to reconstruct the original
// directive triggering the call to Format.
func FormatString(state State, verb rune) string {
	var tmp [16]byte // Use a local buffer.
	b := append(tmp[:0], '%')
	for _, c := range " +-#0" { // All known flags
		if state.Flag(int(c)) { // The argument is an int for historical reasons.
			b = append(b, byte(c))
		}
	}
	if w, ok := state.Width(); ok {
		b = strconv.AppendInt(b, int64(w), 10)
	}
	if p, ok := state.Precision(); ok {
		b = append(b, '.')
		b = strconv.AppendInt(b, int64(p), 10)
	}
	b = utf8.AppendRune(b, verb)
	return string(b)
}

// stdout writes to fd 1 through gointypes/rt (the engine's only output).
var stdout io.Writer = rtWriter(1)

type rtWriter int

func (w rtWriter) Write(b []byte) (int, error) {
	rt.Write(int(w), b)
	return len(b), nil
}

// Use simple []byte instead of bytes.Buffer to avoid large dependency.
type buffer []byte

func (b *buffer) write(p []byte) {
	*b = append(*b, p...)
}

func (b *buffer) writeString(s string) {
	*b = append(*b, s...)
}

func (b *buffer) writeByte(c byte) {
	*b = append(*b, c)
}

func (b *buffer) writeRune(r rune) {
	*b = utf8.AppendRune(*b, r)
}

// pp is used to store a printer's state and is reused with sync.Pool to avoid allocations.
type pp struct {
	buf buffer

	// fmt is used to format basic items such as integers or strings.
	fmt fmt

	// reordered records whether the format string used argument reordering.
	reordered bool
	// goodArgNum records whether the most recent reordering directive was valid.
	goodArgNum bool
	// panicking is set by catchPanic to avoid infinite panic, recover, panic, ... recursion.
	panicking bool
	// erroring is set when printing an error string to guard against calling handleMethods.
	erroring bool
	// wrapErrs is set when the format string may contain a %w verb.
	wrapErrs bool
	// wrappedErrs records the targets of the %w verb.
	wrappedErrs []int
}


// newPrinter allocates a new pp struct or grabs a cached one.
func newPrinter() *pp {
	p := new(pp)
	p.panicking = false
	p.erroring = false
	p.wrapErrs = false
	p.fmt.init(&p.buf)
	return p
}

// free saves used pp structs in ppFree; avoids an allocation per invocation.
func (p *pp) free() {
}

func (p *pp) Width() (wid int, ok bool) { return p.fmt.wid, p.fmt.widPresent }

func (p *pp) Precision() (prec int, ok bool) { return p.fmt.prec, p.fmt.precPresent }

func (p *pp) Flag(b int) bool {
	switch b {
	case '-':
		return p.fmt.minus
	case '+':
		return p.fmt.plus || p.fmt.plusV
	case '#':
		return p.fmt.sharp || p.fmt.sharpV
	case ' ':
		return p.fmt.space
	case '0':
		return p.fmt.zero
	}
	return false
}

// Write implements [io.Writer] so we can call [Fprintf] on a pp (through [State]), for
// recursive use in custom verbs.
func (p *pp) Write(b []byte) (ret int, err error) {
	p.buf.write(b)
	return len(b), nil
}

// WriteString implements [io.StringWriter] so that we can call [io.WriteString]
// on a pp (through state), for efficiency.
func (p *pp) WriteString(s string) (ret int, err error) {
	p.buf.writeString(s)
	return len(s), nil
}

// These routines end in 'f' and take a format string.

// Fprintf formats according to a format specifier and writes to w.
// It returns the number of bytes written and any write error encountered.
func Fprintf(w io.Writer, format string, a ...any) (n int, err error) {
	p := newPrinter()
	p.doPrintf(format, a)
	n, err = w.Write(p.buf)
	p.free()
	return
}

// Printf formats according to a format specifier and writes to standard output.
// It returns the number of bytes written and any write error encountered.
func Printf(format string, a ...any) (n int, err error) {
	return Fprintf(stdout, format, a...)
}

// Sprintf formats according to a format specifier and returns the resulting string.
func Sprintf(format string, a ...any) string {
	p := newPrinter()
	p.doPrintf(format, a)
	s := string(p.buf)
	p.free()
	return s
}

// Appendf formats according to a format specifier, appends the result to the byte
// slice, and returns the updated slice.
func Appendf(b []byte, format string, a ...any) []byte {
	p := newPrinter()
	p.doPrintf(format, a)
	b = append(b, p.buf...)
	p.free()
	return b
}

// These routines do not take a format string

// Fprint formats using the default formats for its operands and writes to w.
// Spaces are added between operands when neither is a string.
// It returns the number of bytes written and any write error encountered.
func Fprint(w io.Writer, a ...any) (n int, err error) {
	p := newPrinter()
	p.doPrint(a)
	n, err = w.Write(p.buf)
	p.free()
	return
}

// Print formats using the default formats for its operands and writes to standard output.
// Spaces are added between operands when neither is a string.
// It returns the number of bytes written and any write error encountered.
func Print(a ...any) (n int, err error) {
	return Fprint(stdout, a...)
}

// Sprint formats using the default formats for its operands and returns the resulting string.
// Spaces are added between operands when neither is a string.
func Sprint(a ...any) string {
	p := newPrinter()
	p.doPrint(a)
	s := string(p.buf)
	p.free()
	return s
}

// Append formats using the default formats for its operands, appends the result to
// the byte slice, and returns the updated slice.
// Spaces are added between operands when neither is a string.
func Append(b []byte, a ...any) []byte {
	p := newPrinter()
	p.doPrint(a)
	b = append(b, p.buf...)
	p.free()
	return b
}

// These routines end in 'ln', do not take a format string,
// always add spaces between operands, and add a newline
// after the last operand.

// Fprintln formats using the default formats for its operands and writes to w.
// Spaces are always added between operands and a newline is appended.
// It returns the number of bytes written and any write error encountered.
func Fprintln(w io.Writer, a ...any) (n int, err error) {
	p := newPrinter()
	p.doPrintln(a)
	n, err = w.Write(p.buf)
	p.free()
	return
}

// Println formats using the default formats for its operands and writes to standard output.
// Spaces are always added between operands and a newline is appended.
// It returns the number of bytes written and any write error encountered.
func Println(a ...any) (n int, err error) {
	return Fprintln(stdout, a...)
}

// Sprintln formats using the default formats for its operands and returns the resulting string.
// Spaces are always added between operands and a newline is appended.
func Sprintln(a ...any) string {
	p := newPrinter()
	p.doPrintln(a)
	s := string(p.buf)
	p.free()
	return s
}

// Appendln formats using the default formats for its operands, appends the result
// to the byte slice, and returns the updated slice. Spaces are always added
// between operands and a newline is appended.
func Appendln(b []byte, a ...any) []byte {
	p := newPrinter()
	p.doPrintln(a)
	b = append(b, p.buf...)
	p.free()
	return b
}


// tooLarge reports whether the magnitude of the integer is
// too large to be used as a formatting width or precision.
func tooLarge(x int) bool {
	const max int = 1e6
	return x > max || x < -max
}

// parsenum converts ASCII to integer.  num is 0 (and isnum is false) if no number present.
func parsenum(s string, start, end int) (num int, isnum bool, newi int) {
	if start >= end {
		return 0, false, end
	}
	for newi = start; newi < end && '0' <= s[newi] && s[newi] <= '9'; newi++ {
		if tooLarge(num) {
			return 0, false, end // Overflow; crazy long number most likely.
		}
		num = num*10 + int(s[newi]-'0')
		isnum = true
	}
	return
}


func (p *pp) badVerb(arg any, value rvalue, verb rune) {
	p.erroring = true
	p.buf.writeString(percentBangString)
	p.buf.writeRune(verb)
	p.buf.writeByte('(')
	switch {
	case arg != nil:
		p.buf.writeString(typeString(arg))
		p.buf.writeByte('=')
		p.printArg(arg, 'v')
	default:
		p.buf.writeString(nilAngleString)
	}
	p.buf.writeByte(')')
	p.erroring = false
}

func (p *pp) fmtBool(arg any, value rvalue, v bool, verb rune) {
	switch verb {
	case 't', 'v':
		p.fmt.fmtBoolean(v)
	default:
		p.badVerb(arg, value, verb)
	}
}

// fmt0x64 formats a uint64 in hexadecimal and prefixes it with 0x or
// not, as requested, by temporarily setting the sharp flag.
func (p *pp) fmt0x64(v uint64, leading0x bool) {
	sharp := p.fmt.sharp
	p.fmt.sharp = leading0x
	p.fmt.fmtInteger(v, 16, unsigned, 'v', ldigits)
	p.fmt.sharp = sharp
}

// fmtInteger formats a signed or unsigned integer.
func (p *pp) fmtInteger(arg any, value rvalue, v uint64, isSigned bool, verb rune) {
	switch verb {
	case 'v':
		if p.fmt.sharpV && !isSigned {
			p.fmt0x64(v, true)
		} else {
			p.fmt.fmtInteger(v, 10, isSigned, verb, ldigits)
		}
	case 'd':
		p.fmt.fmtInteger(v, 10, isSigned, verb, ldigits)
	case 'b':
		p.fmt.fmtInteger(v, 2, isSigned, verb, ldigits)
	case 'o', 'O':
		p.fmt.fmtInteger(v, 8, isSigned, verb, ldigits)
	case 'x':
		p.fmt.fmtInteger(v, 16, isSigned, verb, ldigits)
	case 'X':
		p.fmt.fmtInteger(v, 16, isSigned, verb, udigits)
	case 'c':
		p.fmt.fmtC(v)
	case 'q':
		p.fmt.fmtQc(v)
	case 'U':
		p.fmt.fmtUnicode(v)
	default:
		p.badVerb(arg, value, verb)
	}
}

// fmtFloat formats a float. The default precision for each verb
// is specified as last argument in the call to fmt_float.
func (p *pp) fmtFloat(arg any, value rvalue, v float64, size int, verb rune) {
	switch verb {
	case 'v':
		p.fmt.fmtFloat(v, size, 'g', -1)
	case 'b', 'g', 'G', 'x', 'X':
		p.fmt.fmtFloat(v, size, verb, -1)
	case 'f', 'e', 'E':
		p.fmt.fmtFloat(v, size, verb, 6)
	case 'F':
		p.fmt.fmtFloat(v, size, 'f', 6)
	default:
		p.badVerb(arg, value, verb)
	}
}


func (p *pp) fmtString(arg any, value rvalue, v string, verb rune) {
	switch verb {
	case 'v':
		if p.fmt.sharpV {
			p.fmt.fmtQ(v)
		} else {
			p.fmt.fmtS(v)
		}
	case 's':
		p.fmt.fmtS(v)
	case 'x':
		p.fmt.fmtSx(v, ldigits)
	case 'X':
		p.fmt.fmtSx(v, udigits)
	case 'q':
		p.fmt.fmtQ(v)
	default:
		p.badVerb(arg, value, verb)
	}
}

func (p *pp) fmtBytes(v []byte, verb rune, typeString string) {
	switch verb {
	case 'v', 'd':
		if p.fmt.sharpV {
			p.buf.writeString(typeString)
			if v == nil {
				p.buf.writeString(nilParenString)
				return
			}
			p.buf.writeByte('{')
			for i, c := range v {
				if i > 0 {
					p.buf.writeString(commaSpaceString)
				}
				p.fmt0x64(uint64(c), true)
			}
			p.buf.writeByte('}')
		} else {
			p.buf.writeByte('[')
			for i, c := range v {
				if i > 0 {
					p.buf.writeByte(' ')
				}
				p.fmt.fmtInteger(uint64(c), 10, unsigned, verb, ldigits)
			}
			p.buf.writeByte(']')
		}
	case 's':
		p.fmt.fmtBs(v)
	case 'x':
		p.fmt.fmtBx(v, ldigits)
	case 'X':
		p.fmt.fmtBx(v, udigits)
	case 'q':
		p.fmt.fmtQ(string(v))
	default:
		p.printValue(v, verb, 0)
	}
}

// fmtPointer: pointer values need reflection; this fmt reports them as bad verbs.
func (p *pp) fmtPointer(arg any, value rvalue, verb rune) {
	p.badVerb(arg, value, verb)
}

func (p *pp) catchPanic(arg any, verb rune, method string) {
	if err := recover(); err != nil {
		// If it's a nil pointer, just say "<nil>". The likeliest causes are a
		// Stringer that fails to guard against nil or a nil pointer for a
		// value receiver, and in either case, "<nil>" is a nice result.
		// (Real fmt prints "<nil>" for a nil pointer receiver here; that needs
		// reflection, so this fmt reports the panic instead.)
		// Otherwise print a concise panic message. Most of the time the panic
		// value will print itself nicely.
		if p.panicking {
			// Nested panics; the recursion in printArg cannot succeed.
			panic(err)
		}

		oldFlags := p.fmt.fmtFlags
		// For this output we want default behavior.
		p.fmt.clearflags()

		p.buf.writeString(percentBangString)
		p.buf.writeRune(verb)
		p.buf.writeString(panicString)
		p.buf.writeString(method)
		p.buf.writeString(" method: ")
		p.panicking = true
		p.printArg(err, 'v')
		p.panicking = false
		p.buf.writeByte(')')

		p.fmt.fmtFlags = oldFlags
	}
}

func (p *pp) handleMethods(arg any, value rvalue, verb rune) (handled bool) {
	if p.erroring {
		return
	}
	if verb == 'w' {
		// It is invalid to use %w other than with Errorf or with a non-error arg.
		_, ok := arg.(error)
		if !ok || !p.wrapErrs {
			p.badVerb(arg, value, verb)
			return true
		}
		// If the arg is a Formatter, pass 'v' as the verb to it.
		verb = 'v'
	}

	// Is it a Formatter?
	if formatter, ok := arg.(Formatter); ok {
		handled = true
		defer p.catchPanic(arg, verb, "Format")
		formatter.Format(p, verb)
		return
	}

	// If we're doing Go syntax and the argument knows how to supply it, take care of it now.
	if p.fmt.sharpV {
		if stringer, ok := arg.(GoStringer); ok {
			handled = true
			defer p.catchPanic(arg, verb, "GoString")
			// Print the result of GoString unadorned.
			p.fmt.fmtS(stringer.GoString())
			return
		}
	} else {
		// If a string is acceptable according to the format, see if
		// the value satisfies one of the string-valued interfaces.
		// Println etc. set verb to %v, which is "stringable".
		switch verb {
		case 'v', 's', 'x', 'X', 'q':
			// Is it an error or Stringer?
			// The duplication in the bodies is necessary:
			// setting handled and deferring catchPanic
			// must happen before calling the method.
			switch v := arg.(type) {
			case error:
				handled = true
				defer p.catchPanic(arg, verb, "Error")
				p.fmtString(arg, value, v.Error(), verb)
				return

			case Stringer:
				handled = true
				defer p.catchPanic(arg, verb, "String")
				p.fmtString(arg, value, v.String(), verb)
				return
			}
		}
	}
	return false
}

func (p *pp) printArg(arg any, verb rune) {
	if arg == nil {
		switch verb {
		case 'T', 'v':
			p.fmt.padString(nilAngleString)
		default:
			p.badVerb(arg, rvalue{}, verb)
		}
		return
	}

	// Special processing considerations.
	// %T (the value's type) and %p (its address) are special; we always do them first.
	switch verb {
	case 'T':
		p.fmt.fmtS(typeString(arg))
		return
	case 'p':
		p.fmtPointer(arg, rvalue{}, 'p')
		return
	}

	// Some types can be done without reflection.
	switch f := arg.(type) {
	case bool:
		p.fmtBool(arg, rvalue{}, f, verb)
	case float32:
		p.fmtFloat(arg, rvalue{}, float64(f), 32, verb)
	case float64:
		p.fmtFloat(arg, rvalue{}, f, 64, verb)
	case int:
		p.fmtInteger(arg, rvalue{}, uint64(f), signed, verb)
	case int8:
		p.fmtInteger(arg, rvalue{}, uint64(f), signed, verb)
	case int16:
		p.fmtInteger(arg, rvalue{}, uint64(f), signed, verb)
	case int32:
		p.fmtInteger(arg, rvalue{}, uint64(f), signed, verb)
	case int64:
		p.fmtInteger(arg, rvalue{}, uint64(f), signed, verb)
	case uint:
		p.fmtInteger(arg, rvalue{}, uint64(f), unsigned, verb)
	case uint8:
		p.fmtInteger(arg, rvalue{}, uint64(f), unsigned, verb)
	case uint16:
		p.fmtInteger(arg, rvalue{}, uint64(f), unsigned, verb)
	case uint32:
		p.fmtInteger(arg, rvalue{}, uint64(f), unsigned, verb)
	case uint64:
		p.fmtInteger(arg, rvalue{}, f, unsigned, verb)
	case uintptr:
		p.fmtInteger(arg, rvalue{}, uint64(f), unsigned, verb)
	case string:
		p.fmtString(arg, rvalue{}, f, verb)
	case []byte:
		p.fmtBytes(f, verb, "[]byte")
	default:
		// If the type is not simple, it might have methods.
		if !p.handleMethods(arg, rvalue{}, verb) {
			p.printValue(f, verb, 0)
		}
	}
}

// rvalue stands in for reflect.Value in the signatures kept from real fmt:
// this fmt has no reflection, so there is never a valid value.
type rvalue struct{}

// printValue prints a non-basic value without reflection: the common slice
// and map types are handled by a type switch; anything else (structs,
// pointers, arrays, named composite types) prints as
// %!verb(unsupported type).
func (p *pp) printValue(arg any, verb rune, depth int) {
	switch f := arg.(type) {
	case [16]byte: // hashes (e.g. runtime/coverage file names)
		p.fmtBytes(f[:], verb, "[16]uint8")
	case [32]byte:
		p.fmtBytes(f[:], verb, "[32]uint8")
	case []string:
		printSlice(p, f, verb, depth)
	case []int:
		printSlice(p, f, verb, depth)
	case []int8:
		printSlice(p, f, verb, depth)
	case []int16:
		printSlice(p, f, verb, depth)
	case []int32:
		printSlice(p, f, verb, depth)
	case []int64:
		printSlice(p, f, verb, depth)
	case []uint:
		printSlice(p, f, verb, depth)
	case []uint16:
		printSlice(p, f, verb, depth)
	case []uint32:
		printSlice(p, f, verb, depth)
	case []uint64:
		printSlice(p, f, verb, depth)
	case []float32:
		printSlice(p, f, verb, depth)
	case []float64:
		printSlice(p, f, verb, depth)
	case []bool:
		printSlice(p, f, verb, depth)
	case []any:
		printSlice(p, f, verb, depth)
	case []error:
		printSlice(p, f, verb, depth)
	case [][]int:
		printSlice(p, f, verb, depth)
	case [][]string:
		printSlice(p, f, verb, depth)
	case map[string]int:
		printMap(p, f, verb, depth)
	case map[string]string:
		printMap(p, f, verb, depth)
	case map[string]bool:
		printMap(p, f, verb, depth)
	case map[string]any:
		printMap(p, f, verb, depth)
	case map[int]int:
		printMap(p, f, verb, depth)
	case map[int]string:
		printMap(p, f, verb, depth)
	case map[int]bool:
		printMap(p, f, verb, depth)
	default:
		p.buf.writeString(percentBangString)
		p.buf.writeRune(verb)
		p.buf.writeString("(unsupported type)")
	}
}

func printSlice[T any](p *pp, s []T, verb rune, depth int) {
	if p.fmt.sharpV {
		p.buf.writeString(typeString(s))
		if s == nil {
			p.buf.writeString(nilParenString)
			return
		}
		p.buf.writeByte('{')
		for i, e := range s {
			if i > 0 {
				p.buf.writeString(commaSpaceString)
			}
			p.printArg(any(e), verb)
		}
		p.buf.writeByte('}')
		return
	}
	p.buf.writeByte('[')
	for i, e := range s {
		if i > 0 {
			p.buf.writeByte(' ')
		}
		p.printArg(any(e), verb)
	}
	p.buf.writeByte(']')
}

func printMap[K cmp.Ordered, V any](p *pp, m map[K]V, verb rune, depth int) {
	keys := make([]K, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	if p.fmt.sharpV {
		p.buf.writeString(typeString(m))
		if m == nil {
			p.buf.writeString(nilParenString)
			return
		}
		p.buf.writeByte('{')
	} else {
		p.buf.writeString(mapString)
	}
	for i, k := range keys {
		if i > 0 {
			if p.fmt.sharpV {
				p.buf.writeString(commaSpaceString)
			} else {
				p.buf.writeByte(' ')
			}
		}
		p.printArg(any(k), verb)
		p.buf.writeByte(':')
		p.printArg(any(m[k]), verb)
	}
	if p.fmt.sharpV {
		p.buf.writeByte('}')
	} else {
		p.buf.writeByte(']')
	}
}

// typeString is %T without reflection: predeclared types and the composite
// types printValue knows; "?" for anything else.
func typeString(arg any) string {
	switch arg.(type) {
	case nil:
		return "<nil>"
	case bool:
		return "bool"
	case int:
		return "int"
	case int8:
		return "int8"
	case int16:
		return "int16"
	case int32:
		return "int32"
	case int64:
		return "int64"
	case uint:
		return "uint"
	case uint8:
		return "uint8"
	case uint16:
		return "uint16"
	case uint32:
		return "uint32"
	case uint64:
		return "uint64"
	case uintptr:
		return "uintptr"
	case float32:
		return "float32"
	case float64:
		return "float64"
	case string:
		return "string"
	case []byte:
		return "[]uint8"
	case [16]byte:
		return "[16]uint8"
	case [32]byte:
		return "[32]uint8"
	case []string:
		return "[]string"
	case []int:
		return "[]int"
	case []int8:
		return "[]int8"
	case []int16:
		return "[]int16"
	case []int32:
		return "[]int32"
	case []int64:
		return "[]int64"
	case []uint:
		return "[]uint"
	case []uint16:
		return "[]uint16"
	case []uint32:
		return "[]uint32"
	case []uint64:
		return "[]uint64"
	case []float32:
		return "[]float32"
	case []float64:
		return "[]float64"
	case []bool:
		return "[]bool"
	case []any:
		return "[]interface {}"
	case []error:
		return "[]error"
	case [][]int:
		return "[][]int"
	case [][]string:
		return "[][]string"
	case map[string]int:
		return "map[string]int"
	case map[string]string:
		return "map[string]string"
	case map[string]bool:
		return "map[string]bool"
	case map[string]any:
		return "map[string]interface {}"
	case map[int]int:
		return "map[int]int"
	case map[int]string:
		return "map[int]string"
	case map[int]bool:
		return "map[int]bool"
	}
	return "?"
}
// intFromArg gets the argNumth element of a. On return, isInt reports whether the argument has integer type.
func intFromArg(a []any, argNum int) (num int, isInt bool, newArgNum int) {
	newArgNum = argNum
	if argNum < len(a) {
		num, isInt = a[argNum].(int) // Almost always OK.
		if !isInt {
			// Work harder (a type switch instead of reflection: named
			// integer types are not recognised).
			var n int64
			var u uint64
			signedArg, unsignedArg := true, false
			switch v := a[argNum].(type) {
			case int8:
				n = int64(v)
			case int16:
				n = int64(v)
			case int32:
				n = int64(v)
			case int64:
				n = v
			case uint:
				u, unsignedArg = uint64(v), true
			case uint8:
				u, unsignedArg = uint64(v), true
			case uint16:
				u, unsignedArg = uint64(v), true
			case uint32:
				u, unsignedArg = uint64(v), true
			case uint64:
				u, unsignedArg = v, true
			case uintptr:
				u, unsignedArg = uint64(v), true
			default:
				signedArg = false
			}
			if unsignedArg {
				if int64(u) >= 0 && uint64(int(u)) == u {
					num = int(u)
					isInt = true
				}
			} else if signedArg {
				if int64(int(n)) == n {
					num = int(n)
					isInt = true
				}
			}
		}
		newArgNum = argNum + 1
		if tooLarge(num) {
			num = 0
			isInt = false
		}
	}
	return
}

// parseArgNumber returns the value of the bracketed number, minus 1
// (explicit argument numbers are one-indexed but we want zero-indexed).
// The opening bracket is known to be present at format[0].
// The returned values are the index, the number of bytes to consume
// up to the closing paren, if present, and whether the number parsed
// ok. The bytes to consume will be 1 if no closing paren is present.
func parseArgNumber(format string) (index int, wid int, ok bool) {
	// There must be at least 3 bytes: [n].
	if len(format) < 3 {
		return 0, 1, false
	}

	// Find closing bracket.
	for i := 1; i < len(format); i++ {
		if format[i] == ']' {
			width, ok, newi := parsenum(format, 1, i)
			if !ok || newi != i {
				return 0, i + 1, false
			}
			return width - 1, i + 1, true // arg numbers are one-indexed and skip paren.
		}
	}
	return 0, 1, false
}

// argNumber returns the next argument to evaluate, which is either the value of the passed-in
// argNum or the value of the bracketed integer that begins format[i:]. It also returns
// the new value of i, that is, the index of the next byte of the format to process.
func (p *pp) argNumber(argNum int, format string, i int, numArgs int) (newArgNum, newi int, found bool) {
	if len(format) <= i || format[i] != '[' {
		return argNum, i, false
	}
	p.reordered = true
	index, wid, ok := parseArgNumber(format[i:])
	if ok && 0 <= index && index < numArgs {
		return index, i + wid, true
	}
	p.goodArgNum = false
	return argNum, i + wid, ok
}

func (p *pp) badArgNum(verb rune) {
	p.buf.writeString(percentBangString)
	p.buf.writeRune(verb)
	p.buf.writeString(badIndexString)
}

func (p *pp) missingArg(verb rune) {
	p.buf.writeString(percentBangString)
	p.buf.writeRune(verb)
	p.buf.writeString(missingString)
}

func (p *pp) doPrintf(format string, a []any) {
	end := len(format)
	argNum := 0         // we process one argument per non-trivial format
	afterIndex := false // previous item in format was an index like [3].
	p.reordered = false
formatLoop:
	for i := 0; i < end; {
		p.goodArgNum = true
		lasti := i
		for i < end && format[i] != '%' {
			i++
		}
		if i > lasti {
			p.buf.writeString(format[lasti:i])
		}
		if i >= end {
			// done processing format string
			break
		}

		// Process one verb
		i++

		// Do we have flags?
		p.fmt.clearflags()
	simpleFormat:
		for ; i < end; i++ {
			c := format[i]
			switch c {
			case '#':
				p.fmt.sharp = true
			case '0':
				p.fmt.zero = true
			case '+':
				p.fmt.plus = true
			case '-':
				p.fmt.minus = true
			case ' ':
				p.fmt.space = true
			default:
				// Fast path for common case of ascii lower case simple verbs
				// without precision or width or argument indices.
				if 'a' <= c && c <= 'z' && argNum < len(a) {
					switch c {
					case 'w':
						p.wrappedErrs = append(p.wrappedErrs, argNum)
						fallthrough
					case 'v':
						// Go syntax
						p.fmt.sharpV = p.fmt.sharp
						p.fmt.sharp = false
						// Struct-field syntax
						p.fmt.plusV = p.fmt.plus
						p.fmt.plus = false
					}
					p.printArg(a[argNum], rune(c))
					argNum++
					i++
					continue formatLoop
				}
				// Format is more complex than simple flags and a verb or is malformed.
				break simpleFormat
			}
		}

		// Do we have an explicit argument index?
		argNum, i, afterIndex = p.argNumber(argNum, format, i, len(a))

		// Do we have width?
		if i < end && format[i] == '*' {
			i++
			p.fmt.wid, p.fmt.widPresent, argNum = intFromArg(a, argNum)

			if !p.fmt.widPresent {
				p.buf.writeString(badWidthString)
			}

			// We have a negative width, so take its value and ensure
			// that the minus flag is set
			if p.fmt.wid < 0 {
				p.fmt.wid = -p.fmt.wid
				p.fmt.minus = true
				p.fmt.zero = false // Do not pad with zeros to the right.
			}
			afterIndex = false
		} else {
			p.fmt.wid, p.fmt.widPresent, i = parsenum(format, i, end)
			if afterIndex && p.fmt.widPresent { // "%[3]2d"
				p.goodArgNum = false
			}
		}

		// Do we have precision?
		if i+1 < end && format[i] == '.' {
			i++
			if afterIndex { // "%[3].2d"
				p.goodArgNum = false
			}
			argNum, i, afterIndex = p.argNumber(argNum, format, i, len(a))
			if i < end && format[i] == '*' {
				i++
				p.fmt.prec, p.fmt.precPresent, argNum = intFromArg(a, argNum)
				// Negative precision arguments don't make sense
				if p.fmt.prec < 0 {
					p.fmt.prec = 0
					p.fmt.precPresent = false
				}
				if !p.fmt.precPresent {
					p.buf.writeString(badPrecString)
				}
				afterIndex = false
			} else {
				p.fmt.prec, p.fmt.precPresent, i = parsenum(format, i, end)
				if !p.fmt.precPresent {
					p.fmt.prec = 0
					p.fmt.precPresent = true
				}
			}
		}

		if !afterIndex {
			argNum, i, afterIndex = p.argNumber(argNum, format, i, len(a))
		}

		if i >= end {
			p.buf.writeString(noVerbString)
			break
		}

		verb, size := utf8.DecodeRuneInString(format[i:])
		i += size

		switch {
		case verb == '%': // Percent does not absorb operands and ignores f.wid and f.prec.
			p.buf.writeByte('%')
		case !p.goodArgNum:
			p.badArgNum(verb)
		case argNum >= len(a): // No argument left over to print for the current verb.
			p.missingArg(verb)
		case verb == 'w':
			p.wrappedErrs = append(p.wrappedErrs, argNum)
			fallthrough
		case verb == 'v':
			// Go syntax
			p.fmt.sharpV = p.fmt.sharp
			p.fmt.sharp = false
			// Struct-field syntax
			p.fmt.plusV = p.fmt.plus
			p.fmt.plus = false
			fallthrough
		default:
			p.printArg(a[argNum], verb)
			argNum++
		}
	}

	// Check for extra arguments unless the call accessed the arguments
	// out of order, in which case it's too expensive to detect if they've all
	// been used and arguably OK if they're not.
	if !p.reordered && argNum < len(a) {
		p.fmt.clearflags()
		p.buf.writeString(extraString)
		for i, arg := range a[argNum:] {
			if i > 0 {
				p.buf.writeString(commaSpaceString)
			}
			if arg == nil {
				p.buf.writeString(nilAngleString)
			} else {
				p.buf.writeString(typeString(arg))
				p.buf.writeByte('=')
				p.printArg(arg, 'v')
			}
		}
		p.buf.writeByte(')')
	}
}

func (p *pp) doPrint(a []any) {
	prevString := false
	for argNum, arg := range a {
		_, isString := arg.(string) // real fmt: any string kind (needs reflection)
		// Add a space between two non-string arguments.
		if argNum > 0 && !isString && !prevString {
			p.buf.writeByte(' ')
		}
		p.printArg(arg, 'v')
		prevString = isString
	}
}

// doPrintln is like doPrint but always adds a space between arguments
// and a newline after the last argument.
func (p *pp) doPrintln(a []any) {
	for argNum, arg := range a {
		if argNum > 0 {
			p.buf.writeByte(' ')
		}
		p.printArg(arg, 'v')
	}
	p.buf.writeByte('\n')
}
