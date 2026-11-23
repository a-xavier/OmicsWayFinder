/**
 * The coordinator's tool registry (runs in the Mayo worker).
 *
 * Each loaded program gets a "warm" tool worker (tool/worker.ts): one Emscripten instance,
 * downloaded, compiled and initialized once, then reused for every run. A program that appears
 * twice in a pipeline gets an extra instance, which reuses the compiled WebAssembly.Module.
 *
 * Tool workers share the selected folder through the I/O worker (io/host.ts), each with its own
 * connection; /tmp and the tools' sample data are private to each worker, as for processes.
 */

import type { IOHost } from "../io/host";
import type { MayoToolConfig, MayoToolInfo } from "../protocol";
import { fetchFile } from "../shared/urls";
import type { ToolRequest, ToolResponse, ToolRunResult } from "../tool/protocol";

export type Tool = MayoToolConfig & {
  /** Compiled by the first instance; later instances only instantiate it. */
  wasm?: WebAssembly.Module;
  /** The instance kept between runs. */
  warm?: Promise<ToolInstance>;
};

export type RunRequest = Extract<ToolRequest, { type: "run" }>;

/** Exit code reported for a stopped run, as a shell reports Ctrl-C (128 + SIGINT). */
export const CANCELLED_EXIT_CODE = 130;

export function failedRun(message: string, exitCode: number, crashed = true): ToolRunResult {
  return { stdout: "", stderr: `${message}\n`, exitCode, brokenPipe: false, crashed };
}

function cancelledRun(): ToolRunResult {
  return failedRun("[Mayo] cancelled", CANCELLED_EXIT_CODE);
}

function configOf({ tool, version, program, urlPrefix, loading, reinit }: Tool): MayoToolConfig {
  return { tool, version, program, urlPrefix, loading, reinit };
}

/** One tool worker, as seen from the coordinator. */
export class ToolInstance {
  private readonly worker: Worker;
  private readonly client: number;
  private readonly io: IOHost;
  private finishRun: ((result: ToolRunResult) => void) | undefined;
  private stopped = false;

  private constructor(worker: Worker, client: number, io: IOHost) {
    this.worker = worker;
    this.client = client;
    this.io = io;
  }

  /** Start a worker and load the tool in it. Stores the compiled module on `tool`. */
  static async start(tool: Tool, source: string, io: IOHost): Promise<ToolInstance> {
    const { client, connection } = await io.connect();
    const worker = new Worker(new URL("../tool/worker.ts", import.meta.url), { type: "module" });
    const instance = new ToolInstance(worker, client, io);
    try {
      const wasm = await new Promise<WebAssembly.Module>((resolve, reject) => {
        worker.addEventListener("message", (event: MessageEvent<ToolResponse>) => {
          if (event.data.type === "ready") resolve(event.data.wasm);
          else if (event.data.type === "failed") reject(new Error(`Could not load ${tool.program}: ${event.data.message}`));
        });
        worker.addEventListener("error", event => reject(new Error(`Could not load ${tool.program}: ${event.message}`)));
        worker.postMessage({ type: "setup", tool: configOf(tool), source, wasm: tool.wasm, io: connection } satisfies ToolRequest, [connection.port]);
      });
      tool.wasm ??= wasm;
    } catch (error) {
      instance.terminate();
      throw error;
    }
    worker.addEventListener("message", (event: MessageEvent<ToolResponse>) => {
      if (event.data.type === "done") instance.settle(event.data.result);
    });
    worker.addEventListener("error", event => {
      event.preventDefault();
      instance.settle(failedRun(`[Mayo] the ${tool.program} worker failed: ${event.message}`, 1));
    });
    return instance;
  }

