/// <reference lib="webworker" />

/**
 * Tool worker: one Emscripten module (one biowasm program), loaded once and run many times.
 *
 * Each worker is like a process: its own memory, its own filesystem, and file descriptors 0/1/2.
 * - /shared/data (the working directory) is the selected folder, through MAYOFS and this
 *   worker's own connection to the I/O worker. It is remounted before each run.
 * - /shared/<tool> links to the tool's bundled sample data (/samtools/examples...).
 * - http(s) URLs in the arguments are mounted under /shared/urls/<n> with URLFS.
 * - /dev/stdin and /dev/stdout are Mayo devices: in a pipeline they are pipes to the
 *   neighbouring stages (mayo-pipe.ts); otherwise stdin is empty and stdout is collected for
 *   the result. stderr is collected, and sent to the coordinator as it is printed.
 *
 * main() runs synchronously and may block on pipes and file calls (Atomics.wait), so every
 * tool in a pipeline needs its own worker.
 */

import { createMAYOFS, type EmscriptenFSInternals, type MAYOFS } from "./mayo-emscripten-fs";
import { MayoFS } from "./mayo-fs";
import { PipeClosedError, PipeReader, PipeWriter } from "./mayo-pipe";
import type { MayoStageRedirects, MayoToolRequest, MayoToolResponse, MayoToolRunResult } from "./mayo-tool.protocol";
import { createURLFS, RemoteFiles, splitUrl, URL_PATTERN, type URLFS, type URLFSMountOptions } from "./mayo-url-fs";
import type { MayoToolConfig } from "./mayo.protocol";

declare const self: DedicatedWorkerGlobalScope;

const DIR_SHARED = "/shared";
const DIR_DATA = "/shared/data";
const DIR_URLS = "/shared/urls";
/**
 * Most characters of stdout and of stderr kept per run. The whole output is held in memory and
 * copied to the page, so `samtools view big.bam` (gigabytes of SAM text) would crash the tab.
 * Large outputs belong in a file (`-o`) or a pipe.
 */
const OUTPUT_LIMIT = 16 * 1024 * 1024;
/** Least time between two live stderr messages, so chatty tools do not flood the page. */
const LIVE_INTERVAL_MS = 100;
// Emscripten errno numbers.
const EBADF = 8;
// Device numbers for Mayo's stdin and stdout (any major number Emscripten does not use).
const DEVICE_MAJOR = 64;

/** The parts of an Emscripten FS that Mayo uses. */
type EmscriptenFS = {
  mkdir(path: string): void;
  chdir(path: string): void;
  symlink(target: string, path: string): void;
  unlink(path: string): void;
  mount(type: unknown, options: Record<string, unknown>, mountpoint: string): void;
  unmount(mountpoint: string): void;
  analyzePath(path: string): { exists: boolean };
  open(path: string, flags: string): { fd: number };
  close(stream: unknown): void;
  makedev(major: number, minor: number): number;
  mkdev(path: string, mode: number, dev: number): void;
  registerDevice(dev: number, ops: Record<string, unknown>): void;
  streams: unknown[];
} & EmscriptenFSInternals;

type EmscriptenModule = {
  callMain(args: string[]): void;
  FS: EmscriptenFS;
  // Flushes C stdio buffers; fflush(0) flushes all. Not exported by every build.
  _fflush?: (stream: number) => number;
};

/** biowasm glue defines a MODULARIZE factory: `Module(overrides)` resolves to the module. */
type EmscriptenFactory = (overrides: Record<string, unknown>) => Promise<EmscriptenModule>;

/** Thrown out of main() when stdout's reader has gone, ending the program as SIGPIPE would. */
class BrokenPipe extends Error {}

const fs = new MayoFS();
const remote = new RemoteFiles(fs);
let module: EmscriptenModule | undefined;
let mayofs: MAYOFS | undefined;
let folderMounted = false;
let urlfs: URLFS | undefined;
// One mount per remote directory URL, kept for the worker's lifetime so paths stay the same.
const urlMounts = new Map<string, { path: string; opts: URLFSMountOptions }>();

/** State of the current run. */
const run = {
  stdout: "",
  stderr: "",
  stdoutDropped: 0,
  stderrDropped: 0,
  exitCode: 0,
  brokenPipe: false,
  stdin: undefined as PipeReader | undefined,
  pipeOut: undefined as PipeWriter | undefined,
  decoder: new TextDecoder(),
  live: false,
  liveText: "",
  liveSent: 0,
};

