/**
 * Loads biowasm Emscripten tools inside the Mayo worker and runs their main(), following Aioli.
 *
 * Filesystem layout (same as Aioli):
 * - The first non-reinit tool is the "base" module. Its in-memory filesystem holds /shared,
 *   and /shared/data is the working directory.
 * - Every other tool mounts the base module's /shared with PROXYFS, so all tools see the same files.
 * - A tool's bundled sample data (for example /samtools/examples) is also mounted at
 *   /shared/<tool> in the base filesystem so other tools can use it.
 *
 * - When a folder is selected (and the page is cross-origin isolated), it is mounted
 *   at /shared/data with MAYOFS, replacing the in-memory folder there.
 */

import { createMAYOFS, type EmscriptenFSInternals, type MAYOFS } from "./mayo-emscripten-fs";
import type { MayoFS } from "./mayo-fs";
import type { MayoExecResult, MayoRedirect, MayoRedirects, MayoToolConfig, MayoToolInfo } from "./mayo.protocol";

const DIR_SHARED = "/shared";
const DIR_DATA = "/shared/data";
/**
 * Most characters of stdout and of stderr kept per run. The whole output is held in memory and
 * copied to the page, so `samtools view big.bam` (gigabytes of SAM text) would crash the tab.
 * Large outputs belong in a file (`-o`).
 */
const OUTPUT_LIMIT = 16 * 1024 * 1024;

/** The parts of an Emscripten FS that Mayo uses. */
type EmscriptenFS = {
  mkdir(path: string): void;
  chdir(path: string): void;
  cwd(): string;
  mount(type: unknown, options: Record<string, unknown>, mountpoint: string): void;
  unmount(mountpoint: string): void;
  analyzePath(path: string): { exists: boolean };
  open(path: string, flags: string): { fd: number };
  close(stream: unknown): void;
  streams: unknown[];
} & EmscriptenFSInternals;

type EmscriptenModule = {
  callMain(args: string[]): void;
  FS: EmscriptenFS;
  PROXYFS: unknown;
  // Flushes C stdio buffers; fflush(0) flushes all. Not exported by every build.
  _fflush?: (stream: number) => number;
};

/** biowasm glue defines a MODULARIZE factory: `Module(overrides)` resolves to the module. */
type EmscriptenFactory = (overrides: Record<string, unknown>) => Promise<EmscriptenModule>;

type Tool = MayoToolConfig & {
  module?: EmscriptenModule;
  stdout: string;
  stderr: string;
  // Characters dropped past OUTPUT_LIMIT in the current run.
  stdoutDropped: number;
  stderrDropped: number;
  exitCode: number;
};

export class MayoTools {
  private readonly tools: Tool[] = [];
  private base: Tool | undefined;
  // One download and evaluation per glue script, reused for lazy loading and reinit.
  private readonly factories = new Map<string, Promise<EmscriptenFactory>>();
  private mayofs: MAYOFS | undefined;
  private folderMounted = false;

  private readonly fs: MayoFS;

  constructor(fs: MayoFS) {
    this.fs = fs;
  }

  /** Add tools and initialize the eager ones. Can be called again to add more tools. */
  async load(configs: MayoToolConfig[]): Promise<MayoToolInfo[]> {
    // exec finds tools by program name, so each program can only be loaded once. Loading the same
    // tool version again is skipped; the same program name from another tool or version is an error.
    const known = new Map<string, { tool: string; version: string }>(this.tools.map(tool => [tool.program, tool]));
    const fresh: MayoToolConfig[] = [];
    for (const config of configs) {
      const existing = known.get(config.program);
      if (existing?.tool === config.tool && existing.version === config.version) continue;
      if (existing) {
        throw new Error(`Program ${config.program} is already loaded from ${existing.tool} ${existing.version}.`);
      }
      known.set(config.program, config);
      fresh.push(config);
    }

    const added: Tool[] = fresh.map(config => ({ ...config, stdout: "", stderr: "", stdoutDropped: 0, stderrDropped: 0, exitCode: 0 }));
    if (added.length === 0) return this.list();
    const previousBase = this.base;
    if (!this.base) {
      // The base module's filesystem must stay stable, so it cannot be reinitialized or lazy.
      const base = added.find(tool => !tool.reinit);
      if (!base) throw new Error("At least one tool must have reinit: false to own the shared filesystem.");
      base.loading = "eager";
      this.base = base;
    }

    this.tools.push(...added);
    try {
      // Set up the base first: the other modules mount its filesystem.
      if (this.base !== previousBase) await this.setup(this.base);
      await Promise.all(added.filter(tool => tool.loading === "eager" && !tool.module).map(tool => this.setup(tool)));
      this.shareSampleData();
    } catch (error) {
      // Forget the whole batch so the caller can fix the specs and retry.
      this.tools.splice(this.tools.length - added.length, added.length);
      this.base = previousBase;
      throw error;
    }
    return this.list();
  }

