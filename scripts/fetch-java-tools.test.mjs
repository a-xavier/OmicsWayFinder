import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fetchJavaTools } from "./fetch-java-tools.mjs";

test("rejects a release with a mismatched checksum before writing it", async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), "java-tools-test-"));
  try {
    await assert.rejects(fetchJavaTools(out, async () => new Response("wrong release")), /Checksum mismatch/);
    assert.deepEqual(await readdir(out), []);
  } finally {
    await rm(out, { recursive: true });
  }
});

test("reports download failures", async () => {
  await assert.rejects(fetchJavaTools(os.tmpdir(), async () => new Response("", { status: 404 })), /HTTP 404/);
});
