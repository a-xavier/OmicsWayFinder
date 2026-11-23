/**
 * Running commands (in the Mayo worker).
 *
 * A command is a list of pipelines joined by `&&`: each pipeline runs only if the previous one
 * succeeded, as in a shell. In a pipeline every stage runs in its own tool worker at the same
 * time as the others, connected stdout to stdin by pipes (pipe/pipe.ts).
 *
 * The coordinator itself never calls main(), so it stays free to start workers, forward live
 * stderr and cancel a run.
 */

import type { IOClient } from "../io/client";
import { closePipe, createPipe } from "../pipe/pipe";
import type { Stage } from "../../shared/command";
import type { MayoExecResult, MayoStageResult } from "../protocol";
import { addStats, URL_PATTERN, type RemoteStats } from "../shared/urls";
import type { ToolRunResult } from "../tool/protocol";
import type { RemoteChecker } from "./remote";
import { CANCELLED_EXIT_CODE, failedRun, type Tool, type ToolInstance, type ToolRegistry } from "./tools";

/** The running command; `stop` is set while one of its pipelines runs. */
type CommandRun = { cancelled: boolean; stop?: () => void };

type StderrListener = (stage: number, text: string) => void;

export class CommandRunner {
  private readonly tools: ToolRegistry;
  private readonly io: IOClient;
  private readonly checker: RemoteChecker;
  private current: CommandRun | undefined;

  constructor(tools: ToolRegistry, io: IOClient, checker: RemoteChecker) {
    this.tools = tools;
    this.io = io;
    this.checker = checker;
  }

  /** Stop the running command, if any. Returns false if nothing was running. */
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
  async exec(pipelines: Stage[][], onStderr?: StderrListener): Promise<MayoExecResult> {
    if (pipelines.length === 0 || pipelines.some(stages => stages.length === 0)) throw new Error("Expecting a command.");
    // Check every program first, rather than failing after earlier pipelines have run.
    const tools = pipelines.map(stages => stages.map(stage => this.tools.find(stage.program)));
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
  private async runPipeline(stages: Stage[], tools: Tool[], run: CommandRun, onStderr?: StderrListener): Promise<MayoExecResult> {
    // Like a shell's failed redirection: a stage with an unusable URL does not run, and its
    // neighbours see end of file or EPIPE.
    const failures = await Promise.all(stages.map(stage => this.checkUrls(stage.args)));

    // The warm instance for a program's first stage; extra instances for repeats.
    const instances: (ToolInstance | undefined)[] = [];
    const isWarm: boolean[] = [];
    const used = new Set<Tool>();
    try {
      for (const [index, tool] of tools.entries()) {
        if (failures[index] !== undefined) continue;
        isWarm[index] = !used.has(tool);
        used.add(tool);
        instances[index] = isWarm[index] ? await this.tools.warm(tool) : await this.tools.spawn(tool);
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
    let results: ToolRunResult[];
    try {
      results = await Promise.all(stages.map(async (stage, index) => {
        const stdin = index > 0 ? pipes[index - 1] : undefined;
        const stdout = index < pipes.length ? pipes[index] : undefined;
        const closeEnds = () => {
          if (stdin) closePipe(stdin);
          if (stdout) closePipe(stdout);
        };
        const instance = instances[index];
        if (!instance) {
          closeEnds();
          return failedRun(failures[index]!, 1, false);
        }
        const result = await instance.run(
          { type: "run", args: stage.args, redirects: stage.redirects, stdin, stdout, folder: this.io.folder, liveStderr: onStderr !== undefined },
          text => onStderr?.(index, text),
        );
        // A crashed or stopped worker could not close its pipe ends.
        if (result.crashed) closeEnds();
        return result;
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
      if (isWarm[index]) this.tools.replaceWarm(tool);
    });

    return combine(stages, results, cancelled);
  }

  /** Check the URLs in a stage's arguments. Returns an error message for stderr, or undefined. */
  private async checkUrls(args: string[]): Promise<string | undefined> {
    for (const url of new Set(args.flatMap(arg => arg.match(URL_PATTERN) ?? []))) {
      try {
        await this.checker.check(url);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }
    return undefined;
  }
}

/** The results of one pipeline's stages, as one result: like a shell with pipefail. */
function combine(stages: Stage[], results: ToolRunResult[], cancelled: boolean): MayoExecResult {
  const stageResults: MayoStageResult[] = results.map((result, index) => {
    const stage: MayoStageResult = { program: stages[index].program, pipeline: 0, exitCode: result.exitCode, stderr: result.stderr };
    if (result.remote) stage.remote = result.remote;
    if (result.brokenPipe) stage.brokenPipe = true;
    return stage;
  });
  // A stage stopped by a broken pipe does not fail the pipeline (`… | head`).
  const failed = results.find(result => result.exitCode !== 0 && !result.brokenPipe);
  const exitCode = cancelled ? CANCELLED_EXIT_CODE : failed?.exitCode ?? 0;
  return joinResults(results, results[results.length - 1].stdout, exitCode, stageResults, cancelled);
}

/** The results of pipelines joined by `&&`, as one result: the exit code is the last one run. */
function chain(results: MayoExecResult[]): MayoExecResult {
  if (results.length === 1) return results[0];
  const last = results[results.length - 1];
  const stdout = results.map(result => result.stdout).join("");
  return joinResults(results, stdout, last.exitCode, results.flatMap(result => result.stages), last.cancelled ?? false);
}

/** A result made of several parts (stages or pipelines): their stderr joined, their statistics summed. */
function joinResults(
  parts: { stderr: string; remote?: RemoteStats }[],
  stdout: string,
  exitCode: number,
  stages: MayoStageResult[],
  cancelled: boolean,
): MayoExecResult {
  const result: MayoExecResult = { stdout, stderr: parts.map(part => part.stderr).join(""), exitCode, stages };
  const remote = addStats(parts.map(part => part.remote));
  if (remote) result.remote = remote;
  if (cancelled) result.cancelled = true;
  return result;
}