  list(): MayoToolInfo[] {
    return this.tools.map(tool => ({
      tool: tool.tool,
      version: tool.version,
      program: tool.program,
      urlPrefix: tool.urlPrefix,
      loading: tool.loading,
      reinit: tool.reinit,
      loaded: tool.module !== undefined,
      base: tool === this.base,
    }));
  }

  /** Run a program's main() with the given arguments and collect its output and exit code. */
  async exec(program: string, args: string[], redirects: MayoRedirects = {}): Promise<MayoExecResult> {
    const tool = this.tools.find(candidate => candidate.program === program);
    if (!tool) throw new Error(`Program ${program} not found. Load it with loadTools first.`);
    if (!tool.module) {
      await this.setup(tool);
      this.shareSampleData();
    }
    const module = tool.module!;
    this.mountFolder();

    tool.stdout = "";
    tool.stderr = "";
    tool.stdoutDropped = 0;
    tool.stderrDropped = 0;
    tool.exitCode = 0;
    // Like a shell: open the redirection files first and do not run the program if one fails.
    const opened = redirectStdio(module.FS, redirects);
    if (opened.error) {
      tool.stderr += `${opened.error}\n`;
      tool.exitCode = 1;
    } else {
      try {
        // Synchronous: runs main() to completion. The exit code arrives through the quit hook.
        module.callMain(args);
      } catch (error) {
        // A crash (not a normal exit): the glue already called quit(1).
        tool.exitCode ||= 1;
        tool.stderr += `${error instanceof Error ? error.message : String(error)}\n`;
      }
    }
    // A file on stdout is fully buffered by the C library; write what is left before closing it.
    try {
      module._fflush?.(0);
    } catch {
      // The module crashed; there is nothing more to save.
    }
    for (const error of flushStdio(module.FS, redirects)) {
      tool.stderr += `[Mayo] could not save ${error}\n`;
      tool.exitCode ||= 1;
    }
    // Save files the program left open; a failed save fails the run.
    for (const error of this.mayofs?.closeOpenFiles() ?? []) {
      tool.stderr += `[Mayo] could not save ${error}\n`;
      tool.exitCode ||= 1;
    }
    for (const [stream, dropped] of [["stdout", tool.stdoutDropped], ["stderr", tool.stderrDropped]] as const) {
      if (dropped > 0) {
        tool.stderr += `[Mayo] ${stream} was cut after ${OUTPUT_LIMIT / 1024 / 1024} MiB; ${dropped} more characters were dropped. Narrow the output (for example samtools view -c, -H or a region) or write it to a file with -o or >.\n`;
      }
    }
    const result = { stdout: tool.stdout, stderr: tool.stderr, exitCode: tool.exitCode };

    // Some tools keep global state between runs; start them fresh (the base module is never reinit).
    if (tool.reinit && tool !== this.base) {
      tool.module = undefined;
      await this.setup(tool);
      this.shareSampleData();
    }
    return result;
  }

  /**
   * (Re)mount the selected folder at /shared/data before each run. Remounting drops the nodes
   * Emscripten cached during the previous run, so files changed outside the app are seen,
   * and it picks up a folder selected after the tools were loaded.
   */
  private mountFolder(): void {
    const FS = this.base!.module!.FS;
    if (this.folderMounted) {
      FS.unmount(DIR_DATA);
      this.folderMounted = false;
    }
    if (!this.fs.ready) return;
    this.mayofs ??= createMAYOFS(FS, this.fs);
    FS.mount(this.mayofs.type, {}, DIR_DATA);
    this.folderMounted = true;
  }

  /** Download (once), instantiate and wire up one Emscripten module. */
  private async setup(tool: Tool): Promise<void> {
    const factory = await this.factory(`${tool.urlPrefix}/${tool.program}.js`);
    const module = await factory({
      // argv[0]; otherwise it would be "./this.program".
      thisProgram: tool.program,
      // Where the glue fetches <program>.wasm and <program>.data from.
      locateFile: (path: string) => `${tool.urlPrefix}/${path}`,
      print: (line: string) => {
        if (tool.stdout.length + line.length < OUTPUT_LIMIT) tool.stdout += `${line}\n`;
        else tool.stdoutDropped += line.length + 1;
      },
      printErr: (line: string) => {
        if (tool.stderr.length + line.length < OUTPUT_LIMIT) tool.stderr += `${line}\n`;
        else tool.stderrDropped += line.length + 1;
      },
      // No stdin yet: reading it returns end-of-file.
      stdin: () => null,
      // Every exit goes through quit(status): main() returning, exit(), or a crash.
      // Rethrowing keeps the glue's own control flow intact.
      quit: (status: number, toThrow: unknown) => {
        tool.exitCode = status;
        throw toThrow;
      },
    });

    const FS = module.FS;
    if (tool === this.base) {
      FS.mkdir(DIR_SHARED);
      FS.mkdir(DIR_DATA);
      FS.chdir(DIR_DATA);
    } else {
      const baseFS = this.base!.module!.FS;
      FS.mkdir(DIR_SHARED);
      FS.mount(module.PROXYFS, { root: DIR_SHARED, fs: baseFS }, DIR_SHARED);
      // Start in the same folder as the base module.
      FS.chdir(baseFS.cwd());
    }
    tool.module = module;
  }

