// go-in-types overlay of math/exp2_asm.go (Go 1.27.4): the pure-Go variant is
// used (haveArch* = false); the assembly declarations stay for the .s files.
//
// Copyright 2021 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

//go:build arm64 || loong64 || riscv64

package math

const haveArchExp2 = false

func archExp2(x float64) float64
