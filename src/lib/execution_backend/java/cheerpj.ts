/**
 * CheerpJ runtime for Java tools: loads the CheerpJ loader once, starts a Java 21 JVM, and runs
 * one Java main method at a time through omics.cheerp.Launcher (see src/omics/cheerp).
 *
 * The JVM runs on the page's main thread and lives as long as the page. Java reaches JavaScript
 * through async native methods, which the Java thread waits for:
 *   - Stdio.*: System.out (fd 1) and System.err (fd 2), shown or redirected to a folder file
 *     (`>`, `>>`, `2>`, `2>>`), and System.in from a folder file (`<`).
 *   - Launcher.exit(status): the exit code (System.exit is caught so files can be copied back).
 *   - Folder.*: the selected folder (folder.ts).
 *
 * Files: Java's working directory is CheerpJ's /files/ mount. Before a run, Launcher copies the
 * input files into it; after the run, it copies new and changed files back to the folder.
 */

import { parsePipeline, type Redirects, type Stage } from "../shared/command";
import { folderPath, getDirectory, getFile, openWritable, requireFolderPath } from "../shared/folder";
import { abortWrites, folderNatives, inputsForArgs, newFolderSession, type FolderSession } from "./folder";

const LOADER_URL = "https://cjrtnc.leaningtech.com/5.0/loader.js";
const JAVA_VERSION = 21;
/** /app/ is the root of the web server; public/java/ is served at BASE_URL + "java/". */
const HELPER_JAR = `/app${import.meta.env.BASE_URL}java/omics-cheerp.jar`;

/** Java tools bundled with the site, in public/java/<name>/<version>/<name>.jar. */
export const JAVA_TOOLS = [
  { name: "gatk", version: "4.6.2.0" },
  { name: "snpeff", version: "5.4c" },
  { name: "snpsift", version: "5.4c" },
  { name: "trimmomatic", version: "0.40" },
  { name: "beagle", version: "5.5-27Feb25.75f" },
  { name: "fastqc", version: "0.13.0" },
] as const;

/** The parts of the CheerpJ API used here (the loader defines them as globals). */
type CheerpJLibrary = unknown;
declare global {
  function cheerpjInit(options?: {
    version?: number;
    status?: "splash" | "none" | "default";
    natives?: Record<string, (...args: never[]) => unknown>;
    javaProperties?: string[];
  }): Promise<void>;
  function cheerpjRunMain(className: string, classPath: string, ...args: string[]): Promise<number>;
  function cheerpjCreateDisplay(width: number, height: number, parent?: HTMLElement): HTMLElement;
  function cheerpOSAddStringFile(path: string, data: string | Uint8Array): void;
  var __omicsWayfinderCheerpJRuntime: RuntimeState | undefined;
}

export type JavaOutput = (fd: 1 | 2, text: string) => void;

export type JavaRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  seconds: number;
  /** Folder files copied into /files/ before the run. */
  inputs: string[];
  /** Files written back to the folder after the run, and redirect targets. */
  written: string[];
};

export type JavaRunOptions = {
  folder?: FileSystemDirectoryHandle;
  /** Folder files to copy into /files/ before the run. */
  inputs?: string[];
  /** `<`, `>`, `>>`, `2>`, `2>>`: folder files (needs `folder`). */
  redirects?: Redirects;
  onOutput?: JavaOutput;
};

/** A redirected stdout or stderr: the open folder file. */
type Sink = { path: string; writer: FileSystemWritableFileStream };

/** What the natives of the current run talk to. Runs never overlap (see `queue`). */
type RunContext = {
  output: JavaOutput;
  decoders: Record<1 | 2, TextDecoder>;
  sinks: Partial<Record<1 | 2, Sink>>;
  stdin: string;
  exitCode?: number;
  folder: FolderSession | null;
};
type RuntimeState = {
  current: RunContext | null;
  ready: Promise<void> | null;
  queue: Promise<unknown>;
  nextJar: number;
  fastqcDisplay?: HTMLElement;
};

// CheerpJ and its native callbacks outlive this module when Vite reloads it.
const runtime = globalThis.__omicsWayfinderCheerpJRuntime ??= {
  current: null,
  ready: null,
  queue: Promise.resolve(),
  nextJar: 0,
};

