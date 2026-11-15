// go-in-types overlay of errors/wrap.go (Go 1.27.4): no internal/reflectlite.
// As only fills *error targets or uses As methods; Is and AsType are exact.
//
// Copyright 2018 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package errors


// Unwrap returns the result of calling the Unwrap method on err, if err's
// type contains an Unwrap method returning error.
// Otherwise, Unwrap returns nil.
//
// Unwrap only calls a method of the form "Unwrap() error".
// In particular Unwrap does not unwrap errors returned by [Join].
func Unwrap(err error) error {
	u, ok := err.(interface {
		Unwrap() error
	})
	if !ok {
		return nil
	}
	return u.Unwrap()
}

// Is reports whether any error in err's tree matches target.
// The target must be comparable.
//
// The tree consists of err itself, followed by the errors obtained by repeatedly
// calling its Unwrap() error or Unwrap() []error method. When err wraps multiple
// errors, Is examines err followed by a depth-first traversal of its children.
//
// An error is considered to match a target if it is equal to that target or if
// it implements a method Is(error) bool such that Is(target) returns true.
//
// An error type might provide an Is method so it can be treated as equivalent
// to an existing error. For example, if MyError defines
//
//	func (m MyError) Is(target error) bool { return target == fs.ErrExist }
//
// then Is(MyError{}, fs.ErrExist) returns true. See [syscall.Errno.Is] for
// an example in the standard library. An Is method should only shallowly
// compare err and the target and not call [Unwrap] on either.
func Is(err, target error) bool {
	if err == nil || target == nil {
		return err == target
	}

	isComparable := comparable(target)
	return is(err, target, isComparable)
}

func is(err, target error, targetComparable bool) bool {
	for {
		if targetComparable && err == target {
			return true
		}
		if x, ok := err.(interface{ Is(error) bool }); ok && x.Is(target) {
			return true
		}
		switch x := err.(type) {
		case interface{ Unwrap() error }:
			err = x.Unwrap()
			if err == nil {
				return false
			}
		case interface{ Unwrap() []error }:
			for _, err := range x.Unwrap() {
				if is(err, target, targetComparable) {
					return true
				}
			}
			return false
		default:
			return false
		}
	}
}

// As finds the first error in err's tree that matches target, and if one is found, sets
// target to that error value and returns true. Otherwise, it returns false.
//
// For most uses, prefer [AsType]. As is equivalent to [AsType] but sets its target
// argument rather than returning the matching error and doesn't require its target
// argument to implement error.
//
// The tree consists of err itself, followed by the errors obtained by repeatedly
// calling its Unwrap() error or Unwrap() []error method. When err wraps multiple
// errors, As examines err followed by a depth-first traversal of its children.
//
// An error matches target if the error's concrete value is assignable to the value
// pointed to by target, or if the error has a method As(any) bool such that
// As(target) returns true. In the latter case, the As method is responsible for
// setting target.
//
// An error type might provide an As method so it can be treated as if it were a
// different error type.
//
// As panics if target is not a non-nil pointer to either a type that implements
// error, or to any interface type.
func As(err error, target any) bool {
	if err == nil {
		return false
	}
	if target == nil {
		panic("errors: target cannot be nil")
	}
	return as(err, target)
}

// as without reflection: a target of type *error takes the first error in
// the chain; any other target is only filled by an As method. (Real errors
// also assigns to *T for every T the error is assignable to; that needs
// reflection. Use AsType instead.)
func as(err error, target any) bool {
	for {
		if p, ok := target.(*error); ok {
			if p == nil {
				panic("errors: target must be a non-nil pointer")
			}
			*p = err
			return true
		}
		if x, ok := err.(interface{ As(any) bool }); ok && x.As(target) {
			return true
		}
		switch x := err.(type) {
		case interface{ Unwrap() error }:
			err = x.Unwrap()
			if err == nil {
				return false
			}
		case interface{ Unwrap() []error }:
			for _, err := range x.Unwrap() {
				if err == nil {
					continue
				}
				if as(err, target) {
					return true
				}
			}
			return false
		default:
			return false
		}
	}
}

// comparable reports whether == on target's dynamic type can be evaluated
// (real errors asks reflectlite; here an uncomparable type panics and the
// panic is recovered).
func comparable(target error) (ok bool) {
	defer func() {
		if recover() != nil {
			ok = false
		}
	}()
	return eqErr(target, target) || true
}

func eqErr(a, b error) bool { return a == b }

// AsType finds the first error in err's tree that matches the type E, and
// if one is found, returns that error value and true. Otherwise, it
// returns the zero value of E and false.
//
// The tree consists of err itself, followed by the errors obtained by
// repeatedly calling its Unwrap() error or Unwrap() []error method. When
// err wraps multiple errors, AsType examines err followed by a
// depth-first traversal of its children.
//
// An error err matches the type E if the type assertion err.(E) holds,
// or if the error has a method As(any) bool such that err.As(target)
// returns true when target is a non-nil *E. In the latter case, the As
// method is responsible for setting target.
func AsType[E error](err error) (E, bool) {
	if err == nil {
		var zero E
		return zero, false
	}
	var pe *E // lazily initialized
	return asType(err, &pe)
}

func asType[E error](err error, ppe **E) (_ E, _ bool) {
	for {
		if e, ok := err.(E); ok {
			return e, true
		}
		if x, ok := err.(interface{ As(any) bool }); ok {
			if *ppe == nil {
				*ppe = new(E)
			}
			if x.As(*ppe) {
				return **ppe, true
			}
		}
		switch x := err.(type) {
		case interface{ Unwrap() error }:
			err = x.Unwrap()
			if err == nil {
				return
			}
		case interface{ Unwrap() []error }:
			for _, err := range x.Unwrap() {
				if err == nil {
					continue
				}
				if x, ok := asType(err, ppe); ok {
					return x, true
				}
			}
			return
		default:
			return
		}
	}
}
