// Shows that reflection does not run inside check in the tsgo config:
// builds the harness with overlay/tsgo.json and coverage of reflect,
// internal/reflectlite and their heavy users (counters cleared when check
// starts, cmd/tsgo/cover_hook.go), runs the oracle inputs x {mini, es5} and
// lists every function of those packages that ran during a check.
//   node scripts/tsgo-reflect.ts [--oracle DIR]
// Static reachability from check is reported by the census tool:
//   census -dir <tsgo> -overlay overlay/tsgo.json -tags purego \
//     -from github.com/microsoft/typescript-go/cmd/tsgo.check
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tsgoDir } from "../overlay/gen.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const oi = argv.indexOf("--oracle");
const oracle = oi >= 0 ? argv[oi + 1]! : resolve(repo, "../../ts-in-lua-in-types");
// (Overlaid packages cannot be covered: go build -cover reads their original files.)
const pkgs = [
  "reflect",
  "internal/reflectlite",
  "encoding/json/v2",
  "encoding/binary",
  "regexp",
  "regexp/syntax",
];
// Positive control: must show functions that ran (proves the counters work).
const control = "github.com/microsoft/typescript-go/internal/scanner";
const libs: Record<string, string> = {
  mini: join(oracle, "lua/lib.mini.d.ts"),
  es5: join(
    repo,
    "node_modules/.pnpm/@typescript+typescript-darwin-arm64@7.0.2/node_modules/@typescript/typescript-darwin-arm64/lib/lib.es5.d.ts",
  ),
};

execFileSync("node", [join(repo, "overlay/gen.ts")]);
const work = join(tmpdir(), "tsgo-reflect");
rmSync(work, { recursive: true, force: true });
const cov = join(work, "cov");
const before = join(work, "before");
mkdirSync(cov, { recursive: true });
mkdirSync(before, { recursive: true });
const bin = join(work, "tsgo-cover");
// `go build -cover` mishandles an overlaid main package (no coverage at all),
// so the typescript-go side of the tsgo overlay is applied to a copy of the
// source (as the stage 0 census did); std overlays stay in -overlay.
const srcCopy = join(work, "src");
mkdirSync(srcCopy, { recursive: true });
const tsgo = tsgoDir();
execFileSync("rsync", ["-a", "--exclude", "*_test.go", "--exclude", "testdata", "go.mod", "go.sum", "cmd", "internal", srcCopy + "/"], { cwd: tsgo });
const ov: { Replace: Record<string, string> } = JSON.parse(readFileSync(join(repo, "overlay/tsgo.json"), "utf8"));
const stdOnly: Record<string, string> = {};
for (const [dst, from] of Object.entries(ov.Replace)) {
  if (dst.startsWith(tsgo + "/")) copyFileSync(from, join(srcCopy, dst.slice(tsgo.length + 1)));
  else stdOnly[dst] = from;
}
writeFileSync(join(work, "std.json"), JSON.stringify({ Replace: stdOnly }));
execFileSync(
  "go",
  [
    "build",
    "-tags",
    "purego,gointypes_cover",
    "-cover",
    "-covermode=atomic",
    // The main package must be covered too, or runtime/coverage reports mode <invalid>.
    `-coverpkg=${[...pkgs, control, "github.com/microsoft/typescript-go/cmd/tsgo"].join(",")}`,
    "-overlay",
    join(work, "std.json"),
    "-o",
    bin,
    "./cmd/tsgo",
  ],
  { cwd: srcCopy, stdio: "inherit", env: { ...process.env, CGO_ENABLED: "0" } },
);
const base = join(oracle, "oracle/inputs");
const inputs: string[] = [];
const walk = (d: string) => {
  for (const n of readdirSync(d).sort()) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith(".ts")) inputs.push(relative(base, p));
  }
};
walk(base);
let runs = 0;
for (const f of inputs) {
  for (const [mode, lib] of Object.entries(libs)) {
    const d = join(work, "p");
    rmSync(d, { recursive: true, force: true });
    mkdirSync(d, { recursive: true });
    copyFileSync(lib, join(d, `lib.${mode}.d.ts`));
    copyFileSync(join(base, f), join(d, "main.ts"));
    try {
      execFileSync(
        bin,
        [
          "--noLib",
          "--noEmit",
          "--skipLibCheck",
          "--singleThreaded",
          `lib.${mode}.d.ts`,
          "main.ts",
        ],
        {
          cwd: d,
          env: { ...process.env, GOCOVERDIR: cov, GOINTYPES_COVER_BEFORE: before },
          stdio: "ignore",
        },
      );
    } catch {}
    runs++;
  }
}
// after (exit) minus before (check start), per coverage block, summed over
// all runs (count mode): what ran inside check. (covdata subtract is a set
// difference, which would hide code that ran both at init and in check.)
function counts(dir: string): Map<string, number> {
  const txt = join(work, `${dir === cov ? "after" : "before"}.txt`);
  execFileSync("go", ["tool", "covdata", "textfmt", "-i", dir, "-o", txt]);
  const m = new Map<string, number>();
  for (const l of readFileSync(txt, "utf8").split("\n").slice(1)) {
    const k = l.lastIndexOf(" ");
    if (k < 0) continue;
    m.set(l.slice(0, k), (m.get(l.slice(0, k)) ?? 0) + Number(l.slice(k + 1)));
  }
  return m;
}
const after = counts(cov);
const pre = counts(before);
const byPkg: Record<string, Set<string>> = {};
for (const [block, n] of after) {
  if (n - (pre.get(block) ?? 0) <= 0) continue;
  const file = block.slice(0, block.indexOf(":"));
  const dir = file.slice(0, file.lastIndexOf("/"));
  const pkg = [...pkgs, control].find((p) => dir === p || dir.endsWith("/" + p) && p.includes("/")) ?? dir;
  (byPkg[pkg] ??= new Set()).add(block.slice(0, block.indexOf(",")));
}
console.log(`${runs} checks; coverage blocks of ${pkgs.join(", ")} that ran inside check:`);
for (const p of pkgs) console.log(`  ${p}: ${byPkg[p]?.size ?? 0}`);
console.log(`  (control) ${control}: ${byPkg[control]?.size ?? 0}`);
for (const [p, bs] of Object.entries(byPkg)) if (p !== control) for (const b of [...bs].slice(0, 20)) console.log(`    ${p}: ${b}`);
