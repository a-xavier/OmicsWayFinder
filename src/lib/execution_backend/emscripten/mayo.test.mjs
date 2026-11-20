import assert from "node:assert/strict";
import test from "node:test";
import { Mayo } from "./mayo.ts";

function directory(name, children) {
  return {
    name,
    kind: "directory",
    async *values() {
      yield* children;
    },
  };
}

test("builds and refreshes a recursive tree without reading file contents", async () => {
  const files = [{ name: "output.bam", kind: "file" }];
  const root = directory("project", [
    { name: "reads.fastq", kind: "file" },
    directory("results", files),
    directory("empty", []),
  ]);
  const mayo = new Mayo();

  assert.deepEqual(await mayo.init(root), {
    name: "project",
    kind: "directory",
    children: [
      { name: "reads.fastq", kind: "file" },
      {
        name: "results",
        kind: "directory",
        children: [{ name: "output.bam", kind: "file" }],
      },
      { name: "empty", kind: "directory", children: [] },
    ],
  });

  files.push({ name: "output.bai", kind: "file" });
  assert.equal(mayo.getTree().children[1].children.length, 1);
  const refreshed = await mayo.refreshTree();
  assert.equal(refreshed.children[1].children.length, 2);
  assert.equal(mayo.getTree(), refreshed);
});

test("keeps the previous tree when a nested enumeration fails", async () => {
  let fail = false;
  const nested = {
    name: "nested",
    kind: "directory",
    async *values() {
      if (fail) throw new Error("permission denied");
      yield { name: "file", kind: "file" };
    },
  };
  const mayo = new Mayo();
  const tree = await mayo.init(directory("project", [nested]));
  fail = true;

  await assert.rejects(mayo.refreshTree(), /permission denied/);
  await assert.rejects(mayo.init(directory("other", [nested])), /permission denied/);
  assert.equal(mayo.getTree(), tree);
  fail = false;
  assert.deepEqual(await mayo.refreshTree(), tree);
});

test("requires initialization and rejects placeholder operations", async () => {
  const mayo = new Mayo();
  assert.throws(() => mayo.getTree(), /initialized/);
  await assert.rejects(mayo.refreshTree(), /initialized/);
  await assert.rejects(mayo.readFile("file"), /not implemented/);
  await assert.rejects(mayo.writeFile("file", new Uint8Array()), /not implemented/);
  await assert.rejects(mayo.removeFile("file"), /not implemented/);
});
