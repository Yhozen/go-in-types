// go-in-types overlay of internal/core/core.go (typescript-go v7.0.2):
// ApplyDebugStackLimit removed (it was the only use of os and runtime/debug);
// levenshteinWithMax on float bit patterns with memoised arithmetic (fewer
// soft-float calls on the engine, identical results).
package core

import (
	"iter"
	"maps"
	"math"
	"slices"
	"sort"
	"strings"
	"sync"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/microsoft/typescript-go/internal/debug"
	"github.com/microsoft/typescript-go/internal/json"
	"github.com/microsoft/typescript-go/internal/stringutil"
	"github.com/microsoft/typescript-go/internal/tspath"
)

// ApplyDebugStackLimit: moved to the harness's native main
// (overlay/tsgo/cmd/tsgo/main_os.go), so core does not import os.

func Filter[T any](slice []T, f func(T) bool) []T {
	for i, value := range slice {
		if !f(value) {
			result := slices.Clone(slice[:i])
			for i++; i < len(slice); i++ {
				value = slice[i]
				if f(value) {
					result = append(result, value)
				}
			}
			return result
		}
	}
	return slice
}

func FilterSeq[T any](slice []T, f func(T) bool) iter.Seq[T] {
	return func(yield func(T) bool) {
		for _, value := range slice {
			if f(value) {
				if !yield(value) {
					return
				}
			}
		}
	}
}

func FilterIndex[T any](slice []T, f func(T, int, []T) bool) []T {
	for i, value := range slice {
		if !f(value, i, slice) {
			result := slices.Clone(slice[:i])
			for i++; i < len(slice); i++ {
				value = slice[i]
				if f(value, i, slice) {
					result = append(result, value)
				}
			}
			return result
		}
	}
	return slice
}

func Map[T, U any](slice []T, f func(T) U) []U {
	if slice == nil {
		return nil
	}
	result := make([]U, len(slice))
	for i, value := range slice {
		result[i] = f(value)
	}
	return result
}

func TryMap[T, U any](slice []T, f func(T) (U, error)) ([]U, error) {
	if len(slice) == 0 {
		return nil, nil
	}
	result := make([]U, len(slice))
	for i, value := range slice {
		mapped, err := f(value)
		if err != nil {
			return nil, err
		}
		result[i] = mapped
	}
	return result, nil
}

func MapIndex[T, U any](slice []T, f func(T, int) U) []U {
	if slice == nil {
		return nil
	}
	result := make([]U, len(slice))
	for i, value := range slice {
		result[i] = f(value, i)
	}
	return result
}

func MapNonNil[T any, U comparable](slice []T, f func(T) U) []U {
	var result []U
	for _, value := range slice {
		mapped := f(value)
		if mapped != *new(U) {
			result = append(result, mapped)
		}
	}
	return result
}

func MapFiltered[T any, U any](slice []T, f func(T) (U, bool)) []U {
	var result []U
	for _, value := range slice {
		mapped, ok := f(value)
		if !ok {
			continue
		}
		result = append(result, mapped)
	}
	return result
}

func FlatMap[T any, U any](slice []T, f func(T) []U) []U {
	var result []U
	for _, value := range slice {
		mapped := f(value)
		if len(mapped) != 0 {
			result = append(result, mapped...)
		}
	}
	return result
}

func SameMap[T comparable](slice []T, f func(T) T) []T {
	for i, value := range slice {
		mapped := f(value)
		if mapped != value {
			result := make([]T, len(slice))
			copy(result, slice[:i])
			result[i] = mapped
			for j := i + 1; j < len(slice); j++ {
				result[j] = f(slice[j])
			}
			return result
		}
	}
	return slice
}

func SameMapIndex[T comparable](slice []T, f func(T, int) T) []T {
	for i, value := range slice {
		mapped := f(value, i)
		if mapped != value {
			result := make([]T, len(slice))
			copy(result, slice[:i])
			result[i] = mapped
			for j := i + 1; j < len(slice); j++ {
				result[j] = f(slice[j], j)
			}
			return result
		}
	}
	return slice
}

func Same[T any](s1 []T, s2 []T) bool {
	if len(s1) == len(s2) {
		return len(s1) == 0 || &s1[0] == &s2[0]
	}
	return false
}

