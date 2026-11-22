/**
 * The coordinator's tool registry and pipeline runner (runs in the Mayo worker).
 *
 * A command is a list of pipelines joined by `&&`: each pipeline runs only if the previous one
 * succeeded, as in a shell.
 *
 * Each loaded program gets a "warm" tool worker (mayo-tool.worker.ts): one Emscripten instance,
 * downloaded, compiled and initialized once, then reused for every run. A command is a pipeline
 * of one or more stages; every stage runs in its own worker at the same time as the others,
 * connected stdout to stdin by pipes (mayo-pipe.ts). A program that appears twice in a pipeline
 * gets an extra instance, which reuses the compiled WebAssembly.Module.
 *
 * Tool workers share the selected folder through the I/O worker (MayoIO), each with its own
 * connection; /tmp and the tools' sample data are private to each worker, as for processes.
 * The coordinator itself never calls main(), so it stays free to start workers, forward live
 * stderr and cancel a run.
 */

import { closePipe, createPipe } from "./mayo-pipe";
import type { MayoFS, MayoIO } from "./mayo-fs";
import type { MayoToolRequest, MayoToolResponse, MayoToolRunResult } from "./mayo-tool.protocol";
import { URL_PATTERN, type RemoteChecker } from "./mayo-url-fs";
import type { MayoExecResult, MayoStage, MayoStageResult, MayoToolConfig, MayoToolInfo } from "./mayo.protocol";

type Tool = MayoToolConfig & {
  /** Compiled by the first instance; later instances only instantiate it. */
  wasm?: WebAssembly.Module;
  /** The instance kept between runs. */
  warm?: Promise<ToolInstance>;
};

type RunRequest = Extract<MayoToolRequest, { type: "run" }>;

/** The running command; `stop` is set while one of its pipelines runs. */
type CommandRun = { cancelled: boolean; stop?: () => void };

/** Exit code reported for a stopped run, as a shell reports Ctrl-C (128 + SIGINT). */
const CANCELLED_EXIT_CODE = 130;

/** One tool worker, as seen from the coordinator. */
class ToolInstance {
  private readonly worker: Worker;
  private readonly client: number;
  private readonly io: MayoIO;
  private finishRun: ((result: MayoToolRunResult) => void) | undefined;
  private stopped = false;

  private constructor(worker: Worker, client: number, io: MayoIO) {
    this.worker = worker;
    this.client = client;
    this.io = io;
  }

  /** Start a worker and load the tool in it. Stores the compiled module on `tool`. */
  static async start(tool: Tool, source: string, io: MayoIO): Promise<ToolInstance> {
    const { client, connection } = await io.connect();
    const worker = new Worker(new URL("./mayo-tool.worker.ts", import.meta.url), { type: "module" });
    const instance = new ToolInstance(worker, client, io);
    try {
      const wasm = await new Promise<WebAssembly.Module>((resolve, reject) => {
        worker.addEventListener("message", (event: MessageEvent<MayoToolResponse>) => {
          if (event.data.type === "ready") resolve(event.data.wasm);
          else if (event.data.type === "failed") reject(new Error(`Could not load ${tool.program}: ${event.data.message}`));
        });
        worker.addEventListener("error", event => reject(new Error(`Could not load ${tool.program}: ${event.message}`)));
        worker.postMessage({ type: "setup", tool: configOf(tool), source, wasm: tool.wasm, io: connection } satisfies MayoToolRequest, [connection.port]);
      });
      tool.wasm ??= wasm;
    } catch (error) {
      instance.terminate();
      throw error;
    }
    worker.addEventListener("message", (event: MessageEvent<MayoToolResponse>) => {
      if (event.data.type === "done") instance.settle(event.data.result);
    });
    worker.addEventListener("error", event => {
      event.preventDefault();
      instance.settle(failedRun(`[Mayo] the ${tool.program} worker failed: ${event.message}`, 1));
    });
    return instance;
  }

  /** Run main() once. Resolves (never rejects) when it exits, crashes or is terminated. */
  run(request: RunRequest, onStderr?: (text: string) => void): Promise<MayoToolRunResult> {
    if (this.stopped) return Promise.resolve(failedRun("[Mayo] cancelled", CANCELLED_EXIT_CODE));
    const listener = (event: MessageEvent<MayoToolResponse>) => {
      if (event.data.type === "stderr") onStderr?.(event.data.text);
    };
    this.worker.addEventListener("message", listener);
    return new Promise<MayoToolRunResult>(resolve => {
      this.finishRun = result => {
        this.worker.removeEventListener("message", listener);
        resolve(result);
      };
      this.worker.postMessage(request satisfies MayoToolRequest);
    });
  }

