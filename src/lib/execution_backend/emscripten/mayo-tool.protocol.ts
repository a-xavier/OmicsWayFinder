/** Messages between the Mayo coordinator (mayo.worker.ts) and a tool worker (mayo-tool.worker.ts). */

import type { MayoIOConnection } from "./mayo-io.protocol";
import type { MayoRedirect, MayoToolConfig } from "./mayo.protocol";

export type MayoToolRequest =
  /**
   * Load one Emscripten module. `source` is the tool's glue script; `wasm`, when given, is the
   * already compiled module (another instance of the same tool), so only instantiation remains.
   */
  | { type: "setup"; tool: MayoToolConfig; source: string; wasm?: WebAssembly.Module; io: MayoIOConnection }
  /**
   * Run main() once. `stdin`/`stdout` are pipes (mayo-pipe.ts) to the neighbouring stages; a
   * redirect replaces them with a file. `folder`: mount the selected folder at /shared/data.
   * `liveStderr`: send stderr as it is printed, not only in the result.
   */
  | {
      type: "run";
      args: string[];
      redirects: MayoStageRedirects;
      stdin?: SharedArrayBuffer;
      stdout?: SharedArrayBuffer;
      folder: boolean;
      liveStderr: boolean;
    };

export type MayoStageRedirects = { stdin?: string; stdout?: MayoRedirect; stderr?: MayoRedirect };

export type MayoToolRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  remote?: { requests: number; bytes: number };
  /** Stopped by writing to a pipe whose reader had exited (a shell's SIGPIPE). */
  brokenPipe: boolean;
  /** The module crashed or was stopped mid-run; its state cannot be trusted for another run. */
  crashed: boolean;
};

export type MayoToolResponse =
  | { type: "ready"; wasm: WebAssembly.Module }
  | { type: "failed"; message: string }
  | { type: "stderr"; text: string }
  | { type: "done"; result: MayoToolRunResult };