  /** Run main() once. Resolves (never rejects) when it exits, crashes or is terminated. */
  run(request: RunRequest, onStderr?: (text: string) => void): Promise<ToolRunResult> {
    if (this.stopped) return Promise.resolve(cancelledRun());
    const listener = (event: MessageEvent<ToolResponse>) => {
      if (event.data.type === "stderr") onStderr?.(event.data.text);
    };
    this.worker.addEventListener("message", listener);
    return new Promise<ToolRunResult>(resolve => {
      this.finishRun = result => {
        this.worker.removeEventListener("message", listener);
        resolve(result);
      };
      this.worker.postMessage(request satisfies ToolRequest);
    });
  }

  /** Stop the worker, even in the middle of main(). Its unfinished file writes are discarded. */
  terminate(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.worker.terminate();
    this.io.disconnect(this.client);
    this.settle(cancelledRun());
  }

  private settle(result: ToolRunResult): void {
    const finish = this.finishRun;
    this.finishRun = undefined;
    finish?.(result);
  }
}

export class ToolRegistry {
  private readonly tools: Tool[] = [];
  // One download per glue script, reused for every instance.
  private readonly sources = new Map<string, Promise<string>>();
  private readonly io: IOHost;

  constructor(io: IOHost) {
    this.io = io;
  }

  /** Add tools and start the eager ones. Can be called again to add more tools. */
  async load(configs: MayoToolConfig[]): Promise<MayoToolInfo[]> {
    // exec finds tools by program name, so each program can only be loaded once. Loading the same
    // tool version again is skipped; the same program name from another tool or version is an error.
    const known = new Map<string, { tool: string; version: string }>(this.tools.map(tool => [tool.program, tool]));
    const added: Tool[] = [];
    for (const config of configs) {
      const existing = known.get(config.program);
      if (existing?.tool === config.tool && existing.version === config.version) continue;
      if (existing) {
        throw new Error(`Program ${config.program} is already loaded from ${existing.tool} ${existing.version}.`);
      }
      known.set(config.program, config);
      added.push({ ...config });
    }
    if (added.length === 0) return this.list();
    await this.io.start();

    this.tools.push(...added);
    try {
      await Promise.all(added.filter(tool => tool.loading === "eager").map(tool => this.warm(tool)));
    } catch (error) {
      // Forget the whole batch so the caller can fix the specs and retry.
      for (const tool of added) void tool.warm?.then(instance => instance.terminate(), () => {});
      this.tools.splice(this.tools.indexOf(added[0]), added.length);
      throw error;
    }
    return this.list();
  }

  list(): MayoToolInfo[] {
    return this.tools.map(tool => ({ ...configOf(tool), loaded: tool.wasm !== undefined }));
  }

  /** The tool that provides a program. */
  find(program: string): Tool {
    const tool = this.tools.find(candidate => candidate.program === program);
    if (!tool) throw new Error(`Program ${program} not found. Load it with loadTools first.`);
    return tool;
  }

  /** The instance kept between runs, started if needed. */
  warm(tool: Tool): Promise<ToolInstance> {
    if (!tool.warm) {
      const starting = this.spawn(tool);
      tool.warm = starting;
      starting.catch(() => {
        if (tool.warm === starting) tool.warm = undefined;
      });
    }
    return tool.warm;
  }

  /** Drop the warm instance (it crashed, was stopped, or the tool needs a fresh one per run) and start loading a new one. */
  replaceWarm(tool: Tool): void {
    tool.warm = undefined;
    // The next run waits for it.
    void this.warm(tool).catch(() => {});
  }

  /** A new instance, for a program used more than once in a pipeline. */
  async spawn(tool: Tool): Promise<ToolInstance> {
    return ToolInstance.start(tool, await this.source(`${tool.urlPrefix}/${tool.program}.js`), this.io);
  }

  /**
   * The tool's glue script, downloaded once. Module workers cannot use importScripts, so tool
   * workers evaluate this text. fetch uses CORS, which the biowasm CDN allows, so this also works
   * under COEP require-corp.
   */
  private source(url: string): Promise<string> {
    let source = this.sources.get(url);
    if (!source) {
      source = fetchFile(url).then(response => response.text());
      source.catch(() => this.sources.delete(url));
      this.sources.set(url, source);
    }
    return source;
  }
}
