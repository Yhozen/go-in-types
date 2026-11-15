// go-in-types overlay of math/floor_asm.go (Go 1.27.4): the pure-Go variant is
// used (haveArch* = false); the assembly declarations stay for the .s files.
//
// Copyright 2021 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

//go:build 386 || amd64 || arm64 || loong64 || ppc64 || ppc64le || riscv64 || s390x || wasm

package math

const haveArchFloor = false

func archFloor(x float64) float64

const haveArchCeil = false

func archCeil(x float64) float64

const haveArchTrunc = false

func archTrunc(x float64) float64
