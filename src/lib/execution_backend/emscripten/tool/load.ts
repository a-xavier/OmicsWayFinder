/** Loading a biowasm program (Emscripten glue + WebAssembly) in a tool worker. */

import type { MayoToolConfig } from "../protocol";
import { fetchFile } from "../shared/urls";
import type { EmscriptenFactory, EmscriptenModule } from "./emscripten";

/** The glue's output and exit hooks. */
export type ModuleHooks = {
  /** A line the program printed to the terminal's stdout (normally stdout goes through the Mayo device). */
  print(line: string): void;
  /** A line printed to stderr. */
  printErr(line: string): void;
  /** Every exit goes through here: main() returning, exit(), or a crash. */
  exit(status: number): void;
};

/**
 * Create the module. `source` is the glue script; `wasm`, when given, is the module compiled by
 * another instance of the same tool, so only instantiation remains. Returns the module and the
 * compiled WebAssembly, for the next instance.
 */
export async function loadModule(
  tool: MayoToolConfig,
  source: string,
  wasm: WebAssembly.Module | undefined,
  hooks: ModuleHooks,
): Promise<{ module: EmscriptenModule; wasm: WebAssembly.Module }> {
  // Module workers cannot use importScripts, so evaluate the classic glue script, which declares
  // `var Module = <factory>`.
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
            const response = await fetchFile(url);
            compiled = await WebAssembly.compile(await response.arrayBuffer());
          }
        }
        receive(await WebAssembly.instantiate(compiled, imports), compiled);
      })().catch(failInstantiate);
      return {};
    },
    print: hooks.print,
    printErr: hooks.printErr,
    stdin: () => null,
    // Rethrowing keeps the glue's own control flow intact.
    quit: (status: number, toThrow: unknown) => {
      hooks.exit(status);
      throw toThrow;
    },
  });
  const module = await Promise.race([created, instantiated]);
  return { module, wasm: compiled! };
}
