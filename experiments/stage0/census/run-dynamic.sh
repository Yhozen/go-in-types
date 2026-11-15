#!/bin/sh
# Runs a coverage-instrumented tsgo (built with `go build -cover -coverpkg=all`)
# on the one-liner and on the oracle corpus, in both lib modes, and writes
# merged coverage profiles to $COV/<set>.txt.
#   usage: run-dynamic.sh <tsgo-cover-binary> <ts-in-lua-in-types checkout> <cov dir>
set -u
BIN=$1; ORACLE_REPO=$2; COV=$3
MINI=$ORACLE_REPO/lua/lib.mini.d.ts
ES5=$ORACLE_REPO/vendor/tslua/src/tslua/bundled/libs/lib.es5.d.ts
INPUTS=$ORACLE_REPO/oracle/inputs
EXPECTED=$ORACLE_REPO/oracle/expected
WORK=$(mktemp -d /tmp/census-dyn.XXXXXX)
mkdir -p "$COV"
run() { # set mode input expected-file
  set_=$1; mode=$2; input=$3; exp=$4
  d=$WORK/p; rm -rf "$d"; mkdir -p "$d" "$COV/raw/$set_"
  if [ "$mode" = mini ]; then cp "$MINI" "$d/lib.mini.d.ts"; lib=lib.mini.d.ts; else cp "$ES5" "$d/lib.es5.d.ts"; lib=lib.es5.d.ts; fi
  cp "$input" "$d/main.ts"
  out=$(cd "$d" && GOCOVERDIR="$COV/raw/$set_" perl -e 'alarm 120; exec @ARGV' "$BIN" --noLib --noEmit --skipLibCheck --singleThreaded $lib main.ts 2>&1)
  if [ -n "$exp" ] && [ -f "$exp" ]; then
    if [ "$out" = "$(cat "$exp")" ]; then echo "match $set_ $mode $input"; else echo "DIFF $set_ $mode $input"; fi
  fi
}
printf "const x: number = 'hello';\n" > $WORK/oneliner.ts
run oneliner-mini mini $WORK/oneliner.ts ""
run oneliner-es5 es5 $WORK/oneliner.ts ""
find "$INPUTS" -name '*.ts' | sort | while read -r f; do
  rel=${f#$INPUTS/}; rel=${rel%.ts}
  run corpus-mini mini "$f" "$EXPECTED/$rel.mini.txt"
  run corpus-es5 es5 "$f" "$EXPECTED/$rel.es5.txt"
done
for s in oneliner-mini oneliner-es5 corpus-mini corpus-es5; do
  go tool covdata textfmt -i "$COV/raw/$s" -o "$COV/$s.txt"
done
go tool covdata textfmt -i "$COV/raw/oneliner-mini,$COV/raw/oneliner-es5" -o "$COV/oneliner.txt"
go tool covdata textfmt -i "$COV/raw/oneliner-mini,$COV/raw/oneliner-es5,$COV/raw/corpus-mini,$COV/raw/corpus-es5" -o "$COV/all.txt"
rm -rf "$WORK"