func Some[T any](slice []T, f func(T) bool) bool {
	for _, value := range slice { //nolint:modernize
		if f(value) {
			return true
		}
	}
	return false
}

func Every[T any](slice []T, f func(T) bool) bool {
	for _, value := range slice {
		if !f(value) {
			return false
		}
	}
	return true
}

func Or[T any](funcs ...func(T) bool) func(T) bool {
	return func(input T) bool {
		for _, f := range funcs {
			if f(input) {
				return true
			}
		}
		return false
	}
}

func Find[T any](slice []T, f func(T) bool) T {
	for _, value := range slice {
		if f(value) {
			return value
		}
	}
	return *new(T)
}

func FindLast[T any](slice []T, f func(T) bool) T {
	for i := len(slice) - 1; i >= 0; i-- {
		value := slice[i]
		if f(value) {
			return value
		}
	}
	return *new(T)
}

func FindIndex[T any](slice []T, f func(T) bool) int {
	for i, value := range slice {
		if f(value) {
			return i
		}
	}
	return -1
}

func FindLastIndex[T any](slice []T, f func(T) bool) int {
	for i := len(slice) - 1; i >= 0; i-- {
		value := slice[i]
		if f(value) {
			return i
		}
	}
	return -1
}

func FirstOrNil[T any](slice []T) T {
	if len(slice) != 0 {
		return slice[0]
	}
	return *new(T)
}

func LastOrNil[T any](slice []T) T {
	if len(slice) != 0 {
		return slice[len(slice)-1]
	}
	return *new(T)
}

func ElementOrNil[T any](slice []T, index int) T {
	if index < len(slice) {
		return slice[index]
	}
	return *new(T)
}

func FirstOrNilSeq[T any](seq iter.Seq[T]) T {
	if seq != nil {
		for value := range seq {
			return value
		}
	}
	return *new(T)
}

func FirstNonNil[T any, U comparable](slice []T, f func(T) U) U {
	for _, value := range slice {
		mapped := f(value)
		if mapped != *new(U) {
			return mapped
		}
	}
	return *new(U)
}

func FirstNonZero[T comparable](values ...T) T {
	var zero T
	for _, value := range values {
		if value != zero {
			return value
		}
	}
	return zero
}

func Concatenate[T any](s1 []T, s2 []T) []T {
	if len(s2) == 0 {
		return s1
	}
	if len(s1) == 0 {
		return s2
	}
	return slices.Concat(s1, s2)
}

func Splice[T any](s1 []T, start int, deleteCount int, items ...T) []T {
	if start < 0 {
		start = len(s1) + start
	}
	if start < 0 {
		start = 0
	}
	if start > len(s1) {
		start = len(s1)
	}
	if deleteCount < 0 {
		deleteCount = 0
	}
	end := min(start+max(deleteCount, 0), len(s1))
	if start == end && len(items) == 0 {
		return s1
	}
	return slices.Concat(s1[:start], items, s1[end:])
}

func CountWhere[T any](slice []T, f func(T) bool) int {
	count := 0
	for _, value := range slice {
		if f(value) {
			count++
		}
	}
	return count
}

func ReplaceElement[T any](slice []T, i int, t T) []T {
	result := slices.Clone(slice)
	result[i] = t
	return result
}

func InsertSorted[T any](slice []T, element T, cmp func(T, T) int) []T {
	i, _ := slices.BinarySearchFunc(slice, element, cmp)
	return slices.Insert(slice, i, element)
}

// MinAllFunc returns all minimum elements from xs according to the comparison function cmp.
func MinAllFunc[T any](xs []T, cmp func(a, b T) int) []T {
	if len(xs) == 0 {
		return nil
	}

	m := xs[0]
	mins := []T{m}

	for _, x := range xs[1:] {
		c := cmp(x, m)
		switch {
		case c < 0:
			m = x
			mins = mins[:0]
			mins = append(mins, x)
		case c == 0:
			mins = append(mins, x)
		}
	}

	return mins
}

func AppendIfUnique[T comparable](slice []T, element T) []T {
	if slices.Contains(slice, element) {
		return slice
	}
	return append(slice, element)
}

func Memoize[T any](create func() T) func() T {
	var value T
	return func() T {
		if create != nil {
			value = create()
			create = nil
		}
		return value
	}
}

