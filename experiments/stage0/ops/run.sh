#!/bin/sh
# Reproduces docs/stage0/OPS.md: builds everything (build.sh), counts SSA
# instructions under the interpreter and wasm fuel under wasmtime, and
# writes the reports to $DATA (default ../../../docs/stage0/ops).
# Usage: ./run.sh <typescript-go dir> <dir with lib.mini.d.ts and lib.es5.d.ts>
set -eu
TSGO=${1:?usage: run.sh <typescript-go dir> <lib dir>}
LIB=${2:?usage: run.sh <typescript-go dir> <lib dir>}
OUT=${OUT:-/tmp/goops}
HERE=$(cd "$(dirname "$0")" && pwd)
DATA=${DATA:-$HERE/../../../docs/stage0/ops}
PY=${PY:-$OUT/wasmenv/bin/python}
mkdir -p "$DATA"
OUT=$OUT "$HERE/build.sh" "$TSGO"
if [ ! -x "$PY" ]; then
	uv venv -q "$OUT/wasmenv" --python 3.12
	VIRTUAL_ENV=$OUT/wasmenv uv pip install -q wasmtime==50.0.1
fi
cd "$HERE"
# Hand-checked validation program (README.md).
OPS_DUMP=main,sq "$OUT/count" -tsgo "$TSGO" -pkg ./cmd/opsvalidate -main validate/main.go -top 5 \
	-o "$DATA/validate.txt" 2> "$DATA/validate.ssa.txt"
for mode in cli phased; do
	for lib in mini es5; do
		"$OUT/count" -tsgo "$TSGO" -lib "$LIB" -mode $mode -libname $lib -top 30 -o "$DATA/ssa-$mode-$lib.txt" 2> /dev/null
		"$PY" wasm/run.py "$OUT/opsharness.wasm" "$LIB" $mode $lib > "$DATA/wasm-harness-$mode-$lib.txt"
	done
done
# Map iteration order is random (as in Go): repeat the phased runs.
for lib in mini es5; do
	: > "$DATA/ssa-phased-$lib-repeats.txt"
	for i in 1 2 3 4 5 6 7 8 9 10; do
		"$OUT/count" -tsgo "$TSGO" -lib "$LIB" -mode phased -libname $lib -top 0 -o "$OUT/rep.txt" 2> /dev/null
		sed -n '/^phases:/,/TOTAL/p' "$OUT/rep.txt" | tr -s ' ' | tr '\n' ' ' >> "$DATA/ssa-phased-$lib-repeats.txt"
		echo >> "$DATA/ssa-phased-$lib-repeats.txt"
	done
done
# The real cmd/tsgo for wasip1, run in the lib directory (cwd = /p).
printf "const x: number = 'hello';\n" > "$LIB/main.ts"
for lib in mini es5; do
	"$PY" wasm/run.py "$OUT/tsgo.wasm" "$LIB" --noLib --noEmit --skipLibCheck --singleThreaded lib.$lib.d.ts main.ts > "$DATA/wasm-tsgo-$lib.txt"
done
"$PY" wasm/run.py "$OUT/tsgo.wasm" "$LIB" --version > "$DATA/wasm-tsgo-version.txt"
echo "reports in $DATA"