function appendStdout(text: string): void {
  if (run.stdout.length + text.length <= OUTPUT_LIMIT) run.stdout += text;
  else run.stdoutDropped += text.length;
}

function appendStderr(text: string): void {
  if (run.stderr.length + text.length <= OUTPUT_LIMIT) run.stderr += text;
  else run.stderrDropped += text.length;
  if (!run.live) return;
  run.liveText += text;
  if (performance.now() - run.liveSent >= LIVE_INTERVAL_MS) sendLiveStderr();
}

function sendLiveStderr(): void {
  if (!run.liveText) return;
  // Posting does not need this worker's event loop, so the page sees it while main() runs.
  post({ type: "stderr", text: run.liveText });
  run.liveText = "";
  run.liveSent = performance.now();
}

function post(message: MayoToolResponse): void {
  self.postMessage(message);
}

/**
 * Module workers cannot use importScripts, so evaluate the classic glue script, which declares
 * `var Module = <factory>`.
 */
async function setup(tool: MayoToolConfig, source: string, wasm: WebAssembly.Module | undefined): Promise<WebAssembly.Module> {
  const factory = new Function(`${source}\n;return Module;`)() as EmscriptenFactory;
  let compiled = wasm;
  let failInstantiate: (error: unknown) => void = () => {};
  const instantiated = new Promise<never>((_, reject) => { failInstantiate = reject; });
  const locateFile = (path: string) => `${tool.urlPrefix}/${path}`;
  const created = factory({
    // argv[0]; otherwise it would be "./this.program".
    thisProgram: tool.program,
    // Where the glue fetches <program>.wasm and <program>.data from.
    locateFile,
    // Compile once per tool: extra instances (the same tool twice in a pipeline, reinit) reuse it.
    instantiateWasm(imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) {
      void (async () => {
        if (!compiled) {
          const url = locateFile(`${tool.program}.wasm`);
          try {
            compiled = await WebAssembly.compileStreaming(fetch(url));
          } catch {
            // compileStreaming needs the application/wasm content type; not every server sends it.
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
            compiled = await WebAssembly.compile(await response.arrayBuffer());
          }
        }
        receive(await WebAssembly.instantiate(compiled, imports), compiled);
      })().catch(failInstantiate);
      return {};
    },
    // Only reached for terminal output; stdout normally goes through the Mayo device.
    print: (line: string) => appendStdout(`${line}\n`),
    // After a broken pipe the glue reports the BrokenPipe exception as a crash; a process
    // stopped by SIGPIPE prints nothing, so drop it.
    printErr: (line: string) => { if (!run.brokenPipe) appendStderr(`${line}\n`); },
    stdin: () => null,
    // Every exit goes through quit(status): main() returning, exit(), or a crash.
    // Rethrowing keeps the glue's own control flow intact.
    quit: (status: number, toThrow: unknown) => {
      run.exitCode = status;
      throw toThrow;
    },
  });
  const loaded = await Promise.race([created, instantiated]);
  const FS = loaded.FS;
  FS.mkdir(DIR_SHARED);
  FS.mkdir(DIR_DATA);
  FS.mkdir(DIR_URLS);
  FS.chdir(DIR_DATA);
  // Sample data bundled with the tool (for example /samtools/examples) at /shared/<tool>.
  if (FS.analyzePath(`/${tool.tool}`).exists) FS.symlink(`/${tool.tool}`, `${DIR_SHARED}/${tool.tool}`);
  installDevices(FS);
  module = loaded;
  return compiled!;
}