// Returns whenTrue if b is true; otherwise, returns whenFalse. IfElse should only be used when branches are either
// constant or precomputed as both branches will be evaluated regardless as to the value of b.
func IfElse[T any](b bool, whenTrue T, whenFalse T) T {
	if b {
		return whenTrue
	}
	return whenFalse
}

// Returns value if value is not the zero value of T; Otherwise, returns defaultValue. OrElse should only be used when
// defaultValue is constant or precomputed as its argument will be evaluated regardless as to the content of value.
func OrElse[T comparable](value T, defaultValue T) T {
	if value != *new(T) {
		return value
	}
	return defaultValue
}

// Returns `a` if `a` is not `nil`; Otherwise, returns `b`. Coalesce is roughly analogous to `??` in JS, except that it
// non-shortcutting, so it is advised to only use a constant or precomputed value for `b`
func Coalesce[T *U, U any](a T, b T) T {
	if a == nil {
		return b
	} else {
		return a
	}
}

type ECMALineStarts []TextPos

func ComputeECMALineStarts(text string) ECMALineStarts {
	result := make([]TextPos, 0, strings.Count(text, "\n")+1)
	return slices.AppendSeq(result, ComputeECMALineStartsSeq(text))
}

func ComputeECMALineStartsSeq(text string) iter.Seq[TextPos] {
	return func(yield func(TextPos) bool) {
		textLen := TextPos(len(text))
		var pos TextPos
		var lineStart TextPos
		for pos < textLen {
			b := text[pos]
			if b < utf8.RuneSelf {
				pos++
				switch b {
				case '\r':
					if pos < textLen && text[pos] == '\n' {
						pos++
					}
					fallthrough
				case '\n':
					if !yield(lineStart) {
						return
					}
					lineStart = pos
				}
			} else {
				ch, size := utf8.DecodeRuneInString(text[pos:])
				pos += TextPos(size)
				if stringutil.IsLineBreak(ch) {
					if !yield(lineStart) {
						return
					}
					lineStart = pos
				}
			}
		}
		yield(lineStart)
	}
}

// PositionToLineAndByteOffset returns the 0-based line and byte offset from the
// start of that line for the given byte position, using the provided line starts.
// The byte offset is a raw UTF-8 byte offset from the line start, not a UTF-16 code unit count.
func PositionToLineAndByteOffset(position int, lineStarts []TextPos) (line int, byteOffset int) {
	line = max(sort.Search(len(lineStarts), func(i int) bool {
		return int(lineStarts[i]) > position
	})-1, 0)
	return line, position - int(lineStarts[line])
}

// UTF16Offset represents a character offset measured in UTF-16 code units.
type UTF16Offset int

// UTF16Len returns the number of UTF-16 code units needed to
// represent the given UTF-8 encoded string.
func UTF16Len(s string) UTF16Offset {
	// Fast path: scan for non-ASCII bytes. For ASCII-only strings,
	// each byte is one UTF-16 code unit, so we can return len(s) directly.
	for i := range len(s) {
		if s[i] >= utf8.RuneSelf {
			// Found non-ASCII; count the ASCII prefix, then decode the rest.
			n := UTF16Offset(i)
			for _, r := range s[i:] {
				n += UTF16Offset(utf16.RuneLen(r))
			}
			return n
		}
	}
	return UTF16Offset(len(s))
}

func Flatten[T any](array [][]T) []T {
	var result []T
	for _, subArray := range array {
		result = append(result, subArray...)
	}
	return result
}

func Must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

// Extracts the first value of a multi-value return.
func FirstResult[T1 any](t1 T1, _ ...any) T1 {
	return t1
}

func StringifyJson(input any, prefix string, indent string) (string, error) {
	output, err := json.MarshalIndent(input, prefix, indent)
	return string(output), err
}

func GetScriptKindFromFileName(fileName string) ScriptKind {
	dotPos := strings.LastIndex(fileName, ".")
	if dotPos >= 0 {
		switch strings.ToLower(fileName[dotPos:]) {
		case tspath.ExtensionJs, tspath.ExtensionCjs, tspath.ExtensionMjs:
			return ScriptKindJS
		case tspath.ExtensionJsx:
			return ScriptKindJSX
		case tspath.ExtensionTs, tspath.ExtensionCts, tspath.ExtensionMts:
			return ScriptKindTS
		case tspath.ExtensionTsx:
			return ScriptKindTSX
		case tspath.ExtensionJson:
			return ScriptKindJSON
		}
	}
	return ScriptKindUnknown
}