  /** Stop the worker, even in the middle of main(). Its unfinished file writes are discarded. */
  terminate(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.worker.terminate();
    this.io.disconnect(this.client);
    this.settle(failedRun("[Mayo] cancelled", CANCELLED_EXIT_CODE));
  }

  private settle(result: MayoToolRunResult): void {
    const finish = this.finishRun;
    this.finishRun = undefined;
    finish?.(result);
  }
}

function configOf({ tool, version, program, urlPrefix, loading, reinit }: Tool): MayoToolConfig {
  return { tool, version, program, urlPrefix, loading, reinit };
}

function failedRun(message: string, exitCode: number): MayoToolRunResult {
  return { stdout: "", stderr: `${message}\n`, exitCode, brokenPipe: false, crashed: true };
}

export class MayoTools {
  private readonly tools: Tool[] = [];
  // One download per glue script, reused for every instance.
  private readonly sources = new Map<string, Promise<string>>();
  private current: CommandRun | undefined;
  private readonly io: MayoIO;
  private readonly fs: MayoFS;
  private readonly checker: RemoteChecker;

  constructor(io: MayoIO, fs: MayoFS, checker: RemoteChecker) {
    this.io = io;
    this.fs = fs;
    this.checker = checker;
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

  /** Stop the running exec, if any. Returns false if nothing was running. */
  cancel(): boolean {
    if (!this.current) return false;
    this.current.cancelled = true;
    this.current.stop?.();
    return true;
  }

  /**
   * Run pipelines joined by `&&`: each starts only if the previous one exited with 0.
   * `onStderr` receives each stage's stderr as it is printed; stages are numbered across the
   * whole command (`a | b && c`: 0, 1, 2).
   */
  async exec(pipelines: MayoStage[][], onStderr?: (stage: number, text: string) => void): Promise<MayoExecResult> {
    if (pipelines.length === 0 || pipelines.some(stages => stages.length === 0)) throw new Error("Expecting a command.");
    // Check every program first, rather than failing after earlier pipelines have run.
    const tools = pipelines.map(stages => stages.map(stage => {
      const tool = this.tools.find(candidate => candidate.program === stage.program);
      if (!tool) throw new Error(`Program ${stage.program} not found. Load it with loadTools first.`);
      return tool;
    }));
    if (this.current) throw new Error("A command is already running.");
    const run: CommandRun = { cancelled: false };
    this.current = run;
    try {
      const results: MayoExecResult[] = [];
      let first = 0;
      for (const [index, stages] of pipelines.entries()) {
        const offset = first;
        const result = await this.runPipeline(stages, tools[index], run, onStderr && ((stage, text) => onStderr(offset + stage, text)));
        result.stages.forEach(stage => { stage.pipeline = index; });
        results.push(result);
        first += stages.length;
        if (result.exitCode !== 0 || run.cancelled) break;
      }
      return chain(results);
    } finally {
      this.current = undefined;
    }
  }

  /** Run one pipeline: every stage at the same time, each in its own worker, stdout to stdin. */
  private async runPipeline(
    stages: MayoStage[],
    tools: Tool[],
    run: CommandRun,
    onStderr?: (stage: number, text: string) => void,
  ): Promise<MayoExecResult> {
    // Like a shell's failed redirection: a stage with an unusable URL does not run, and its
    // neighbours see end of file or EPIPE.
    const failures = await Promise.all(stages.map(async stage => {
      for (const url of new Set(stage.args.flatMap(arg => arg.match(URL_PATTERN) ?? []))) {
        try {
          await this.checker.check(url);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      }
      return undefined;
    }));

    // The warm instance for a program's first stage; extra instances for repeats.
    const instances: (ToolInstance | undefined)[] = [];
    const isWarm: boolean[] = [];
    const used = new Set<Tool>();
    try {
      for (const [index, tool] of tools.entries()) {
        if (failures[index] !== undefined) continue;
        isWarm[index] = !used.has(tool);
        used.add(tool);
        instances[index] = isWarm[index] ? await this.warm(tool) : await this.spawn(tool);
      }
    } catch (error) {
      instances.forEach((instance, index) => { if (!isWarm[index]) instance?.terminate(); });
      throw error;
    }

    const pipes = stages.slice(1).map(() => createPipe());
    run.stop = () => {
      for (const instance of instances) instance?.terminate();
      for (const pipe of pipes) closePipe(pipe);
    };
    // Cancelled while the URLs were checked or the workers started: stopped instances return at once.
    if (run.cancelled) run.stop();
    let results: MayoToolRunResult[];
    try {
      results = await Promise.all(stages.map((stage, index) => {
        const stdin = index > 0 ? pipes[index - 1] : undefined;
        const stdout = index < pipes.length ? pipes[index] : undefined;
        const instance = instances[index];
        if (!instance) {
          if (stdin) closePipe(stdin);
          if (stdout) closePipe(stdout);
          return { stdout: "", stderr: `${failures[index]}\n`, exitCode: 1, brokenPipe: false, crashed: false };
        }
        return instance.run(
          { type: "run", args: stage.args, redirects: stage.redirects, stdin, stdout, folder: this.fs.folder, liveStderr: onStderr !== undefined },
          text => onStderr?.(index, text),
        ).then(result => {
          // A crashed or stopped worker could not close its pipe ends.
          if (result.crashed) {
            if (stdin) closePipe(stdin);
            if (stdout) closePipe(stdout);
          }
          return result;
        });
      }));
    } finally {
      run.stop = undefined;
    }
    const cancelled = run.cancelled;

    // Keep warm instances that ended normally; replace the others with fresh ones.
    instances.forEach((instance, index) => {
      if (!instance) return;
      const result = results[index];
      const tool = tools[index];
      if (isWarm[index] && !tool.reinit && !result.crashed && !result.brokenPipe && !cancelled) return;
      instance.terminate();
      if (isWarm[index]) {
        tool.warm = undefined;
        // Loading the replacement starts now; the next run waits for it.
        void this.warm(tool).catch(() => {});
      }
    });

    return combine(stages, results, cancelled);
  }

  /** The instance kept between runs, started if needed. */
  private warm(tool: Tool): Promise<ToolInstance> {
    if (!tool.warm) {
      const starting = this.spawn(tool);
      tool.warm = starting;
      starting.catch(() => {
        if (tool.warm === starting) tool.warm = undefined;
      });
    }
    return tool.warm;
  }

  private async spawn(tool: Tool): Promise<ToolInstance> {
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
      source = (async () => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
        // Dev servers and single-page hosts may answer a missing file with index.html.
        if (response.headers.get("content-type")?.includes("text/html")) {
          throw new Error(`Could not download ${url}: the server returned an HTML page, not the tool's JavaScript.`);
        }
        return response.text();
      })();
      source.catch(() => this.sources.delete(url));
      this.sources.set(url, source);
    }
    return source;
  }
}