/** Replace /dev/stdin and /dev/stdout with devices that read and write the run's pipes. */
function installDevices(FS: EmscriptenFS): void {
  const badDescriptor = () => {
    throw new FS.ErrnoError(EBADF);
  };
  // No llseek: Emscripten answers ESPIPE, so programs see a pipe, not a seekable file.
  const stdinDevice = FS.makedev(DEVICE_MAJOR, 0);
  FS.registerDevice(stdinDevice, {
    open() {},
    close() {},
    read(_stream: unknown, buffer: Int8Array, offset: number, length: number): number {
      return run.stdin ? run.stdin.read(buffer, offset, length) : 0;
    },
    write: badDescriptor,
  });
  const stdoutDevice = FS.makedev(DEVICE_MAJOR, 1);
  FS.registerDevice(stdoutDevice, {
    open() {},
    close() {},
    read: badDescriptor,
    write(_stream: unknown, buffer: Int8Array, offset: number, length: number): number {
      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
      if (run.pipeOut) {
        try {
          run.pipeOut.write(bytes);
        } catch (error) {
          if (!(error instanceof PipeClosedError)) throw error;
          run.brokenPipe = true;
          throw new BrokenPipe("Broken pipe");
        }
      } else {
        appendStdout(run.decoder.decode(bytes, { stream: true }));
      }
      return length;
    },
  });
  FS.unlink("/dev/stdin");
  FS.mkdev("/dev/stdin", 0o666, stdinDevice);
  FS.unlink("/dev/stdout");
  FS.mkdev("/dev/stdout", 0o666, stdoutDevice);
  resetStdio(FS);
}

/** Close descriptors 0, 1 and 2 and reopen them on the devices. Returns files that could not be saved. */
function resetStdio(FS: EmscriptenFS, redirects: MayoStageRedirects = {}): string[] {
  const errors: string[] = [];
  const targets: [number, string | undefined][] = [[0, redirects.stdin], [1, redirects.stdout?.path], [2, redirects.stderr?.path]];
  for (const [fd, path] of targets) {
    const stream = FS.streams[fd];
    if (!stream) continue;
    try {
      FS.close(stream);
    } catch (error) {
      // Closing a redirection file saves it.
      if (path) errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      FS.streams[fd] = null;
    }
  }
  // open() takes the lowest free descriptor.
  FS.open("/dev/stdin", "r");
  FS.open("/dev/stdout", "w");
  FS.open("/dev/stderr", "w");
  return errors;
}

/** Short messages for errors from opening a redirection file, as a shell prints them. */
const OPEN_ERRORS: Record<number, string> = {
  2: "Permission denied",
  31: "Is a directory",
  44: "No such file or directory",
  54: "Not a directory",
  63: "Operation not permitted",
};

/**
 * Point stdin, stdout and/or stderr at files, relative to the working directory, like a shell's
 * `<`, `>`, `>>` and `2>`. Returns a shell-style error message if a file cannot be opened.
 */
function redirectStdio(FS: EmscriptenFS, redirects: MayoStageRedirects): string | undefined {
  const targets: [number, string | undefined, string][] = [
    [0, redirects.stdin, "r"],
    [1, redirects.stdout?.path, redirects.stdout?.append ? "a" : "w"],
    [2, redirects.stderr?.path, redirects.stderr?.append ? "a" : "w"],
  ];
  for (const [fd, path, flags] of targets) {
    if (!path) continue;
    try {
      FS.close(FS.streams[fd]);
      const stream = FS.open(path, flags);
      if (stream.fd !== fd) {
        FS.close(stream);
        throw new Error(`could not use it as descriptor ${fd}`);
      }
    } catch (error) {
      const errno = (error as { errno?: number }).errno;
      const message = errno !== undefined
        ? OPEN_ERRORS[errno] ?? `error ${errno}`
        : error instanceof Error ? error.message : String(error);
      return `mayo: ${path}: ${message}`;
    }
  }
  return undefined;
}

/**
 * (Re)mount the selected folder at /shared/data before each run. Remounting drops the nodes
 * Emscripten cached during the previous run, so files changed by other tools or outside the
 * app are seen.
 */
function mountFolder(FS: EmscriptenFS, folder: boolean): void {
  if (folderMounted) {
    FS.unmount(DIR_DATA);
    folderMounted = false;
  }
  fs.folder = folder;
  if (!fs.ready) return;
  mayofs ??= createMAYOFS(FS, fs, remote);
  FS.mount(mayofs.type, {}, DIR_DATA);
  folderMounted = true;
}

/**
 * Mount a URL's directory with URLFS (the coordinator has already checked the URL) and return the
 * local path, e.g. https://host/data/reads.bam -> /shared/urls/0/reads.bam.
 */