const natives = {
  async Java_omics_cheerp_Stdio_write(_lib: CheerpJLibrary, fd: number, data: Int8Array, length: number) {
    if (!runtime.current) return;
    const stream = fd === 2 ? 2 : 1;
    // `data` is a view of Java's array: copy it before awaiting.
    const bytes = new Uint8Array(data.buffer, data.byteOffset, length).slice();
    const sink = runtime.current.sinks[stream];
    if (sink) await sink.writer.write(bytes);
    else runtime.current.output(stream, runtime.current.decoders[stream].decode(bytes, { stream: true }));
  },
  async Java_omics_cheerp_Stdio_redirected(_lib: CheerpJLibrary, fd: number): Promise<boolean> {
    return runtime.current?.sinks[fd === 2 ? 2 : 1] !== undefined;
  },
  async Java_omics_cheerp_Stdio_stdin(): Promise<string> {
    return runtime.current?.stdin ?? "";
  },
  async Java_omics_cheerp_Launcher_exit(_lib: CheerpJLibrary, status: number) {
    if (runtime.current) runtime.current.exitCode = status;
  },
  ...folderNatives(() => runtime.current?.folder ?? null),
};

function loadScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Could not load ${url}`));
    document.head.append(script);
  });
}

/** Loads CheerpJ and starts the JVM; later calls reuse it. A failed start can be retried. */
export function initCheerpJ(): Promise<void> {
  runtime.ready ??= (async () => {
    if (typeof cheerpjInit !== "function") await loadScript(LOADER_URL);
    await cheerpjInit({ version: JAVA_VERSION, status: "none", natives, javaProperties: ["java.security.manager=allow"] });
  })().catch((error: unknown) => {
    runtime.ready = null;
    throw error;
  });
  return runtime.ready;
}

/**
 * Runs `mainClass` with the helper jar on the class path. Output goes to `onOutput` as it is
 * printed and is also returned. Calls are queued: the JVM runs one main at a time.
 */
export function runJava(mainClass: string, args: string[], options: JavaRunOptions = {}): Promise<JavaRunResult> {
  const run = runtime.queue.then(async () => {
    await initCheerpJ();
    const output = { 1: "", 2: "" };
    const folder = options.folder ? newFolderSession(options.folder, options.inputs) : null;
    const context: RunContext = {
      folder,
      output: (fd, text) => {
        if (!text) return;
        output[fd] += text;
        options.onOutput?.(fd, text);
      },
      decoders: { 1: new TextDecoder(), 2: new TextDecoder() },
      sinks: {},
      stdin: "",
    };
    const start = performance.now();
    let finished = false;
    try {
      if (options.redirects) await openRedirects(context, options.redirects);
      runtime.current = context;
      const returned = await cheerpjRunMain("omics.cheerp.Launcher", HELPER_JAR, mainClass, ...args);
      if (context.exitCode === undefined && returned === 0) {
        throw new Error("Java launcher stopped before reporting an exit code.");
      }
      finished = true;
      for (const fd of [1, 2] as const) context.output(fd, context.decoders[fd].decode());
      return {
        exitCode: context.exitCode ?? returned,
        stdout: output[1],
        stderr: output[2],
        seconds: (performance.now() - start) / 1000,
        inputs: folder?.inputs ?? [],
        written: folder?.written ?? [],
      };
    } finally {
      runtime.current = null;
      // Like a shell, a redirect target is written even if the tool failed.
      for (const sink of new Set(Object.values(context.sinks))) {
        if (finished) {
          await sink.writer.close();
          folder?.written.push(sink.path);
        } else {
          await sink.writer.abort().catch(() => undefined);
        }
      }
      if (folder) await abortWrites(folder);
    }
  });
  runtime.queue = run.catch(() => undefined);
  return run;
}

async function openRedirects(context: RunContext, redirects: Redirects): Promise<void> {
  const folder = context.folder?.folder;
  if (!folder) throw new Error("Redirections need a folder.");
  if (redirects.stdin !== undefined) {
    await getFile(folder, redirects.stdin).catch(() => {
      throw new Error(`${redirects.stdin}: no such file in the folder.`);
    });
    context.stdin = redirects.stdin;
  }
  const { stdout, stderr } = redirects;
  if (stdout && stderr && folderPath(stdout.path)?.join("/") === folderPath(stderr.path)?.join("/")) {
    throw new Error(`stdout and stderr cannot both go to "${stdout.path}".`);
  }
  for (const [fd, target] of [[1, stdout], [2, stderr]] as const) {
    if (target) context.sinks[fd] = { path: target.path, writer: await openWritable(folder, target.path, target.append) };
  }
}

/** Prints the selected folder (or `path` inside it) as a tree, from Java. */
export function javaFolderTree(folder: FileSystemDirectoryHandle, path = "", onOutput?: JavaOutput): Promise<JavaRunResult> {
  return runJava("omics.cheerp.FolderTree", path ? [path] : [], { folder, onOutput });
}

/**
 * Runs a jar from the selected folder like `java -jar <jar> args...`, with the folder as the
 * working directory: the files named in `args` are copied in, and new or changed files are
 * copied back (see inputsForArgs). The jar itself goes to CheerpJ's in-memory /str/ mount, at a
 * new path each call so a changed jar is not cached.
 */
export async function runJarFromFolder(
  folder: FileSystemDirectoryHandle,
  jarPath: string,
  args: string[],
  onOutput?: JavaOutput,
  redirects?: Redirects,
): Promise<JavaRunResult> {
  const file = await getFile(folder, jarPath);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const inputs = await inputsForArgs(folder, args);
  await initCheerpJ();
  const path = `/str/jar-${runtime.nextJar++}-${file.name}`;
  cheerpOSAddStringFile(path, bytes);
  return runJava("-jar", [path, ...args], { folder, inputs, redirects, onOutput });
}

/** Runs a bundled tool, keeping input, output and redirect paths in the selected folder. */
export async function runPublicToolCommand(folder: FileSystemDirectoryHandle, command: string, onOutput?: JavaOutput): Promise<JavaRunResult> {
  const { program, args, redirects } = singleStage(command);
  const tool = JAVA_TOOLS.find(tool => tool.name === program);
  if (!tool) throw new Error(`Unknown bundled Java tool: "${program}".`);
  const jar = `/app${import.meta.env.BASE_URL}java/${tool.name}/${tool.version}/${tool.name}.jar`;
  const adapterPaths = tool.name === "trimmomatic"
    ? args.filter(arg => arg.startsWith("ILLUMINACLIP:")).map(arg => arg.split(":")[1])
    : [];
  const toolArgs = tool.name === "fastqc" ? normalizeFastqcArgs(args) : args;
  const inputArgs = tool.name === "fastqc" ? await fastqcInputs(folder, toolArgs) : toolArgs;
  const inputs = await inputsForArgs(folder, [...inputArgs, ...adapterPaths]);
  if (tool.name === "fastqc") {
    await initCheerpJ();
    if (!runtime.fastqcDisplay) {
      const parent = document.createElement("div");
      parent.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden";
      document.body.append(parent);
      try {
        cheerpjCreateDisplay(1, 1, parent);
        runtime.fastqcDisplay = parent;
      } catch (error) {
        parent.remove();
        throw error;
      }
    }
  }
  return runJava("-jar", [jar, ...toolArgs], { folder, inputs, redirects, onOutput });
}

function normalizeFastqcArgs(args: string[]): string[] {
  const valueOptions = new Set(["--outdir", "--threads", "--contaminants", "--adapters", "--limits", "--format", "--min_length", "--max_length", "--dup_length"]);
  let positional = false;
  return args.flatMap(arg => {
    if (arg === "--") positional = true;
    const equals = arg.indexOf("=");
    if (!positional && equals > 0 && valueOptions.has(arg.slice(0, equals))) return [arg.slice(0, equals), arg.slice(equals + 1)];
    return [arg];
  });
}

async function fastqcInputs(folder: FileSystemDirectoryHandle, args: string[]): Promise<string[]> {
  const inputs: string[] = [];
  let positional = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") positional = true;
    if (!positional && (arg === "-o" || arg === "--outdir")) {
      const directory = args[++i];
      if (!directory) throw new Error(`Missing value for ${arg}.`);
      const parts = requireFolderPath(directory);
      if ([".tmp", "uploads", "downloads"].includes(parts[0])) throw new Error(`FastQC cannot use the reserved directory "${parts[0]}".`);
      await getDirectory(folder, parts);
    } else {
      const parts = folderPath(arg);
      if (parts && [".tmp", "uploads", "downloads"].includes(parts[0])) throw new Error(`FastQC cannot use the reserved directory "${parts[0]}".`);
      inputs.push(arg);
    }
  }
  return inputs;
}

/**
 * Runs `<jar> args...` with Mayo's redirections, e.g. `VarScan.jar mpileup2snp x.pileup > snps.txt`.
 * The first word is the jar's path in the folder. Pipes are not supported yet.
 */
export async function runJarCommand(folder: FileSystemDirectoryHandle, command: string, onOutput?: JavaOutput): Promise<JavaRunResult> {
  const { program, args, redirects } = singleStage(command);
  return runJarFromFolder(folder, program, args, onOutput, redirects);
}

function singleStage(command: string): Stage {
  const stages = parsePipeline(command);
  if (stages.length > 1) throw new Error("Pipes are not supported for Java tools yet.");
  return stages[0];
}
