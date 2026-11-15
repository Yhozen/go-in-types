package main

import "gointypes/rt"

func main() {
	rt.Write(1, []byte("to stdout\n"))
	rt.Write(2, []byte("to stderr\n"))
	rt.Write(1, []byte("no newline"))
	rt.Exit(3)
}
