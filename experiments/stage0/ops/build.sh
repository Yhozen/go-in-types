#!/bin/sh
# Builds the opsharness natively and for wasip1, and tsgo (cmd/tsgo) for
# wasip1, into $OUT (default /tmp/goops). Usage: ./build.sh <typescript-go dir>
set -eu
TSGO=${1:?usage: build.sh <typescript-go dir>}
OUT=${OUT:-/tmp/goops}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
{
	printf '{"Replace":{'
	sep=
	for f in "$HERE"/harness/*.go; do
		printf '%s"%s/cmd/opsharness/%s":"%s"' "$sep" "$TSGO" "$(basename "$f")" "$f"
		sep=,
	done
	printf '}}\n'
} > "$OUT/overlay.json"
cd "$TSGO"
go build -overlay "$OUT/overlay.json" -o "$OUT/opsharness" ./cmd/opsharness
GOOS=wasip1 GOARCH=wasm go build -overlay "$OUT/overlay.json" -o "$OUT/opsharness.wasm" ./cmd/opsharness
GOOS=wasip1 GOARCH=wasm go build -o "$OUT/tsgo.wasm" ./cmd/tsgo
go build -o "$OUT/tsgo" ./cmd/tsgo
cd "$HERE" && go build -o "$OUT/count" ./count
ls -la "$OUT"/opsharness "$OUT"/opsharness.wasm "$OUT"/tsgo.wasm "$OUT"/tsgo "$OUT"/count