function mountUrl(FS: EmscriptenFS, url: string): string {
  const { base, name } = splitUrl(url);
  let mount = urlMounts.get(base);
  if (!mount) {
    mount = { path: `${DIR_URLS}/${urlMounts.size}`, opts: { base, files: new Map() } };
    urlfs ??= createURLFS(FS, remote);
    FS.mkdir(mount.path);
    FS.mount(urlfs.type, mount.opts, mount.path);
    urlMounts.set(base, mount);
  }
  if (!name) return mount.path;
  // The exact URL as written (it may carry a query string, as signed URLs do).
  const previous = mount.opts.files.get(name);
  mount.opts.files.set(name, url);
  if (previous !== undefined && previous !== url) {
    // Emscripten caches the node found for the old URL; remounting drops it.
    FS.unmount(mount.path);
    FS.mount(urlfs!.type, mount.opts, mount.path);
  }
  return `${mount.path}/${name}`;
}

function execute(request: Extract<MayoToolRequest, { type: "run" }>): MayoToolRunResult {
  const loaded = module!;
  const FS = loaded.FS;
  Object.assign(run, {
    stdout: "",
    stderr: "",
    stdoutDropped: 0,
    stderrDropped: 0,
    exitCode: 0,
    brokenPipe: false,
    stdin: request.stdin ? new PipeReader(request.stdin) : undefined,
    pipeOut: request.stdout ? new PipeWriter(request.stdout) : undefined,
    decoder: new TextDecoder(),
    live: request.liveStderr,
    liveText: "",
    liveSent: 0,
  });
  let crashed = false;
  remote.startRun();
  try {
    mountFolder(FS, request.folder);
    const args = request.args.map(arg => arg.replace(URL_PATTERN, url => mountUrl(FS, url)));
    // Like a shell: open the redirection files first, and do not run the program if one fails.
    const failure = redirectStdio(FS, request.redirects);
    if (failure) {
      appendStderr(`${failure}\n`);
      run.exitCode = 1;
    } else {
      try {
        // Synchronous: runs main() to completion. The exit code arrives through the quit hook.
        loaded.callMain(args);
      } catch (error) {
        // The glue may wrap BrokenPipe in an abort RuntimeError, so check the flag.
        if (!run.brokenPipe) {
          // A crash (not a normal exit): the glue already called quit(1).
          crashed = true;
          run.exitCode ||= 1;
          appendStderr(`${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
    }
  } catch (error) {
    run.exitCode ||= 1;
    appendStderr(`[Mayo] ${error instanceof Error ? error.message : String(error)}\n`);
  }
  // A file or pipe on stdout is fully buffered by the C library; write what is left.
  try {
    if (!run.brokenPipe) loaded._fflush?.(0);
  } catch {
    // The pipe broke during the flush.
    if (!run.brokenPipe) crashed = true;
  }
  // End of file for the next stage, EPIPE for the previous one, as when a process exits.
  run.pipeOut?.close();
  run.stdin?.close();
  appendStdout(run.decoder.decode());
  for (const error of resetStdio(FS, request.redirects)) {
    appendStderr(`[Mayo] could not save ${error}\n`);
    run.exitCode ||= 1;
  }
  // Save files the program left open; a failed save fails the run.
  for (const error of mayofs?.closeOpenFiles() ?? []) {
    appendStderr(`[Mayo] could not save ${error}\n`);
    run.exitCode ||= 1;
  }
  if (run.brokenPipe) run.exitCode = 141;
  for (const [stream, dropped] of [["stdout", run.stdoutDropped], ["stderr", run.stderrDropped]] as const) {
    if (dropped > 0) {
      run.stderr += `[Mayo] ${stream} was cut after ${OUTPUT_LIMIT / 1024 / 1024} MiB; ${dropped} more characters were dropped. Narrow the output (for example samtools view -c, -H or a region) or write it to a file with -o or >.\n`;
    }
  }
  const remoteRun = remote.finishRun();
  for (const message of remoteRun.messages) appendStderr(`${message}\n`);
  sendLiveStderr();
  run.stdin = undefined;
  run.pipeOut = undefined;
  const result: MayoToolRunResult = { stdout: run.stdout, stderr: run.stderr, exitCode: run.exitCode, brokenPipe: run.brokenPipe, crashed };
  if (remoteRun.used || remoteRun.stats.requests > 0) result.remote = remoteRun.stats;
  return result;
}

self.addEventListener("message", (event: MessageEvent<MayoToolRequest>) => {
  const request = event.data;
  if (request.type === "setup") {
    fs.connect(request.io);
    setup(request.tool, request.source, request.wasm).then(
      wasm => post({ type: "ready", wasm }),
      (error: unknown) => post({ type: "failed", message: error instanceof Error ? error.message : String(error) }),
    );
    return;
  }
  post({ type: "done", result: execute(request) });
});
