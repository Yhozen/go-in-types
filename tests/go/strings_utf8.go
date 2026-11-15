package main

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

func main() {
	s := "héllo, 世界! \xff\xfe end"
	fmt.Println(len(s), utf8.RuneCountInString(s))
	for i, r := range s {
		fmt.Print(i, ":", r, " ")
	}
	fmt.Println()
	rs := []rune(s)
	fmt.Println(len(rs), string(rs[1]), string(rs[7:9]))
	b := []byte("abc")
	b[0] = 'X'
	fmt.Println(string(b), s[1], s[1:3], s[:0] == "")
	fmt.Println(string(rune(0x4e16)), string(rune(-1)), strings.Repeat("ab", 3))
	fmt.Println(strings.Index(s, "世"), strings.Contains(s, "llo"), strings.Split("a,b,,c", ","), strings.Fields("  x y\tz "))
	fmt.Println(strings.ToUpper(s[:6]), strings.TrimSpace("  t  "), strings.HasPrefix(s, "hé"), strings.Replace("aaaa", "a", "b", 2))
	fmt.Println("abc" < "abd", "ab" < "abc", "b" > "abc", "x"+"y" == "xy")
	var sb strings.Builder
	for i := 0; i < 5; i++ {
		fmt.Fprintf(&sb, "%d-", i)
	}
	sb.WriteByte('!')
	sb.WriteRune('é')
	fmt.Println(sb.String(), sb.Len())
	fmt.Printf("%q %x % x %X %s|%10s|%-6s|%.2s\n", "a\tb\x00é", "hi", "hi", []byte("hi"), []byte("bytes"), "r", "l", "trunc")
	fmt.Printf("%c %c %U %q\n", 65, 0x1F600, 0x1F600, 'x')
	fmt.Println(utf8.ValidString(s), utf8.RuneLen('世'), strings.EqualFold("Go", "GO"))
}