// Given a name and a list of names that are *not* equal to the name, return a spelling suggestion if there is one that is close enough.
// Names less than length 3 only check for case-insensitive equality.
//
// find the candidate with the smallest Levenshtein distance,
//
//	except for candidates:
//	  * With no name
//	  * Whose length differs from the target name by more than 0.34 of the length of the name.
//	  * Whose levenshtein distance is more than 0.4 of the length of the name
//	    (0.4 allows 1 substitution/transposition for every 5 characters,
//	     and 1 insertion/deletion at 3 characters)
//
// @internal
func GetSpellingSuggestion[T any](name string, candidates iter.Seq[T], getName func(T) string, compare func(T, T) int) T {
	runeName := []rune(name)
	maximumLengthDifference := max(2, int(float64(len(runeName))*0.34))
	bestDistance := math.Floor(float64(len(runeName))*0.4) + 0.9 // If the best result is worse than this, don't bother.
	buffers := levenshteinBuffersPool.Get().(*levenshteinBuffers)
	defer levenshteinBuffersPool.Put(buffers)
	var bestCandidate T
	hasBest := false
	for candidate := range candidates {
		candidateName := getName(candidate)
		maxLen := max(len(candidateName), len(runeName))
		minLen := min(len(candidateName), len(runeName))
		if candidateName != "" && maxLen-minLen <= maximumLengthDifference {
			if candidateName == name {
				continue
			}
			// Only consider candidates less than 3 characters long when they differ by case.
			// Otherwise, don't bother, since a user would usually notice differences of a 2-character name.
			if len(candidateName) < 3 && !strings.EqualFold(candidateName, name) {
				continue
			}
			distance := levenshteinWithMax(buffers, runeName, []rune(candidateName), bestDistance)
			if distance < 0 {
				continue
			}
			debug.Assert(distance <= bestDistance) // Else `levenshteinWithMax` should return undefined
			if distance < bestDistance {
				bestDistance = distance
				bestCandidate = candidate
				hasBest = true
			} else if !hasBest || compare(candidate, bestCandidate) < 0 {
				bestCandidate = candidate
				hasBest = true
			}
		}
	}
	return bestCandidate
}

func GetSpellingSuggestionForStrings(name string, candidates iter.Seq[string]) string {
	return GetSpellingSuggestion(name, candidates, Identity, strings.Compare)
}

// go-in-types overlay: levenshteinWithMax without soft float in the inner
// loop. The distances are float64 sums of 0.1, 1 and 2 (exact float
// results matter: the comparisons with maxValue and the best distance see
// their rounding), so the code below computes exactly the same float64
// values, but as their bit patterns: every value is a non-negative finite
// float other than -0 (sums of non-negative numbers starting from +0 and
// maxValue > 0), and for those the bit patterns as uint64 order exactly as
// the floats do, so math.Min and the comparisons become integer ones. The
// three additions, the int conversions and the per-row Ceil/Floor bounds
// are memoised: each result is computed once with real float arithmetic
// (soft float on the engine) and then looked up, so values stay bit for bit
// those of the original.
type levenshteinBuffers struct {
	previous []uint64
	current  []uint64
}

var levenshteinBuffersPool = sync.Pool{
	New: func() any {
		return &levenshteinBuffers{}
	},
}

// Addends of levAdd.
const (
	levAddTenth = iota // + 0.1
	levAddOne          // + 1
	levAddTwo          // + 2
	levAddBig          // + 0.01
)

type levAddKey struct {
	v uint64
	c uint8
}

var levAddMemo map[levAddKey]uint64

// levAdd is Float64bits(Float64frombits(v) + addend c), memoised.
func levAdd(v uint64, c uint8) uint64 {
	k := levAddKey{v, c}
	if r, ok := levAddMemo[k]; ok {
		return r
	}
	if levAddMemo == nil {
		levAddMemo = map[levAddKey]uint64{}
	}
	var d float64
	switch c {
	case levAddTenth:
		d = 0.1
	case levAddOne:
		d = 1
	case levAddTwo:
		d = 2
	default:
		d = 0.01
	}
	r := math.Float64bits(math.Float64frombits(v) + d)
	levAddMemo[k] = r
	return r
}

