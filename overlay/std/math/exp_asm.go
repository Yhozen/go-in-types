// go-in-types overlay of math/exp_asm.go (Go 1.27.4): the pure-Go variant is
// used (haveArch* = false); the assembly declarations stay for the .s files.
//
// Copyright 2021 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

//go:build amd64 || arm64 || loong64 || riscv64 || s390x

package math

const haveArchExp = false

func archExp(x float64) float64
