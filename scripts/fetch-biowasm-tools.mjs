// Download the latest version of every biowasm tool into public/tools/<tool>/<version>/
// and write public/tools/manifest.json for the Mayo test bench.
//
//   node scripts/fetch-biowasm-tools.mjs            # all tools
//   node scripts/fetch-biowasm-tools.mjs samtools   # only these tools
//   node scripts/fetch-biowasm-tools.mjs --overwrite # download existing files again
//
// Files already downloaded are kept unless --overwrite is passed. The tool list
// comes from biowasm.json, which biowasm uses to build https://biowasm.com/cdn/v3.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_URL = "https://raw.githubusercontent.com/biowasm/biowasm/main/biowasm.json";
const CDN = "https://biowasm.com/cdn/v3";
const OUT = path.resolve(import.meta.dirname, "../public/tools");
// Not command-line tools: Aioli itself and Aioli's internal base module.
const SKIP = new Set(["aioli", "base"]);
const PARALLEL = 6;

export async function downloadTools(config, out, { only = new Set(), overwrite = false, fetchFile = fetch } = {}) {
  const tools = config.tools.filter(tool => !SKIP.has(tool.name) && (only.size === 0 || only.has(tool.name)));
  const missing = [...only].filter(name => !tools.some(tool => tool.name === name));
  if (missing.length) throw new Error(`Unknown BioWasm tools: ${missing.join(", ")}`);

  const manifestPath = path.join(out, "manifest.json");
  let existing;
  try {
    existing = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    existing = [];
  }
  const manifest = new Map(existing.map(entry => [entry.tool, entry]));
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
      const target = path.join(out, tool, version, file);
      if (!overwrite) {
        try {
          await stat(target);
          continue;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      const url = `${CDN}/${tool}/${version}/${file}`;
      try {
        const response = await fetchFile(url);
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
  if (failures.length) throw new Error(`Downloads failed:\n${failures.join("\n")}`);

  const entries = [...manifest.values()].sort((a, b) => a.tool.localeCompare(b.tool, "en", { sensitivity: "base" }));
  await mkdir(out, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(entries, null, 2)}\n`);
  console.log(`Downloaded ${(bytes / 1e6).toFixed(1)} MB. Manifest: ${entries.length} tools.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const overwrite = args.includes("--overwrite");
  const only = new Set(args.filter(arg => arg !== "--overwrite"));
  const response = await fetch(CONFIG_URL);
  if (!response.ok) throw new Error(`Failed to fetch BioWasm configuration: HTTP ${response.status}`);
  await downloadTools(await response.json(), OUT, { only, overwrite });
}
