#!/bin/sh
# Reproduces the numbers in docs/stage0/CENSUS.md (~3 minutes).
#   usage: census.sh <typescript-go dir> <ts-in-lua-in-types checkout>
# Writes out/*.summary.json, out/*.report.md and
# out/harness-all.functions.json.gz. Scratch (binaries, coverage, a copy of
# the typescript-go source for the harness build) goes to $SCRATCH.
set -eu
TSGO=$1
ORACLE=$2
HERE=$(cd "$(dirname "$0")" && pwd)
OV=$HERE/overlay
SCRATCH=${SCRATCH:-/tmp/census}
OUT=$HERE/out
mkdir -p "$SCRATCH" "$OUT"

# Overlays (go build -overlay): cli = compile path through internal/execute
# without --lsp/--api; harness = in-memory FS harness, no internal/execute.
E=$OV/empty_main.go.txt
STUBS="\"$TSGO/cmd/tsgo/lsp.go\":\"$E\",\"$TSGO/cmd/tsgo/api.go\":\"$E\",\"$TSGO/cmd/tsgo/isprocessalive_unix.go\":\"$E\",\"$TSGO/cmd/tsgo/isprocessalive_other.go\":\"$E\""
cat > "$SCRATCH/cli.json" <<JSON
{"Replace":{"$TSGO/cmd/tsgo/main.go":"$OV/compileonly_main.go.txt","$TSGO/internal/execute/census_compileonly.go":"$OV/compileonly_execute.go.txt",$STUBS}}
JSON
cat > "$SCRATCH/harness.json" <<JSON
{"Replace":{"$TSGO/cmd/tsgo/main.go":"$OV/harness_main.go.txt","$TSGO/cmd/tsgo/sys.go":"$E",$STUBS}}
JSON

(cd "$HERE" && go build -o "$SCRATCH/census" .)

# Coverage builds. `go build -cover` ignores -overlay for some files, so the
# harness is built from a copy of the source with the overlay applied.
(cd "$TSGO" && go build -cover -coverpkg=all -o "$SCRATCH/tsgo-cover" ./cmd/tsgo)
rm -rf "$SCRATCH/src"
mkdir -p "$SCRATCH/src"
(cd "$TSGO" && rsync -a --exclude '*_test.go' --exclude testdata go.mod go.sum cmd internal "$SCRATCH/src/")
cp "$OV/harness_main.go.txt" "$SCRATCH/src/cmd/tsgo/main.go"
for f in sys.go lsp.go api.go isprocessalive_unix.go isprocessalive_other.go isprocessalive_windows.go; do
	rm -f "$SCRATCH/src/cmd/tsgo/$f"
done
(cd "$SCRATCH/src" && go build -cover -coverpkg=all -o "$SCRATCH/tsgo-harness-cover" ./cmd/tsgo)

for b in tsgo harness; do
	bin=$SCRATCH/tsgo-cover
	[ $b = harness ] && bin=$SCRATCH/tsgo-harness-cover
	rm -rf "$SCRATCH/cov-$b"
	"$HERE/run-dynamic.sh" "$bin" "$ORACLE" "$SCRATCH/cov-$b" > "$SCRATCH/dynamic-$b.log"
	echo "$b: $(grep -c '^match' "$SCRATCH/dynamic-$b.log") outputs match the oracle"
	grep '^DIFF' "$SCRATCH/dynamic-$b.log" || true
done

C="$SCRATCH/census -dir $TSGO -out $OUT"
H="$SCRATCH/cov-harness"
# Unmodified cmd/tsgo (main + init roots; LSP and API included).
$C -name full-all -cover "$SCRATCH/cov-tsgo/all.txt"
# internal/execute compile path, LSP/API files stubbed.
$C -name cli-all -overlay "$SCRATCH/cli.json" -cover "$SCRATCH/cov-tsgo/all.txt"
# The harness: the configuration the engine will run.
$C -name harness-all -overlay "$SCRATCH/harness.json" -cover "$H/all.txt" -functions
for s in oneliner-mini oneliner-es5 corpus-mini corpus-es5; do
	$C -name "harness-$s" -overlay "$SCRATCH/harness.json" -cover "$H/$s.txt"
done
# Static only, for the wasip1/wasm build configuration.
$C -name harness-wasip1 -overlay "$SCRATCH/harness.json" -goos wasip1 -goarch wasm -tags purego
gzip -f -9 "$OUT/harness-all.functions.json"
