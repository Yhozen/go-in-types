// go-in-types overlay of internal/json/json.go (typescript-go v7.0.2): the
// tokenizer types (jsontext) stay; Marshal*/Unmarshal* panic. They are the
// only use of github.com/go-json-experiment/json (encoding/json/v2), whose
// package initializers call reflect.TypeFor; no check of the oracle reaches
// them (node scripts/tsgo-parity.ts stays exact with this overlay).
//
//nolint:depguard
package json

import (
	"io"

	"github.com/go-json-experiment/json/jsontext"
)

// Options is json.Options (= jsonopts.Options, as jsontext.Options).
type Options = jsontext.Options

func unavailable(name string) error {
	panic("go-in-types: internal/json." + name + " is not available (overlay/tsgo/internal/json)")
}

func Marshal(in any, opts ...Options) (out []byte, err error) {
	return nil, unavailable("Marshal")
}

func MarshalEncode(out *jsontext.Encoder, in any, opts ...Options) (err error) {
	return unavailable("MarshalEncode")
}

func MarshalWrite(out io.Writer, in any, opts ...Options) (err error) {
	return unavailable("MarshalWrite")
}

func MarshalIndent(in any, prefix, indent string) (out []byte, err error) {
	return nil, unavailable("MarshalIndent")
}

func MarshalIndentWrite(out io.Writer, in any, prefix, indent string) (err error) {
	return unavailable("MarshalIndentWrite")
}

func Unmarshal(in []byte, out any, opts ...Options) (err error) {
	return unavailable("Unmarshal")
}

func UnmarshalDecode(in *jsontext.Decoder, out any, opts ...Options) (err error) {
	return unavailable("UnmarshalDecode")
}

func UnmarshalRead(in io.Reader, out any, opts ...Options) (err error) {
	return unavailable("UnmarshalRead")
}

func AllowDuplicateNames(allow bool) Options {
	return jsontext.AllowDuplicateNames(allow)
}

func Deterministic(v bool) Options {
	panic("go-in-types: internal/json.Deterministic is not available (overlay/tsgo/internal/json)")
}

func WithIndent(indent string) Options {
	return jsontext.WithIndent(indent)
}

func NewDecoder(r io.Reader) *jsontext.Decoder {
	return jsontext.NewDecoder(r)
}

// UnmarshalerFrom and MarshalerTo are json.UnmarshalerFrom/MarshalerTo.
type (
	UnmarshalerFrom interface {
		UnmarshalJSONFrom(*jsontext.Decoder) error
	}
	MarshalerTo interface {
		MarshalJSONTo(*jsontext.Encoder) error
	}
)

type (
	Value   = jsontext.Value
	Kind    = jsontext.Kind
	Decoder = jsontext.Decoder
	Encoder = jsontext.Encoder
)

var (
	BeginObject = jsontext.BeginObject
	EndObject   = jsontext.EndObject
	Null        = jsontext.Null
	BeginArray  = jsontext.BeginArray
	EndArray    = jsontext.EndArray
)
