import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { downloadTools } from "./fetch-biowasm-tools.mjs";

const config = {
  tools: [{ name: "example", versions: [{ version: "1" }], programs: ["example"], files: ["js"] }],
};

test("overwrite refreshes existing files; ordinary fetch preserves them", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "biowasm-test-"));
  try {
    const dir = path.join(out, "example", "1");
    const target = path.join(dir, "example.js");
    await mkdir(dir, { recursive: true });
    await writeFile(target, "old");
    let calls = 0;
    const fetchFile = async () => {
      calls++;
      return new Response("new");
    };

    await downloadTools(config, out, { fetchFile });
    assert.equal(await readFile(target, "utf8"), "old");
    assert.equal(calls, 0);
    await downloadTools(config, out, { overwrite: true, fetchFile });
    assert.equal(await readFile(target, "utf8"), "new");
    assert.equal(calls, 1);
    assert.equal(JSON.parse(await readFile(path.join(out, "manifest.json"), "utf8"))[0].version, "1");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test("failed downloads do not overwrite existing files or publish a new manifest", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "biowasm-test-"));
  try {
    const dir = path.join(out, "example", "1");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "example.js"), "old");
    const manifest = '[{"tool":"example","version":"old"}]\n';
    await writeFile(path.join(out, "manifest.json"), manifest);
    await assert.rejects(
      downloadTools(config, out, { overwrite: true, fetchFile: async () => new Response("", { status: 503 }) }),
      /HTTP 503/,
    );
    assert.equal(await readFile(path.join(dir, "example.js"), "utf8"), "old");
    assert.equal(await readFile(path.join(out, "manifest.json"), "utf8"), manifest);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