  /**
   * Module workers cannot use importScripts, so fetch the classic glue script and evaluate it.
   * fetch uses CORS, which the biowasm CDN allows, so this also works under COEP require-corp.
   */
  private factory(url: string): Promise<EmscriptenFactory> {
    let factory = this.factories.get(url);
    if (!factory) {
      factory = (async () => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
        // Dev servers and single-page hosts may answer a missing file with index.html.
        if (response.headers.get("content-type")?.includes("text/html")) {
          throw new Error(`Could not download ${url}: the server returned an HTML page, not the tool's JavaScript.`);
        }
        const source = await response.text();
        // The glue declares `var Module = <factory>`; return it from the evaluated function.
        return new Function(`${source}\n;return Module;`)() as EmscriptenFactory;
      })();
      factory.catch(() => this.factories.delete(url));
      this.factories.set(url, factory);
    }
    return factory;
  }

  /** Mount each loaded tool's sample data folder (e.g. /samtools) at /shared/<tool> in the base filesystem. */
  private shareSampleData(): void {
    const base = this.base?.module;
    if (!base) return;
    for (const tool of this.tools) {
      if (!tool.module) continue;
      const source = `/${tool.tool}`;
      const target = `${DIR_SHARED}/${tool.tool}`;
      if (!tool.module.FS.analyzePath(source).exists || base.FS.analyzePath(target).exists) continue;
      base.FS.mkdir(target);
      base.FS.mount(base.PROXYFS, { root: source, fs: tool.module.FS }, target);
    }
  }
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
 * Point stdout (fd 1) and/or stderr (fd 2) at files, relative to the working directory.
 * Writes then go straight to the file, byte for byte, instead of through print/printErr.
 * Returns a shell-style error message if a file cannot be opened; streams already
 * redirected are left for flushStdio to close.
 */
function redirectStdio(FS: EmscriptenFS, redirects: MayoRedirects): { error?: string } {
  const targets: [number, MayoRedirect | undefined][] = [[1, redirects.stdout], [2, redirects.stderr]];
  for (const [fd, redirect] of targets) {
    if (!redirect) continue;
    try {
      FS.close(FS.streams[fd]);
      // open() takes the lowest free descriptor, which is now fd.
      const stream = FS.open(redirect.path, redirect.append ? "a" : "w");
      if (stream.fd !== fd) {
        FS.close(stream);
        throw new Error(`could not use it as descriptor ${fd}`);
      }
    } catch (error) {
      const errno = (error as { errno?: number }).errno;
      const message = errno !== undefined
        ? OPEN_ERRORS[errno] ?? `error ${errno}`
        : error instanceof Error ? error.message : String(error);
      return { error: `mayo: ${redirect.path}: ${message}` };
    }
  }
  return {};
}

/**
 * Close and reopen stdout/stderr so buffered output (lines without a trailing newline) is
 * printed now rather than at the next run, and the next run starts with fresh streams.
 * Closing a redirection file saves it; returns one message per file that could not be saved.
 */
function flushStdio(FS: EmscriptenFS, redirects: MayoRedirects): string[] {
  const errors: string[] = [];
  const targets: [number, MayoRedirect | undefined][] = [[1, redirects.stdout], [2, redirects.stderr]];
  for (const [fd, redirect] of targets) {
    const stream = FS.streams[fd];
    // The program (or a failed redirection) may have closed it already.
    if (!stream) continue;
    try {
      FS.close(stream);
    } catch (error) {
      if (redirect) errors.push(`${redirect.path}: ${error instanceof Error ? error.message : String(error)}`);
      // A failed close may leave the descriptor taken.
      FS.streams[fd] = null;
    }
  }
  FS.streams[1] = FS.open("/dev/stdout", "w");
  FS.streams[2] = FS.open("/dev/stderr", "w");
  return errors;
}
