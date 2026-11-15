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
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
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
mkdirSync(cov, { recursive: true });
const bin = join(work, "tsgo-cover");
execFileSync(
  "go",
  [
    "build",
    "-tags",
    "purego,gointypes_cover",
    "-cover",
    "-covermode=atomic",
    `-coverpkg=${[...pkgs, control].join(",")}`,
    "-overlay",
    join(repo, "overlay/tsgo.json"),
    "-o",
    bin,
    "./cmd/tsgo",
  ],
  { cwd: tsgoDir(), stdio: "inherit", env: { ...process.env, CGO_ENABLED: "0" } },
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
          env: { ...process.env, GOCOVERDIR: cov },
          stdio: "ignore",
        },
      );
    } catch {}
    runs++;
  }
}
const funcs = execFileSync("go", ["tool", "covdata", "func", "-i", cov], { encoding: "utf8" })
  .split("\n")
  .filter((l) => /\s\d+\.\d+%$/.test(l) && !/\s0\.0%$/.test(l) && !l.startsWith("total"));
const byPkg: Record<string, string[]> = {};
for (const l of funcs) {
  const [file, , fn] = l.split(/\s+/);
  const pkg =
    [...pkgs, control].find(
      (p) => file!.startsWith(p + "/") && !file!.slice(p.length + 1).includes("/"),
    ) ?? file!;
  (byPkg[pkg] ??= []).push(`${file} ${fn}`);
}
console.log(`${runs} checks; functions of ${pkgs.join(", ")} that ran inside check:`);
for (const p of pkgs) console.log(`  ${p}: ${(byPkg[p] ?? []).length}`);
console.log(`  (control) ${control}: ${(byPkg[control] ?? []).length}`);
for (const [p, fs] of Object.entries(byPkg))
  if (p !== control) for (const f of fs) console.log(`    ${p}: ${f}`);