function combine(stages: MayoStage[], results: MayoToolRunResult[], cancelled: boolean): MayoExecResult {
  const stageResults: MayoStageResult[] = results.map((result, index) => {
    const stage: MayoStageResult = { program: stages[index].program, pipeline: 0, exitCode: result.exitCode, stderr: result.stderr };
    if (result.remote) stage.remote = result.remote;
    if (result.brokenPipe) stage.brokenPipe = true;
    return stage;
  });
  const failed = results.find(result => result.exitCode !== 0 && !result.brokenPipe);
  const remotes = results.flatMap(result => result.remote ? [result.remote] : []);
  const combined: MayoExecResult = {
    stdout: results[results.length - 1].stdout,
    stderr: results.map(result => result.stderr).join(""),
    exitCode: cancelled ? CANCELLED_EXIT_CODE : failed?.exitCode ?? 0,
    stages: stageResults,
  };
  if (remotes.length > 0) {
    combined.remote = remotes.reduce((sum, remote) => ({ requests: sum.requests + remote.requests, bytes: sum.bytes + remote.bytes }));
  }
  if (cancelled) combined.cancelled = true;
  return combined;
}

/** The results of pipelines joined by `&&`, as one result: the exit code is the last one run. */
function chain(results: MayoExecResult[]): MayoExecResult {
  if (results.length === 1) return results[0];
  const last = results[results.length - 1];
  const remotes = results.flatMap(result => result.remote ? [result.remote] : []);
  const combined: MayoExecResult = {
    stdout: results.map(result => result.stdout).join(""),
    stderr: results.map(result => result.stderr).join(""),
    exitCode: last.exitCode,
    stages: results.flatMap(result => result.stages),
  };
  if (remotes.length > 0) {
    combined.remote = remotes.reduce((sum, remote) => ({ requests: sum.requests + remote.requests, bytes: sum.bytes + remote.bytes }));
  }
  if (last.cancelled) combined.cancelled = true;
  return combined;
}
