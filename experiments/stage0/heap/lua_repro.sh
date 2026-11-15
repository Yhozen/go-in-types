#!/bin/sh
# Cost 3 in the lua-in-types runtime: a forced bind (`Store<..> extends infer h`) of a heap
# whose young part holds FILL copies of boot-image tables. Prints instantiations per op.
#   sh lua_repro.sh [TSRS]      (default: stock tsrs from node_modules)
set -e
here=$(cd "$(dirname "$0")" && pwd)
T=${1:-$here/../../../node_modules/.bin/tsrs}
w=$here/../../../.run/lua; mkdir -p "$w"
R() { TSRS_FAST=1 "$T" --ignoreConfig --fast --singleThreaded --extendedDiagnostics --noEmit --types "" --lib es2023 --skipLibCheck "$1" 2>&1 | awk '/^Instantiations/ {print $2}'; }
for V in "" iface; do for val in load new; do for fill in 0 1500; do for k in store storef; do
  V=$V python3 -I "$here/lua_repro.py" $fill 0 "$w/a.ts" $k $val
  V=$V python3 -I "$here/lua_repro.py" $fill 100 "$w/b.ts" $k $val
  a=$(R "$w/a.ts"); b=$(R "$w/b.ts")
  echo "shapes=${V:-literal} young=$val fill=$fill op=$k inst/op=$(( (b - a) / 100 ))"
done; done; done; done