var levIntMemo []uint64

// levInt is Float64bits(float64(i)) for i >= 0, memoised.
func levInt(i int) uint64 {
	for len(levIntMemo) <= i {
		levIntMemo = append(levIntMemo, math.Float64bits(float64(len(levIntMemo))))
	}
	return levIntMemo[i]
}

type levBoundsKey struct {
	i int
	m uint64
}

var levBoundsMemo map[levBoundsKey][2]int

// levBounds is int(math.Ceil(float64(i)-maxValue)) and
// int(math.Floor(maxValue+float64(i))) for maxValue's bits m, memoised.
func levBounds(i int, m uint64) (int, int) {
	k := levBoundsKey{i, m}
	if r, ok := levBoundsMemo[k]; ok {
		return r[0], r[1]
	}
	if levBoundsMemo == nil {
		levBoundsMemo = map[levBoundsKey][2]int{}
	}
	maxValue := math.Float64frombits(m)
	r := [2]int{int(math.Ceil(float64(i) - maxValue)), int(math.Floor(maxValue + float64(i)))}
	levBoundsMemo[k] = r
	return r[0], r[1]
}

func levenshteinWithMax(buffers *levenshteinBuffers, s1 []rune, s2 []rune, maxValue float64) float64 {
	bufferSize := len(s2) + 1
	buffers.previous = slices.Grow(buffers.previous[:0], bufferSize)[:bufferSize]
	buffers.current = slices.Grow(buffers.current[:0], bufferSize)[:bufferSize]

	previous := buffers.previous
	current := buffers.current

	maxBits := math.Float64bits(maxValue)
	big := levAdd(maxBits, levAddBig)
	for i := range previous {
		previous[i] = levInt(i)
	}
	for i := 1; i <= len(s1); i++ {
		c1 := s1[i-1]
		lower1 := unicode.ToLower(c1)
		lo, hi := levBounds(i, maxBits)
		minJ := max(lo, 1)
		maxJ := min(hi, len(s2))
		colMin := levInt(i)
		current[0] = colMin
		for j := 1; j < minJ; j++ {
			current[j] = big
		}
		for j := minJ; j <= maxJ; j++ {
			var dist uint64
			c2 := s2[j-1]
			if c1 == c2 {
				dist = previous[j-1]
			} else {
				var substitutionDistance uint64
				if lower1 == unicode.ToLower(c2) {
					substitutionDistance = levAdd(previous[j-1], levAddTenth)
				} else {
					substitutionDistance = levAdd(previous[j-1], levAddTwo)
				}
				dist = min(levAdd(previous[j], levAddOne), min(levAdd(current[j-1], levAddOne), substitutionDistance))
			}
			current[j] = dist
			colMin = min(colMin, dist)
		}
		for j := maxJ + 1; j <= len(s2); j++ {
			current[j] = big
		}
		if colMin > maxBits {
			// Give up -- everything in this column is > max and it can't get better in future columns.
			return -1
		}
		previous, current = current, previous
	}
	res := previous[len(s2)]
	if res > maxBits {
		return -1
	}
	return math.Float64frombits(res)
}

func Identity[T any](t T) T {
	return t
}

func CheckEachDefined[S any](s []*S, msg string) []*S {
	for _, value := range s {
		if value == nil {
			panic(msg)
		}
	}
	return s
}

func IndexAfter(s string, pattern string, startIndex int) int {
	matched := strings.Index(s[startIndex:], pattern)
	if matched == -1 {
		return -1
	} else {
		return matched + startIndex
	}
}

func ShouldRewriteModuleSpecifier(specifier string, compilerOptions *CompilerOptions) bool {
	return compilerOptions.RewriteRelativeImportExtensions.IsTrue() && tspath.PathIsRelative(specifier) && !tspath.IsDeclarationFileName(specifier) && tspath.HasTSFileExtension(specifier)
}

func SingleElementSlice[T any](element *T) []*T {
	if element == nil {
		return nil
	}
	return []*T{element}
}

