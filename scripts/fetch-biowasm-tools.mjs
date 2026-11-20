// Download the latest version of every biowasm tool into public/tools/<tool>/<version>/
// and write public/tools/manifest.json for the Mayo test bench.
//
//   node scripts/fetch-biowasm-tools.mjs            # all tools
//   node scripts/fetch-biowasm-tools.mjs samtools   # only these tools
//
// Files already downloaded are kept. The tool list comes from biowasm.json, which
// biowasm uses to build https://biowasm.com/cdn/v3.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_URL = "https://raw.githubusercontent.com/biowasm/biowasm/main/biowasm.json";
const CDN = "https://biowasm.com/cdn/v3";
const OUT = path.resolve(import.meta.dirname, "../public/tools");
// Not command-line tools: Aioli itself and Aioli's internal base module.
const SKIP = new Set(["aioli", "base"]);
const PARALLEL = 6;

const only = new Set(process.argv.slice(2));
const config = await (await fetch(CONFIG_URL)).json();
const tools = config.tools.filter(tool => !SKIP.has(tool.name) && (only.size === 0 || only.has(tool.name)));

const manifestPath = path.join(OUT, "manifest.json");
const manifest = new Map(
  (await readFile(manifestPath, "utf8").then(JSON.parse).catch(() => [])).map(entry => [entry.tool, entry]),
);

const jobs = [];
for (const tool of tools) {
  // biowasm.json lists versions oldest first.
  const { version } = tool.versions[tool.versions.length - 1];
  const exts = tool.files ?? ["js", "wasm"];
  manifest.set(tool.name, {
    tool: tool.name,
    version,
    programs: tool.programs,
    description: tool.description ?? "",
  });
  for (const program of tool.programs) {
    for (const ext of exts) jobs.push({ tool: tool.name, version, file: `${program}.${ext}` });
  }
}

let next = 0;
let bytes = 0;
const failures = [];
async function worker() {
  while (next < jobs.length) {
    const { tool, version, file } = jobs[next++];
    const target = path.join(OUT, tool, version, file);
    if (await stat(target).catch(() => undefined)) continue;
    const url = `${CDN}/${tool}/${version}/${file}`;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = new Uint8Array(await response.arrayBuffer());
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data);
      bytes += data.byteLength;
      console.log(`${(data.byteLength / 1e6).toFixed(1).padStart(7)} MB  ${tool}/${version}/${file}`);
    } catch (error) {
      failures.push(`${url}: ${error.message}`);
    }
  }
}
await Promise.all(Array.from({ length: PARALLEL }, worker));

const entries = [...manifest.values()].sort((a, b) => a.tool.localeCompare(b.tool, "en", { sensitivity: "base" }));
await writeFile(manifestPath, `${JSON.stringify(entries, null, 2)}\n`);
console.log(`Downloaded ${(bytes / 1e6).toFixed(1)} MB. Manifest: ${entries.length} tools.`);
if (failures.length) {
  console.error(`Failed:\n${failures.join("\n")}`);
  process.exitCode = 1;
}
