// The tests/go/*.out format (see tests/go/README.md), shared by
// scripts/gen-go-out.ts (native runs) and scripts/gate-ref.ts (engine runs).
//
//   <stdout, verbatim>
//   --- stderr ---            only if stderr is non-empty after normalising
//   <stderr up to the goroutine trace>
//   --- exit N ---
//
// If stdout (or the kept stderr) does not end in a newline, the line
// "--- no newline ---" follows it. Bytes are latin1 (one char per byte), so
// the files hold Go's raw output bytes.

/** Go's stderr without the goroutine traceback that follows a panic or fatal error. */
export function normaliseStderr(stderr: string): string {
  // The "[signal SIGSEGV: ... pc=0x...]" line after a nil dereference holds
  // addresses; it is dropped.
  const lines = stderr.split("\n").filter((l) => !l.startsWith("[signal "));
  const at = lines.findIndex((l) => /^goroutine \d+ \[/.test(l));
  if (at < 0) return lines.join("\n");
  let kept = lines.slice(0, at);
  while (kept.length > 0 && kept[kept.length - 1] === "") kept = kept.slice(0, -1);
  return kept.length === 0 ? "" : kept.join("\n") + "\n";
}

function block(s: string): string {
  if (s === "") return "";
  return s.endsWith("\n") ? s : s + "\n--- no newline ---\n";
}

export function formatOut(stdout: string, stderr: string, exit: number): string {
  const err = normaliseStderr(stderr);
  return (
    block(stdout) + (err === "" ? "" : "--- stderr ---\n" + block(err)) + `--- exit ${exit} ---\n`
  );
}

/** First differing line of two .out texts, for failure reports. */
export function firstDiff(want: string, got: string): string {
  const a = want.split("\n");
  const b = got.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i])
      return `line ${i + 1}: want ${JSON.stringify(a[i] ?? "<eof>")} got ${JSON.stringify(b[i] ?? "<eof>")}`;
  }
  return "identical";
}