func ConcatenateSeq[T any](seqs ...iter.Seq[T]) iter.Seq[T] {
	return func(yield func(T) bool) {
		for _, seq := range seqs {
			if seq == nil {
				continue
			}
			for e := range seq {
				if !yield(e) {
					return
				}
			}
		}
	}
}

// Enumerate returns a sequence of (index, value) pairs from the input sequence.
func Enumerate[T any](seq iter.Seq[T]) iter.Seq2[int, T] {
	return func(yield func(int, T) bool) {
		i := 0
		for v := range seq {
			if !yield(i, v) {
				return
			}
			i++
		}
	}
}

func comparableValuesEqual[T comparable](a, b T) bool {
	return a == b
}

// DiffMaps compares two maps m1 and m2 and calls the provided callbacks for added, removed, and changed entries.
// onAdded is called for each key-value pair that is in m2 but not in m1.
// onRemoved is called for each key-value pair that is in m1 but not in m2.
// onChanged is called for each key where the value in m1 differs from the value in m2.
func DiffMaps[K comparable, V comparable](m1 map[K]V, m2 map[K]V, onAdded func(K, V), onRemoved func(K, V), onChanged func(K, V, V)) {
	DiffMapsFunc(m1, m2, comparableValuesEqual, onAdded, onRemoved, onChanged)
}

// DiffMapsFunc compares two maps m1 and m2 and calls the provided callbacks for added, removed, and changed entries.
// onAdded is called for each key-value pair that is in m2 but not in m1.
// onRemoved is called for each key-value pair that is in m1 but not in m2.
// onChanged is called for each key where the value in m1 differs from the value in m2.
func DiffMapsFunc[K comparable, V1 any, V2 any](m1 map[K]V1, m2 map[K]V2, equalValues func(V1, V2) bool, onAdded func(K, V2), onRemoved func(K, V1), onChanged func(K, V1, V2)) {
	if onAdded != nil {
		for k, v2 := range m2 {
			if _, ok := m1[k]; !ok {
				onAdded(k, v2)
			}
		}
	}
	if onChanged == nil && onRemoved == nil {
		return
	}
	for k, v1 := range m1 {
		if v2, ok := m2[k]; ok {
			if onChanged != nil && !equalValues(v1, v2) {
				onChanged(k, v1, v2)
			}
		} else {
			onRemoved(k, v1)
		}
	}
}

// CopyMapInto is maps.Copy, unless dst is nil, in which case it clones and returns src.
// Use CopyMapInto anywhere you would use maps.Copy preceded by a nil check and map initialization.
func CopyMapInto[M1 ~map[K]V, M2 ~map[K]V, K comparable, V any](dst M1, src M2) map[K]V {
	if dst == nil {
		return maps.Clone(src)
	}
	maps.Copy(dst, src)
	return dst
}

// UnorderedEqual returns true if s1 and s2 contain the same elements, regardless of order.
func UnorderedEqual[T comparable](s1 []T, s2 []T) bool {
	if len(s1) != len(s2) {
		return false
	}
	counts := make(map[T]int)
	for _, v := range s1 {
		counts[v]++
	}
	for _, v := range s2 {
		counts[v]--
		if counts[v] < 0 {
			return false
		}
	}
	return true
}

func Deduplicate[T comparable](slice []T) []T {
	if len(slice) > 1 {
		for i, value := range slice {
			if slices.Contains(slice[:i], value) {
				result := slices.Clone(slice[:i])
				for i++; i < len(slice); i++ {
					value = slice[i]
					if !slices.Contains(result, value) {
						result = append(result, value)
					}
				}
				return result
			}
		}
	}
	return slice
}

func DeduplicateSorted[T any](slice []T, isEqual func(a, b T) bool) []T {
	if len(slice) == 0 {
		return slice
	}
	last := slice[0]
	deduplicated := slice[:1]
	for i := 1; i < len(slice); i++ {
		next := slice[i]
		if isEqual(last, next) {
			continue
		}

		deduplicated = append(deduplicated, next)
		last = next
	}

	return deduplicated
}

// CompareBooleans treats true as greater than false.
func CompareBooleans(a, b bool) int {
	if a && !b {
		return 1
	} else if !a && b {
		return -1
	}
	return 0
}
