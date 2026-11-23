/** Messages between the coordinator (coordinator/tools.ts) and a tool worker (tool/worker.ts). */

import type { IOConnection } from "../io/protocol";
import type { Redirects } from "../../shared/command";
import type { MayoToolConfig } from "../protocol";
import type { RemoteStats } from "../shared/urls";

export type ToolRequest =
  /**
   * Load one Emscripten module. `source` is the tool's glue script; `wasm`, when given, is the
   * already compiled module (another instance of the same tool), so only instantiation remains.
   */
  | { type: "setup"; tool: MayoToolConfig; source: string; wasm?: WebAssembly.Module; io: IOConnection }
  /**
   * Run main() once. `stdin`/`stdout` are pipes (pipe/pipe.ts) to the neighbouring stages; a
   * redirect replaces them with a file. `folder`: mount the selected folder at /shared/data.
   * `liveStderr`: send stderr as it is printed, not only in the result.
   */
  | {
      type: "run";
      args: string[];
      redirects: Redirects;
      stdin?: SharedArrayBuffer;
      stdout?: SharedArrayBuffer;
      folder: boolean;
      liveStderr: boolean;
    };

export type ToolRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  remote?: RemoteStats;
  /** Stopped by writing to a pipe whose reader had exited (a shell's SIGPIPE). */
  brokenPipe: boolean;
  /** The module crashed or was stopped mid-run; its state cannot be trusted for another run. */
  crashed: boolean;
};

export type ToolResponse =
  | { type: "ready"; wasm: WebAssembly.Module }
  | { type: "failed"; message: string }
  | { type: "stderr"; text: string }
  | { type: "done"; result: ToolRunResult };
