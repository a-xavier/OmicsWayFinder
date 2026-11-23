// Run locally to refresh the vendored BioWasm and Java tools.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const [script, args] of [
  ["../../scripts/fetch-biowasm-tools.mjs", ["--overwrite"]],
  ["../../scripts/build-gatk.mjs", []],
  ["../../scripts/fetch-java-tools.mjs", []],
  ["../../scripts/build-fastqc.mjs", []],
]) {
  console.log(`\nRunning ${script} ${args.join(" ")}`.trimEnd());
  execFileSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...args], { stdio: "inherit" });
}
