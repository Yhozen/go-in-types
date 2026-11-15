#!/bin/sh
# Run a heavy command (a tsrs benchmark or gate) while holding one of two
# machine-wide slots, so at most two heavy jobs run at once across every
# agent and worktree. Usage: scripts/heavy.sh <command> [args...]
# Slots are lock directories under ~/.cache/go-in-types-heavy; a slot whose
# owner process is gone is reclaimed.
dir="${HOME}/.cache/go-in-types-heavy"
mkdir -p "$dir"
while :; do
  for slot in 1 2; do
    if mkdir "$dir/slot$slot" 2>/dev/null; then
      echo $$ >"$dir/slot$slot/pid"
      trap 'rm -rf "$dir/slot$slot"' EXIT INT TERM
      "$@"
      exit $?
    fi
    pid=$(cat "$dir/slot$slot/pid" 2>/dev/null)
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
      rm -rf "$dir/slot$slot"
    fi
  done
  sleep 2
done
