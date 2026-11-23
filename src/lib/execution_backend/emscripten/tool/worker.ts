/// <reference lib="webworker" />

/**
 * Tool worker: one Emscripten module (one biowasm program), loaded once and run many times.
 *
 * Each worker is like a process: its own memory, its own filesystem, and file descriptors 0/1/2.
 * - /shared/data (the working directory) is the selected folder, and /shared/urls holds the URLs
 *   from the arguments (tool/mounts.ts).
 * - /shared/<tool> links to the tool's bundled sample data (/samtools/examples...).
 * - stdin and stdout are pipes to the neighbouring stages, or files (tool/stdio.ts).
 * - stdout and stderr are captured for the result, and stderr is sent live (tool/output.ts).
 *
 * main() runs synchronously and may block on pipes and file calls (Atomics.wait), so every
 * tool in a pipeline needs its own worker.
 */

import { IOClient } from "../io/client";
import type { MayoToolConfig } from "../protocol";
import type { EmscriptenModule } from "./emscripten";
import { loadModule } from "./load";
import { DIR_SHARED, Mounts } from "./mounts";
import { RunOutput } from "./output";
import type { ToolRequest, ToolResponse, ToolRunResult } from "./protocol";
import { RemoteFiles } from "./remote-files";
import { Stdio } from "./stdio";

declare const self: DedicatedWorkerGlobalScope;

/** Exit code of a program stopped by a broken pipe (128 + SIGPIPE). */
const BROKEN_PIPE_EXIT_CODE = 141;

const io = new IOClient();
const remote = new RemoteFiles(io);
let tool: { module: EmscriptenModule; stdio: Stdio; mounts: Mounts } | undefined;

/** The run in progress, written to by the glue's hooks. */
let output = new RunOutput();
let exitCode = 0;

function post(message: ToolResponse): void {
  self.postMessage(message);
}

async function setup(config: MayoToolConfig, source: string, wasm: WebAssembly.Module | undefined): Promise<WebAssembly.Module> {
  const loaded = await loadModule(config, source, wasm, {
    print: line => output.writeStdout(`${line}\n`),
    // After a broken pipe the glue reports the BrokenPipe exception as a crash; a process
    // stopped by SIGPIPE prints nothing, so drop it.
    printErr: line => { if (!tool?.stdio.brokenPipe) output.writeStderr(`${line}\n`); },
    exit: status => { exitCode = status; },
  });
  const FS = loaded.module.FS;
  const mounts = new Mounts(FS, io, remote);
  if (FS.analyzePath(`/${config.tool}`).exists) FS.symlink(`/${config.tool}`, `${DIR_SHARED}/${config.tool}`);
  tool = { module: loaded.module, stdio: new Stdio(FS), mounts };
  return loaded.wasm;
}

function execute(request: Extract<ToolRequest, { type: "run" }>): ToolRunResult {
  const { module, stdio, mounts } = tool!;
  output = new RunOutput(request.liveStderr ? text => post({ type: "stderr", text }) : undefined);
  exitCode = 0;
  let crashed = false;
  const fail = (message: string) => {
    output.writeStderr(`${message}\n`);
    exitCode ||= 1;
  };

  stdio.begin(output, request.stdin, request.stdout);
  remote.startRun();
  try {
    mounts.mountFolder(request.folder);
    const args = mounts.mountUrls(request.args);
    // Like a shell: open the redirection files first, and do not run the program if one fails.
    const failure = stdio.redirect(request.redirects);
    if (failure) {
      fail(failure);
    } else {
      try {
        // Synchronous: runs main() to completion. The exit code arrives through the exit hook.
        module.callMain(args);
      } catch (error) {
        // The glue may wrap BrokenPipe in an abort RuntimeError, so check the flag.
        if (!stdio.brokenPipe) {
          crashed = true;
          fail(error instanceof Error ? error.message : String(error));
        }
      }
    }
  } catch (error) {
    fail(`[Mayo] ${error instanceof Error ? error.message : String(error)}`);
  }

  // A file or pipe on stdout is fully buffered by the C library; write what is left.
  try {
    if (!stdio.brokenPipe) module._fflush?.(0);
  } catch {
    // The pipe broke during the flush.
    if (!stdio.brokenPipe) crashed = true;
  }
  stdio.closePipes();
  // Closing the redirection files and the files the program left open saves them.
  for (const error of [...stdio.reset(request.redirects), ...mounts.closeOpenFiles()]) fail(`[Mayo] could not save ${error}`);
  if (stdio.brokenPipe) exitCode = BROKEN_PIPE_EXIT_CODE;
  const remoteRun = remote.finishRun();
  for (const message of remoteRun.messages) output.writeStderr(`${message}\n`);
  output.finish();

  const result: ToolRunResult = { stdout: output.stdout, stderr: output.stderr, exitCode, brokenPipe: stdio.brokenPipe, crashed };
  if (remoteRun.used || remoteRun.stats.requests > 0) result.remote = remoteRun.stats;
  return result;
}

self.addEventListener("message", (event: MessageEvent<ToolRequest>) => {
  const request = event.data;
  if (request.type === "setup") {
    io.connect(request.io);
    setup(request.tool, request.source, request.wasm).then(
      wasm => post({ type: "ready", wasm }),
      (error: unknown) => post({ type: "failed", message: error instanceof Error ? error.message : String(error) }),
    );
    return;
  }
  post({ type: "done", result: execute(request) });
});
