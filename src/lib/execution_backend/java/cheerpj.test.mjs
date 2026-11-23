import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

test("module reloads share initialization, callbacks and the run queue", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true }, logLevel: "silent" });
  let initCalls = 0;
  let active = 0;
  let natives;
  globalThis.cheerpjInit = async options => {
    initCalls++;
    natives = options.natives;
  };
  globalThis.cheerpjRunMain = async (_launcher, _classpath, _main, message) => {
    assert.equal(++active, 1, "runs from different modules must not overlap");
    const inputs = await natives.Java_omics_cheerp_Folder_inputs();
    assert.equal(inputs, `${message}.txt`);
    await new Promise(resolve => setTimeout(resolve, 5));
    const data = new TextEncoder().encode(message);
    await natives.Java_omics_cheerp_Stdio_write(null, 1, data, data.length);
    await natives.Java_omics_cheerp_Launcher_exit(null, 0);
    active--;
    return 0;
  };

  try {
    const first = await server.ssrLoadModule("/src/lib/execution_backend/java/cheerpj.ts?instance=1");
    const second = await server.ssrLoadModule("/src/lib/execution_backend/java/cheerpj.ts?instance=2");
    assert.notEqual(first.initCheerpJ, second.initCheerpJ);
    await Promise.all([first.initCheerpJ(), second.initCheerpJ()]);
    assert.equal(initCalls, 1);
    const folder = {};
    const results = await Promise.all([
      first.runJava("test", ["first"], { folder, inputs: ["first.txt"] }),
      second.runJava("test", ["second"], { folder, inputs: ["second.txt"] }),
    ]);
    assert.deepEqual(results.map(result => result.stdout), ["first", "second"]);
    assert.deepEqual(results.map(result => result.inputs), [["first.txt"], ["second.txt"]]);
    globalThis.cheerpjRunMain = async () => 0;
    await assert.rejects(first.runJava("test", [], { folder }), /launcher stopped before reporting an exit code/);
  } finally {
    delete globalThis.__omicsWayfinderCheerpJRuntime;
    delete globalThis.cheerpjInit;
    delete globalThis.cheerpjRunMain;
    await server.close();
  }
});

test("a failed initialization can be retried", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true }, logLevel: "silent" });
  let calls = 0;
  globalThis.cheerpjInit = async () => {
    if (++calls === 1) throw new Error("initialization failed");
  };
  try {
    const module = await server.ssrLoadModule("/src/lib/execution_backend/java/cheerpj.ts");
    await assert.rejects(module.initCheerpJ(), /initialization failed/);
    await module.initCheerpJ();
    assert.equal(calls, 2);
  } finally {
    delete globalThis.__omicsWayfinderCheerpJRuntime;
    delete globalThis.cheerpjInit;
    await server.close();
  }
});

test("Trimmomatic stages adapter paths embedded in ILLUMINACLIP", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true }, logLevel: "silent" });
  let natives;
  globalThis.cheerpjInit = async options => { natives = options.natives; };
  globalThis.cheerpjRunMain = async () => {
    assert.equal(await natives.Java_omics_cheerp_Folder_inputs(), "reads.fastq\nadapters/custom.fa");
    await natives.Java_omics_cheerp_Launcher_exit(null, 0);
    return 0;
  };
  const file = name => ({ kind: "file", name });
  const directories = files => ({
    async getFileHandle(name) {
      const handle = files.find(item => item.kind === "file" && item.name === name);
      if (!handle) throw new Error("not found");
      return handle;
    },
    async getDirectoryHandle(name) {
      const handle = files.find(item => item.kind === "directory" && item.name === name);
      if (!handle) throw new Error("not found");
      return handle;
    },
    async *values() { yield* files; },
  });

  const adapters = Object.assign(directories([file("custom.fa")]), { kind: "directory", name: "adapters" });
  const folder = directories([file("reads.fastq"), adapters]);
  try {
    const module = await server.ssrLoadModule("/src/lib/execution_backend/java/cheerpj.ts");
    const result = await module.runPublicToolCommand(folder, "trimmomatic SE reads.fastq out.fastq ILLUMINACLIP:adapters/custom.fa:2:8:4");
    assert.equal(result.exitCode, 0);
  } finally {
    delete globalThis.__omicsWayfinderCheerpJRuntime;
    delete globalThis.cheerpjInit;
    delete globalThis.cheerpjRunMain;
    await server.close();
  }
});

test("FastQC validates the output directory without staging its existing contents", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true }, logLevel: "silent" });
  let natives;
  let displays = 0;
  globalThis.cheerpjInit = async options => { natives = options.natives; };
  globalThis.cheerpjRunMain = async (_launcher, _classpath, _main, jar) => {
    assert.match(jar, /\/fastqc\/0\.13\.0\/fastqc\.jar$/);
    assert.equal(await natives.Java_omics_cheerp_Folder_inputs(), "reads.fastq");
    await natives.Java_omics_cheerp_Launcher_exit(null, 0);
    return 0;
  };
  globalThis.document = {
    createElement: () => ({ style: {}, remove() {} }),
    body: { append() {} },
  };
  globalThis.cheerpjCreateDisplay = () => { displays++; };
  const read = { kind: "file", name: "reads.fastq" };
  const reports = { kind: "directory", name: "reports" };
  const folder = {
    async getFileHandle(name) {
      if (name === read.name) return read;
      throw new Error("not found");
    },
    async getDirectoryHandle(name) {
      if (name === reports.name) return reports;
      throw new Error("not found");
    },
    async *values() { yield read; yield reports; },
  };
  try {
    const module = await server.ssrLoadModule("/src/lib/execution_backend/java/cheerpj.ts");
    await assert.rejects(module.runPublicToolCommand(folder, "fastqc --outdir missing reads.fastq"), /not found/);
    await assert.rejects(module.runPublicToolCommand(folder, "fastqc --outdir ../outside reads.fastq"), /Invalid path/);
    await assert.rejects(module.runPublicToolCommand(folder, "fastqc --outdir uploads reads.fastq"), /reserved directory/);
    await assert.rejects(module.runPublicToolCommand(folder, "fastqc --outdir= reads.fastq"), /Missing value/);
    await module.runPublicToolCommand(folder, "fastqc --outdir reports reads.fastq");
    await module.runPublicToolCommand(folder, "fastqc --outdir=reports reads.fastq");
    assert.equal(displays, 1);
  } finally {
    delete globalThis.__omicsWayfinderCheerpJRuntime;
    delete globalThis.cheerpjInit;
    delete globalThis.cheerpjRunMain;
    delete globalThis.cheerpjCreateDisplay;
    delete globalThis.document;
    await server.close();
  }
});
