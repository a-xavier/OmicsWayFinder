# Emscripten Backend

## Goal

Run existing bioinformatics tools compiled with Emscripten in the browser without rewriting their scientific code. The backend should expose a command-like interface, connect inputs and outputs to the workflow engine, and eventually support persistent, resumable execution.

## Mayo

`Mayo` is the Emscripten backend runtime, inspired by [Aioli](https://github.com/biowasm/aioli). Unlike Aioli, it works directly in a folder the user selects on their own computer instead of an in-memory filesystem. It currently scans the folder, reads, writes and removes files, and loads and runs biowasm tools, alone or as streaming pipelines (`minimap2 … | samtools sort …`). Tools see the selected folder at `/shared/data` (their working directory) and can read and write it, so relative paths such as `samtools index reads.bam` work on the real files.

### Usage

```ts
import { Mayo } from "./mayo";

const mayo = new Mayo();                           // starts the Mayo worker; no arguments
const directory = await window.showDirectoryPicker({ mode: "readwrite" });
const tree = await mayo.init(directory);           // scans the folder, starts file I/O
const bytes = await mayo.readFile("reads/sample.fastq");
const updated = await mayo.refreshTree();          // rescan after external changes
await mayo.loadTools(["samtools/1.10"]);           // biowasm CDN, Aioli syntax
const { stdout, stderr, exitCode } = await mayo.exec("samtools --version");
await mayo.exec("samtools view -h reads.bam | samtools sort -o sorted.bam -", {
  onStderr: (text, stage) => console.log(stage, text),   // live stderr, optional
});
await mayo.exec("samtools sort -o s.bam in.sam && samtools index s.bam");  // index only if sort succeeded
await mayo.cancel();                               // stop the running exec, if any
mayo.close();                                      // stop the workers, reject pending calls
```

| Method | Status | Description |
|---|---|---|
| `init(directory)` | Done | Recursively lists the folder (names, sizes, no contents) and starts the I/O worker. A failed init keeps the previous root and tree. |
| `getTree()` | Done | Returns the last tree snapshot. |
| `refreshTree()` | Done | Rescans the current folder. A failed refresh keeps the previous snapshot. |
| `readFile(path)` | Done | Reads a whole file relative to the folder. Needs cross-origin isolation. |
| `writeFile(path, data)` | Done | Creates or replaces a whole file. Parent folders must exist. The original stays intact if the write fails. Needs cross-origin isolation. Call `refreshTree()` to see the change. |
| `removeFile(path)` | Done | Removes one file, like `unlink()`. Directories are refused. Needs cross-origin isolation. Call `refreshTree()` to see the change. |
| `loadTools(specs)` | Done | Downloads and sets up tools, each in its own worker (Aioli syntax, see [Tools](#tools)). Can be called again to add tools. Returns all loaded tools. Does not need `init`, but needs cross-origin isolation. |
| `exec(command, options?)` | Done | Runs a loaded program, or a pipeline of them (`a \| b \| c`, see [Pipes](#pipes)), or pipelines joined by `&&` (see [Chaining with &&](#chaining-with-)), and returns `{ stdout, stderr, exitCode, stages }`. `command` is split on whitespace (no quoting); `\|`, `&&`, `<`, `>`, `>>`, `2>`, `2>>` are applied (see [Redirecting Output](#redirecting-output)). `options.onStderr(text, stage)` receives stderr as it is printed. The selected folder is mounted at `/shared/data`, the working directory (see [Tools and the Selected Folder](#tools-and-the-selected-folder)). |
| `exec(program, args, redirects?, options?)` | Done | Runs one program with exact arguments (no splitting) and redirections. |
| `cancel()` | Done | Stops the running `exec`: its workers are terminated, the pipelines after `&&` do not start, and it resolves with exit code 130 and `cancelled: true`. Does nothing when idle. |
| `addUrl(url, path?)` | Done | Adds a remote file to the folder as a URL link, without downloading it (checks CORS and range support first). Tools then use `path` (default: the URL's file name) like any file. Does not need a loaded tool. Returns `{ path, size }`. See [Remote Files (URLs)](#remote-files-urls). |
| `download(url, path?)` | Done | Streams a URL into the selected folder (1 MiB at a time, never whole in memory). `path` defaults to the URL's file name. Returns `{ path, bytes }`. |
| `close()` | Done | Terminates all Mayo workers and rejects pending requests. |

The tree is a `MayoDirectory` whose `children` are `MayoFile` or `MayoDirectory` entries (`protocol.ts`). The root is always a directory.

The caller selects the directory and handles browser support and permission prompts. The File System Access directory picker is only available in Chromium browsers (Chrome, Edge). The handle is not persisted between sessions yet.

### Architecture

Mayo runs in four kinds of thread. Each folder of this directory holds the code of one of them:

```text
main thread (React UI)
   │  mayo.ts: async API, postMessage
   ▼
coordinator/ ── one worker: folder tree, tool registry, runs commands (never runs a tool itself)
   │  starts                         │  starts
   ▼                                 ▼
tool/ ×N ── one worker per          io/ ── one worker: every file and remote read, for all clients
 Emscripten instance                  ▲   one channel (SharedArrayBuffer + MessagePort) per client:
   │                                  │   every tool worker, and the coordinator itself
   │  stage k stdout ══ pipe/ (ring buffer in a SharedArrayBuffer) ══▶ stage k+1 stdin
```

A command's journey: `mayo.exec("a | b && c")` → `../shared/command.ts` parses it into pipelines → the coordinator (`coordinator/runner.ts`) checks URLs, takes a worker per stage from the registry (`coordinator/tools.ts`) and connects them with pipes → each tool worker (`tool/worker.ts`) mounts the folder and URLs, sets up stdin/stdout/stderr and calls `main()` → file calls block on the I/O worker (`io/`) → results go back up and are combined.

| File | Role |
|---|---|
| **Top level** (main thread) | |
| `mayo.ts` | `Mayo`, the public API. Sends requests to the coordinator and matches replies by id. |
| `protocol.ts` | Public types (tree, tools, stages, results) and main ↔ coordinator messages. |
| **`coordinator/`** (the Mayo worker) | |
| `worker.ts` | Message loop: one request at a time (except `cancel`), routed to the classes below. |
| `tools.ts` | `ToolRegistry` (loaded tools, warm workers, glue downloads) and `ToolInstance` (one tool worker seen from here). |
| `runner.ts` | `CommandRunner`: runs `&&` chains and pipelines, cancel, combines stage results. |
| `folder-tree.ts` | `FolderTree`: scans the folder into a tree for display. |
| `remote.ts` | `RemoteChecker` (checks URLs before use), `linkUrl` (`addUrl`) and `downloadToFolder` (`download`). |
| **`tool/`** (one worker per Emscripten instance) | |
| `worker.ts` | Message loop and one run: mount, redirect, `callMain`, flush, save, report. |
| `protocol.ts` | Coordinator ↔ tool worker messages. |
| `load.ts` | `loadModule`: evaluates the biowasm glue and instantiates the `.wasm` (compiled once per tool). |
| `mounts.ts` | `Mounts`: the folder at `/shared/data` and URLs at `/shared/urls/<n>`. |
| `stdio.ts` | `Stdio`: `/dev/stdin` and `/dev/stdout` devices (pipes or captured output), redirections, broken pipes. |
| `output.ts` | `RunOutput`: captured stdout/stderr (16 MiB cap) and live stderr. |
| `folder-fs.ts` | `FOLDERFS`: Emscripten filesystem for the selected folder, on top of `IOClient`; also follows URL links. |
| `url-fs.ts` | `URLFS`: read-only Emscripten filesystem for URLs typed in commands. |
| `remote-files.ts` | `RemoteFiles`: a tool's remote stats and range reads (with read-ahead) through the I/O worker. |
| `emscripten.ts` | Emscripten types, errno codes and helpers shared by the two filesystems (`createFSNode`, `nodeAttributes`, `seekPosition`). |
| **`io/`** (the I/O worker, and its clients) | |
| `worker.ts` | Performs the asynchronous File System Access calls and remote reads for every client. |
| `protocol.ts` | Shared-memory layout (`connectionViews`, `DATA_CAPACITY`), remote chunk sizes, I/O requests, control messages and shared error messages. |
| `host.ts` | `IOHost` (coordinator): starts the I/O worker, sets the folder, creates one connection per client. |
| `client.ts` | `IOClient`: synchronous calls to the I/O worker (`Atomics.wait`), used by the coordinator and every tool worker. `WriteBuffer` collects small writes into 1 MiB blocks (FOLDERFS, `download`). |
| `remote-cache.ts` | `RemoteCache`: range requests and a 64 MiB chunk cache shared by every tool. |
| **`pipe/`** | |
| `pipe.ts` | The ring buffer between two stages. Tested by `pipe.test.mjs`. |
| **`shared/`** (used by several threads) | |
| `urls.ts` | URL helpers and types (`headRemoteFile`, `fetchFile`, `splitUrl`, `urlFileName`, `RemoteFile`, …). |
| `url-links.ts` | The link file format (`mayo-url <url>`) and which files can be links (`mayBeLink`). |

The command parser (`parseCommand` / `parsePipeline`, with the `Stage` and `Redirects` types), the folder path helpers used by the I/O worker, and the folder picker and store are not Mayo-specific: they live in [../shared](../shared), shared with the Java backend.

### Remembering the Folder

`../shared/folder-store.ts` saves the selected folder's handle so the next visit can reopen it without the folder picker:

```ts
import { folderPermission, forgetFolder, loadFolder, pickFolder, requestFolderPermission, saveFolder } from "../shared/folder-store";

const directory = await pickFolder();              // in a click; null if cancelled
await saveFolder(directory);
const saved = await loadFolder();                  // on page load; undefined if none
if (saved && (await folderPermission(saved)) === "granted") await mayo.init(saved);
// otherwise, in a click handler:
if (await requestFolderPermission(saved)) await mayo.init(saved);
await forgetFolder();
```

- The handle is stored in IndexedDB (database `mayo`, store `handles`, key `folder`). localStorage and sessionStorage only hold strings, so they cannot store handles. Only the reference is stored, never file contents, and it is only usable by this site.
- The permission is not stored. On a new visit it is usually `"prompt"`, and `requestPermission` only works during a click, so the page shows "Reconnect to <name>". The Chrome prompt is a small permission bar, not the folder picker.
- Chrome may offer "Allow on every visit" when permission is granted again. If the user accepts, permission is already `"granted"` on load and the folder is initialized with no click.
- If the folder was deleted or moved, `init` fails with `NotFoundError`; the tester then forgets it.
- The test bench saves the folder when it is chosen, initializes it on load when permission is granted, and has "Reconnect" and "Forget folder" buttons.

### Threads

- The UI thread never blocks: every `Mayo` method is async.
- The coordinator processes one request at a time, in arrival order, so a rescan and a read cannot race. `cancel` skips the queue so it can reach the running `exec`.
- The coordinator never calls `callMain`: each loaded program has a warm tool worker, and every stage of a pipeline runs in its own worker at the same time (see [Pipes](#pipes)).
- Clients block with `Atomics.wait` on their own channel while the I/O worker `await`s the browser, so tools running together do not wait for each other's file calls.
- Tools stay single-threaded (no Emscripten pthreads); only pipeline stages run in parallel. One `exec` runs at a time.
- Errors are sent back as `{ name, message }` and rethrown by `mayo.ts`. If the coordinator crashes, all pending calls are rejected; a crashed tool worker fails its stage and is replaced.

### Tools

Tools are loaded with the same spec syntax as Aioli:

```ts
await mayo.loadTools([
  "samtools/1.10",                                   // tool/version → program "samtools"
  "seqtk/1.3",
  { tool: "samtools", version: "1.21", urlPrefix: "tools/samtools/1.21" }, // self-hosted copy
  { tool: "seqtk", version: "1.3", loading: "lazy", reinit: true },
]);
```

| Field | Default | Meaning |
|---|---|---|
| `tool` | required | Tool name; also the file name (`<program>.js`, `.wasm`, `.data`). |
| `version` | required | Version, used in the CDN URL. |
| `program` | `tool` | Program name, for tools with several programs (string form `tool/program/version`). |
| `urlPrefix` | `https://biowasm.com/cdn/v3/<tool>/<version>` | Folder holding the files. Relative prefixes resolve against the page (`document.baseURI`), so they work under the GitHub Pages base path. |
| `loading` | `"eager"` | `"lazy"` downloads the tool on its first `exec`. |
| `reinit` | `false` | Re-create the module after each `exec` (for tools that keep global state between runs). |

Self-hosted tools live in `public/tools/<tool>/<version>/`, which Vite copies to the build. These folders are excluded from oxlint (`.oxlintrc.json`).

Every tool on the biowasm CDN is self-hosted, at its latest version (47 tools, 134 programs, about 170 MB). `npm run fetch:tools` (`scripts/fetch-biowasm-tools.mjs`) downloads them:

- The tool list, versions, programs and files come from [`biowasm.json`](https://github.com/biowasm/biowasm/blob/main/biowasm.json), the config biowasm builds the CDN from. The last listed version is used.
- Each program has `<program>.js` and `<program>.wasm`; tools whose config lists `data` also have `<program>.data` (sample files and preloaded data).
- `aioli` and `base` are skipped: they are Aioli's own library and base module, not command-line tools.
- Files already present are not downloaded again unless `--overwrite` is passed. `npm run fetch:tools -- bcftools seqtk` downloads only those tools; `npm run build:tools` overwrites all BioWasm files and builds GATK.
- It writes `public/tools/manifest.json` (`tool`, `version`, `programs`, `description`), which the test bench reads to list the tools.

The test bench lists the manifest as checkboxes (one per tool, plus one per program for tools with several), with a filter and a choice between the local copy and the CDN. The Load button loads all ticked programs that are not loaded yet in one call (ticked programs that are already loaded are skipped and listed in the log); loading again adds tools. A "Loaded" list under the button shows every registered program with its tool, version, source (local or CDN), and lazy status.

How it works (same model as Aioli, but one worker per program):

- The biowasm `<program>.js` glue is a classic script. Module workers cannot use `importScripts`, so the coordinator fetches the text once and each tool worker evaluates it with `new Function`. The `.wasm` and `.data` files are located next to it with `locateFile`.
- The first worker of a program compiles the `.wasm` (`WebAssembly.compileStreaming`) and sends the `WebAssembly.Module` back; later instances of that program get it through `instantiateWasm` and skip the download and compilation.
- The biowasm CDN sends `Access-Control-Allow-Origin: *`, so it loads under COEP `require-corp`.
- Each loaded program keeps one **warm** worker between runs (started at load, or on the first `exec` for `lazy` tools). It is replaced after a run if the tool is `reinit`, crashed, was stopped by a broken pipe or was cancelled.
- Every worker has its own in-memory filesystem: `/shared/data` is the selected folder (the working directory), and `/tmp` and the sample data are private to the worker. Files that tools exchange go in the folder or through a pipe.
- Each tool's sample data (`/<tool>` in its `.data` package) is exposed at `/shared/<tool>`, for example `/shared/samtools/examples/toy.sam`. Only that tool sees it.
- Exit codes: `callMain` returns nothing, so `Module.quit` is overridden to record the status. A crash gives exit code 1 and the error is appended to stderr. Modules stay alive between runs (`noExitRuntime`).
- stdin, stdout and stderr are character devices (`/dev/stdin`, `/dev/stdout`) reopened as fd 0/1/2 before each run: a pipe, a redirection file, or the captured output (stdin: end of file). stdout is decoded to text only at the end, so binary output is not mangled.
- stdout and stderr are each capped at 16 MiB per run (`OUTPUT_LIMIT`). The rest is dropped and a `[Mayo] … was cut` line is added to stderr. Without the cap, `samtools view big.bam` (gigabytes of SAM text, all kept in memory and copied to the page) crashed the tab. Large outputs belong in files (`-o` or `>`) or the next stage of a pipe.
- A program that is already loaded from the same tool and version is skipped (also when listed twice in one call). The same program name from another tool or version is rejected, since `exec` finds programs by name. If one tool in a `loadTools` call fails, the whole call is rolled back.
- A wrong URL usually returns the dev server's or GitHub Pages' HTML page; `ToolRegistry` detects it and reports which URL failed.

### Tools and the Selected Folder

After `init`, tools see the selected folder at `/shared/data`, which is also their working directory, so relative paths work:

```ts
await mayo.init(directory);
await mayo.loadTools(["samtools/1.10"]);        // init and loadTools can come in either order
await mayo.exec("samtools idxstats reads.bam");  // reads reads.bam and reads.bam.bai from the folder
await mayo.exec("samtools index reads.bam");    // writes reads.bam.bai next to reads.bam
await mayo.exec("samtools view -b -o out/subset.bam reads.bam chr1:1-1000"); // out/ must exist
await mayo.exec("samtools view -b -o /tmp/tmp.bam reads.bam");     // in this worker's memory, not in the folder
```

```text
/shared             in memory, private to each tool worker
/shared/data        the selected folder (FOLDERFS, read-write)     ← working directory, shared by all tools
/shared/<tool>      this tool's sample data
/shared/urls/<n>    URLs typed in commands (URLFS, read-only)
```

`FOLDERFS` (`tool/folder-fs.ts`) is a custom Emscripten filesystem modelled on Emscripten's `WORKERFS`. Each node operation becomes a synchronous `IOClient` call through the I/O worker:

| Emscripten operation | `IOClient` / I/O request | Browser API |
|---|---|---|
| `lookup`, `getattr` (stat) | `stat` → kind, size, mtime | `getFileHandle` / `getDirectoryHandle`, `getFile()` |
| `readdir` | `list` → names and kinds | `directory.entries()` |
| `open` for reading | `openRead` → handle id, size | `getFile()` once; the `File` is kept per handle |
| `open` for writing | `openWrite(path, keepExistingData)` → handle id | `createWritable({ keepExistingData: true })` (`O_TRUNC` already truncated the file) |
| `read(position)`, `llseek` | `read(id, offset, length)` | `File.slice(...).arrayBuffer()` |
| `write(position)` | `write(id, length, position)` | `writer.write({ type: "write", position, data })` |
| `mknod` (create file or folder) | `create(path, kind)` | `getFileHandle` / `getDirectoryHandle` with `create: true` |
| `setattr` (truncate) | `truncateHandle(id, size)` if open for writing, else `truncate(path, size)` | `writer.truncate(size)` |
| `rename` (files only) | `rename(from, to)` | `fileHandle.move(parent, name)`, removing an existing target first |
| `unlink`, `rmdir` | `remove(path)`, `rmdir(path)` | `removeEntry(name)` after checking the kind |
| `close` | `close(id)` | drops the `File`; commits the writer |
| `symlink` | — | refused with `EPERM` |

Details:

- Mounted in every tool worker, each with its own connection to the I/O worker.
- Remounted before every `exec`. This drops the nodes Emscripten cached during the previous run (so files added, changed or removed outside the tool are seen), and picks up a folder selected after `loadTools`. Without a folder or without cross-origin isolation, `/shared/data` stays an in-memory folder.
- Read cache: programs read in small blocks, and each I/O request is a round trip to the I/O worker. Each open file keeps one block of up to 1 MiB; a read outside it fetches the next 1 MiB from that position. A 34 MB SAM (`samtools flagstat`) takes about 70 ms in Chrome on an OPFS test folder.
- Random access works: `samtools view reads.bam chr:start-end` uses the `.bai` index and only reads the needed blocks.
- An open file is a snapshot: `File` objects become unreadable (`NotReadableError` → `EIO`) if the file changes on disk while a tool reads it.
- Browser errors become errno codes: `NotFoundError` → `ENOENT`, `TypeMismatchError` → `ENOTDIR`, `NotAllowedError`/`SecurityError` → `EACCES`, invalid paths → `EINVAL`, anything else → `EIO`. So tools print normal messages ("No such file or directory") instead of crashing.
- Browser errors also map to `ENOTEMPTY` (`InvalidModificationError`, e.g. `rmdir` on a non-empty folder), `EBUSY` (`NoModificationAllowedError`, file locked by another writer), `ENOSPC` (`QuotaExceededError`) and `EPERM` (`NotSupportedError`).

Writing:

- A write goes to Chrome's temporary copy (`<name>.crswap` in a real folder) and replaces the file only on `close`. Until then, readers (including the same program through another descriptor) see the old content. Tools write outputs and close them before reading them back, so this is fine for samtools; programs that write and read the same file while it is open would see stale data.
- Consecutive small writes are buffered (1 MiB per open file) and sent together; larger writes go straight through. A 75 MB `samtools view -o big.sam` takes about 0.35 s, and `samtools sort` with 16 temporary files (written, read back and deleted) works.
- Programs often leave files open at exit, and biowasm modules are never shut down, so after each `exec` Mayo closes (and so saves) every file still open in `/shared/data`. If a save fails, the error is added to stderr (`[Mayo] could not save …`) and the exit code is set to 1. If a write fails, the temporary copy is discarded and the original file is kept.
- Output folders are not created: `-o out/x.bam` fails with "No such file or directory" unless `out/` exists (create it with `mkdir` in a tool or in the file manager).
- Renaming folders fails with `EPERM`: Chrome only implements `move()` on file handles.
- The folder tree hides `.crswap` files. One can be left behind if the tab or I/O worker is killed during a write.
- Paths are relative to the selected folder. `/` is Emscripten's root (`/dev`, `/tmp`, `/shared`), not the folder: `/output.txt` would be written in memory and lost, so use `output.txt`.

### Redirecting Output

For tools that only write to stdout (or to save stderr), a command string can redirect them to a file, as in a shell:

```ts
await mayo.exec("minimap2 -a ref.fa reads.fq > aln.sam");     // stdout to aln.sam (replaced)
await mayo.exec("samtools view -b in.bam chr1 > chr1.bam");   // binary output is fine
await mayo.exec("samtools view -H in.bam >> notes.txt");      // append
await mayo.exec("samtools faidx ref.fa 2> faidx.log");        // stderr to a file
await mayo.exec("samtools", ["view", "-h", "my file.bam"], { stdout: { path: "out.sam", append: false } });
```

- `parsePipeline` (in `../shared/command.ts`) takes out `< file`, `> file`, `>> file`, `2> file` and `2>> file` (also without the space, `>file`). `1>` is the same as `>`. In a pipeline, `<` is only allowed on the first stage and `>`/`>>` on the last; `2>` works on any stage.
- In the tool worker, `Stdio.redirect` (`tool/stdio.ts`) closes fd 0, 1 or 2 and opens the file in its place, so the program writes straight to the file: byte for byte (BAM works), no 16 MiB cap, nothing kept in memory. A redirected stream comes back empty in the result.
- Paths follow the same rules as program arguments: relative to the selected folder, and the parent folder must exist.
- Like a shell, the files are opened before the program starts. If one cannot be opened, the program does not run, stderr gets `mayo: <path>: No such file or directory` (or `Is a directory`, `Permission denied`) and the exit code is 1.
- After the run, Mayo calls `fflush(0)` so the C library writes what it still buffers (a file on stdout is fully buffered, unlike the terminal), then closes the file, which saves it. A failed save adds `[Mayo] could not save …` to stderr and sets the exit code to 1. stdout and stderr then go back to the result for the next run.
- Newer biowasm builds (for example blast, mash, fasttree) do not export `fflush`. Tools that flush their own output before exiting are unaffected (fasttree output was complete in testing), but a tool that relies on exit-time flushing could lose the last few KB. Prefer the tool's own output option (`-o`) when it has one.
- Tested in Chrome: `samtools view -h > out.sam` and `minimap2 -a > aln.sam` match the captured stdout. `samtools view --no-PG -b > out.bam` is byte-identical to `-o`. `>>`, `2>`, `<`, a missing folder and `> .` behave as in a shell.
- `||`, `&`, `;` and `2>&1` are rejected with "not supported" instead of being passed to the tool as arguments. `|` and `&&` must have spaces around them (`a|b` and `a&&b` are rejected).

### Remote Files (URLs)

Tools can read remote files in place: only the bytes a tool asks for are fetched, with HTTP range requests, and nothing is loaded whole into memory. This works for any tool, because it happens at the filesystem level, not inside the tool.

A URL is added to the folder as a **link file**, and then used like any other file:

```ts
await mayo.addUrl("https://example.org/data/reads.bam");                  // creates reads.bam; nothing downloaded
await mayo.addUrl("https://example.org/ref/grch38.fa", "ref/hg38.fa");     // any name or subfolder
await mayo.exec("samtools view -c reads.bam chr1:1-200000");             // fetches the remote .bai and one region
await mayo.exec("samtools faidx ref/hg38.fa chr2:1-500");                 // uses the remote .fai
await mayo.exec("samtools faidx https://example.org/ref/grch38.fa chr2:1-500"); // a URL typed in a command also works
await mayo.download("https://example.org/ref/small.fa", "ref.fa");         // or save a full copy into the folder
```

Link files:

- A link is a small text file in the selected folder, named after the URL (or the given path), with a single line: `mayo-url https://example.org/data/reads.bam`. It lives in the real folder, so it is kept for the next visit and can be renamed, moved or deleted in Finder like any file. The tree marks it with its URL (`MayoFile.url`).
- `addUrl` checks the URL before writing the link: a `HEAD` gives the size, then a `Range: bytes=0-0` probe must return `206`. The probe is an async `fetch` that is aborted, so a server ignoring `Range` does not send the whole file. It fails with a clear message if the server refuses (not found, CORS blocked, no range support), if the parent folder does not exist, or if an ordinary file already has that name (an existing link is replaced).
- `FOLDERFS` recognises links when a tool looks a file up: files of at most 4 KiB starting with `mayo-url ` are read once (and again only if their size or date changes). The tool sees the remote file's size and date, and its reads go to the remote file.
- Index files: if a name is missing from the folder but extends a link (`reads.bam.bai`, `ref.fa.fai`, `calls.vcf.gz.tbi` next to the links `reads.bam`, `ref.fa`, `calls.vcf.gz`), Mayo asks the server for the link's URL plus that suffix. A local index file, if there is one, takes precedence. Without a remote index, `samtools index reads.bam` reads the remote BAM once and writes `reads.bam.bai` into the folder.
- Writing to a link replaces it with an ordinary file, as overwriting any file would (`samtools sort -o reads.bam …`). `removeFile` and `rm` remove the link, not the remote file.
- If the URL stops working, opening the link fails and stderr gets `[Mayo] reads.bam links to <url>, which cannot be read …`.
- `readFile` on a link returns the link text, not the remote contents.

URLs typed in commands:

- `exec` also accepts `http(s)://` arguments directly. They are checked the same way before the program starts. On failure the program does not run; stderr gets `mayo: <url>: …` and the exit code is 1. Each URL directory gets one read-only `URLFS` mount, `/shared/urls/<n>/` (files next to it are found by name), and the argument is replaced by that path. These mounts last as long as the tool worker; writing next to them fails with `EROFS`. In a pipeline, if a stage's URL fails the check, that stage does not run (its neighbours see end of file or a broken pipe) and the exit code is 1.

Reading:

- Remote reads go through the I/O worker (`io/remote-cache.ts`): async `fetch` range requests and an LRU cache of 1 MiB chunks, capped at 64 MiB and shared by every tool worker. A tool blocks on its own channel, as for folder reads. Sequential reads ramp read-ahead up to 8 chunks; random reads fetch one chunk. Repeated runs, and other stages, reuse cached chunks.
- URLs are checked (`HEAD` and a range probe) by the coordinator before any stage starts, with `RemoteChecker`.
- The exec result has `remote: { requests, bytes }` when a remote file was read, and each stage has its own; the test bench shows it as "fetched X in N range requests".

Server requirements and limitations:

- The server must allow CORS (`Access-Control-Allow-Origin`) and support range requests. Single-range `Range` and `HEAD` requests do not need a preflight. Check each data host: many public buckets allow it, but not all.
- A `text/html` response is treated as "not found" (SPA hosts and the dev server return `index.html` for missing files).
- Signed URLs keep their query string, but index files are guessed by adding the suffix to the URL's path, which breaks the signature. Add the index as its own link instead (`addUrl(<signed .bai url>, "reads.bam.bai")`), or for typed URLs use htslib's `##idx##` syntax. Presigned URLs that refuse `HEAD` are not supported yet.
- `download` works without range support and saves a full copy, for files read many times.
- Tested in Chrome:
  - Links: a BAM region query fetched 1.5 MiB of 12.4 MiB in 3 requests and repeated runs fetched nothing. `faidx` on a link to the 3 GB GRCh37 FASTA in a subfolder fetched 2 MiB in 3 requests.
  - Writing to the folder works (`view -b -o`, `>`). Overwriting a link and `samtools index` on a link without a remote index both work.
  - Clear errors for no CORS, an existing file, a missing folder, and a dead URL.
  - Typed URLs: `faidx` on the GRCh37 FASTA fetched 3.1 MB in 4 requests. Streaming 242 MiB of chr1 raised page memory by about 40 MiB. `seqtk` reads URLs too.
  - Pipes: `samtools view -b <url> chr1:1000-2000 | samtools view -c -` (2 requests) and a link read by the first stage of a pipe.

### Synchronous File Bridge

Emscripten filesystem callbacks (`open`, `read`, `write`, ...) are synchronous, but File System Access calls on a user-selected folder are asynchronous (`getFile`, `createWritable`, ...). Synchronous access handles exist only for OPFS, which we do not use. `IOClient` bridges the two:

1. `IOClient` writes `PENDING` into shared memory, posts the request to the I/O worker, and calls `Atomics.wait`.
2. The I/O worker `await`s the browser file API and copies the reply into the shared buffer.
3. It sets the status, length and `DONE` state, then calls `Atomics.notify`.
4. `IOClient` wakes up, copies the bytes, and returns them, or throws the error text.

Details:

- The `SharedArrayBuffer` holds four `Int32` control slots (state, status, length) followed by a 1 MiB data area (`io/protocol.ts`). The data area carries replies (read bytes, errors) and write payloads.
- Reads use read handles: `openRead` gets the `File` once and returns its id and size, `read(id, offset, length)` returns up to 1 MiB using `File.slice`, and `close` releases it. `readFile` reads in 1 MiB chunks this way, so the I/O worker never loads a whole file.
- `stat` and `list` return JSON (`{ kind, size, mtime }`, `[{ name, kind }]`); the path `""` is the selected folder. A reply larger than the 1 MiB data area fails instead of being truncated.
- Errors keep the browser's `DOMException` name (`NotFoundError`, ...), which `FOLDERFS` maps to errno codes.
- `writeFile` uses write handles, the same shape Emscripten's open/write/close calls will need later:
  1. `openWrite` creates the file if needed, opens a `createWritable()` stream, and returns a handle id.
  2. Each `write` copies up to 1 MiB into the data area before posting; the I/O worker copies it out (file streams reject shared-memory views) and appends it.
  3. `close` commits. The browser writes to a temporary file and only replaces the target on close, so a failed write leaves the original untouched; on error `IOClient` sends `abort` to discard it.
- Write semantics are POSIX-like: missing parent folders are not created, and writing to a path that is a directory fails.
- In a real folder, Chrome's temporary file is visible as `<name>.crswap` while a write is in progress. If the I/O worker is killed mid-write (timeout, `close()`, tab closed), that file may be left behind.
- `removeFile` behaves like `unlink()`: it checks the entry is a file before calling `removeEntry`, because `removeEntry` would also delete an empty directory. Removing a missing file or a directory fails.
- The state is set to `PENDING` before posting, so the reply's notify cannot be missed.
- The coordinator starts the I/O worker once and waits asynchronously for its `ready` message. This handshake is required: a worker created from another worker only starts once its parent returns to the event loop, so blocking right after `new Worker()` would hang until the timeout. For the same reason, tool workers and their channels are all set up (and `ready`) before any stage blocks.
- Several clients: the coordinator and each tool worker have their own `MessageChannel` and SharedArrayBuffer (`IOHost.connect`). A client has at most one request in flight, so replies cannot mix. Open handles are tracked per client; `disconnect` (a worker was cancelled or replaced) aborts its writers, so the target files are left unchanged. `init` sends the new folder to the I/O worker (`root`), which drops every open handle.
- Paths are relative to the selected folder. `.` or `..` segments are rejected, so a path cannot escape the folder (Emscripten resolves them before calling `FOLDERFS`). Empty paths are only allowed for `stat` and `list`.
- Each request times out after 120 seconds (a remote read may fetch several MiB). The client's connection is then dropped; the coordinator reconnects on its next file operation.

### Cross-Origin Isolation (COOP/COEP)

`SharedArrayBuffer` and `Atomics.wait` only work on a cross-origin-isolated page (`crossOriginIsolated === true`). The page must be served with:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

| Environment | How the headers are sent |
|---|---|
| `npm run dev` / `vite preview` | `server.headers` and `preview.headers` in `vite.config.ts` |
| GitHub Pages | `public/coi-serviceworker.js` (see below) |

Without isolation, `init` and the tree methods still work, but file calls, `loadTools` and `exec` fail with an explicit "needs cross-origin isolation" error. The Mayo test bench shows the current status.

Consequences:

- Every cross-origin subresource (scripts, `.wasm`, images, iframes) must send CORP or CORS headers, or it is blocked. Self-host tool `.js`/`.wasm` files instead of loading them from a CDN. `fetch` with CORS (as used for POD5 downloads) still works.
- Windows opened with `window.open` to another origin lose their link to the opener.
- Isolation also allows Emscripten pthreads later, if we ever need them.

### coi-serviceworker (GitHub Pages)

GitHub Pages cannot send custom headers, so we vendor [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) (v0.1.7, MIT) as `public/coi-serviceworker.js`. `index.html` loads it as a classic script before the app:

```html
<script src="/coi-serviceworker.js"></script>
```

Vite copies `public/` unchanged and rewrites this path with the deploy base (for example `/OmicsWayFinder/coi-serviceworker.js`). The service worker's scope is the folder containing the script, so it covers the whole app.

How it works:

1. **First visit:** the page loads without isolation. The script registers itself as a service worker and reloads the page once.
2. **Later visits:** the service worker intercepts every request from the page and its workers and adds `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: cross-origin` to the responses. The browser treats them as server headers, so the page is isolated.
3. **Already isolated** (local dev with Vite headers): the script does nothing and registers no service worker.

Limitations:

- The first visit reloads once.
- A hard refresh (Shift+Reload) bypasses service workers; the script notices the page is not isolated and reloads again.
- Where service workers are unavailable (some private or locked-down browser modes), the page is not isolated and Mayo file calls fail with the isolation error.
- It cannot add headers to opaque cross-origin responses, so self-hosting tool files is still required.
- Once installed, the service worker stays registered in users' browsers. To remove it later, ship a version that sets `window.coi = { shouldDeregister: () => true }` before the script, rather than just deleting the file.
- It does not cache anything; it only rewrites headers.

**Updating:** download the new `coi-serviceworker.js` from the npm package or GitHub release, replace `public/coi-serviceworker.js`, update the version above, and test a production build (see Testing). Options can be set with a global `window.coi` object defined before the script (`shouldRegister`, `shouldDeregister`, `coepCredentialless`, `doReload`, `quiet`); we use the defaults.

If we move to a host that can send headers (Cloudflare Pages, Netlify, Vercel), set COOP/COEP there and deregister the service worker.

### Testing

- `src/components/MayoTester.tsx` (on the Analyser page) is a manual test bench. Until a folder is chosen (or a remembered one reconnected) it only shows the folder picker; choosing a folder also runs `init`. Then it shows separate panels: Folder (init, getTree, refreshTree, forget), Files (path and content fields for readFile/writeFile/removeFile), Remote files (URL and optional name; add it to the folder as a link, or download it), Tools (filterable tool list, `loadTools` and the list of loaded programs), Run (command field for `exec`, Enter runs it, a Stop button that calls `cancel()`, and a button that closes the workers; stderr is shown live under the status bar while a command runs, and pipelines list each stage's exit code), a status bar and the output log. An isolation status line sits at the top. Once visited, the Analyser page stays mounted (hidden on other pages), so a running `exec`, loaded tools and the log survive page changes; closing or reloading the tab during an `exec` asks for confirmation (`useLeaveGuard`).
- Test in Chrome or Edge. VS Code's embedded browser reports `crossOriginIsolated = false` even with the correct headers.
- The folder picker cannot be automated. For scripted tests, use an OPFS directory (`navigator.storage.getDirectory()`) in place of the picked folder, for example by stubbing `window.showDirectoryPicker`.
- To test the GitHub Pages setup, build with the deploy base and serve it from a static server that sends no headers:

  ```sh
  npx vite build --base=/OmicsWayFinder/ --outDir /tmp/site/OmicsWayFinder
  python3 -m http.server 4181 --directory /tmp/site
  # open http://127.0.0.1:4181/OmicsWayFinder/#/analyser
  ```

  The first load reloads once, then the test bench should show "Cross-origin isolated: yes".

### Pipes

Real Unix-style pipes: every stage runs at the same time, in its own worker, and data streams between them with backpressure, instead of stage 1 writing a temporary file before stage 2 starts.

```ts
await mayo.exec("minimap2 -a ref.fa reads.fq 2> map.log | samtools sort -o aln.bam -");
await mayo.exec("samtools view -h reads.bam chr1 | samtools view -b - | samtools view -c -");
await mayo.exec("samtools view big.bam | head -n 5");                 // head exits early; fine
const { exitCode, stages } = await mayo.exec("seqtk seq -a < reads.fq | samtools faidx - > out.txt");
```

Decisions:

- **One worker per tool instance.** `callMain` blocks its thread until the program exits, so stages can only overlap if each runs in its own worker. Each tool stays single-threaded (no pthreads). One `exec` runs at a time; there is no limit on the number of stages.
- **Only the selected folder is shared.** Every tool worker mounts the folder (FOLDERFS) through its own channel to the I/O worker. `/tmp` and sample data stay private to each worker.
- **Remote reads live in the I/O worker**, with one cache for all tools (see [Remote Files](#remote-files-urls)).
- **Exit code: `pipefail`.** The result's `exitCode` is the first non-zero exit code among the stages, except stages stopped by a broken pipe. `0` if all succeeded.
- **stderr is streamed live** when `exec` gets `onStderr`; tool workers send it at most every 100 ms.

The ring buffer (`pipe/pipe.ts`):

- A SharedArrayBuffer: an Int32 header (bytes written, bytes read, writer closed, reader closed, a change counter), then 1 MiB of data. Counters wrap at 2³², so the capacity is a power of two.
- **Writer** (stage k's fd 1): copies what fits; when the buffer is full it waits with `Atomics.wait` (backpressure, so a fast producer cannot fill memory). If the reader has closed it throws `PipeClosedError`.
- **Reader** (stage k+1's fd 0): returns what is available; when the buffer is empty it waits; empty and writer closed means end of file.
- Every change bumps the change counter and notifies it, and waiters wait on that counter, so a wake-up cannot be missed. There is no timeout: a stage may wait minutes (`sort` reads everything first). Deadlocks are avoided because ends are always closed: by the stage when `main` returns, or by the coordinator (`closePipe`) when a stage crashes, is cancelled or does not start.
- Emscripten side: `/dev/stdin` and `/dev/stdout` are character devices (`FS.registerDevice`) whose `read`/`write` go to the pipe, so binary data passes byte for byte. `-` and `/dev/stdin` reach the same device. They have no `llseek`, so seeking fails with `ESPIPE`, as on a real pipe.
- Broken pipe: writing after the reader exited throws out of the device's `write`, which ends `main` (like SIGPIPE). The stage gets exit code 141 and `brokenPipe: true`, its stderr after that point is dropped, and its worker is replaced.
- After `main` returns, the stage calls `fflush(0)` (musl fully buffers stdout when it is not a terminal), then closes its pipe ends.

Running a pipeline (`CommandRunner.exec`, `coordinator/runner.ts`):

1. `parseCommand` splits on ` && ` (see [Chaining with &&](#chaining-with-)), then `parsePipeline` splits each side on ` | ` and checks the operators (`<` first stage only, `>`/`>>` last stage only).
2. Every URL in the arguments is checked. A stage with a bad URL does not run: its stderr has the reason and its exit code is 1.
3. Each stage gets its program's warm worker; a program that appears again (`samtools … | samtools …`) gets an extra instance, which reuses the compiled module and is terminated after the run.
4. One pipe per `|`; `run` is sent to every stage at once, and the coordinator waits for all of them.
5. The result: `stdout` is the last stage's (16 MiB cap) unless redirected; `stderr` is every stage's, in order; `exitCode` follows `pipefail`; `stages` has `{ program, exitCode, stderr, remote?, brokenPipe? }` per stage; `remote` sums the stages.

Cancelling (`mayo.cancel()`, or the tester's Stop button) terminates the stage workers, closes the pipes and disconnects their I/O channels, which aborts their writes: files being written keep their previous contents (a file created by the run may be left empty). The `exec` resolves with exit code 130 and `cancelled: true`; fresh warm workers are started in the background. `close()` still stops everything.

Consequences and limits:

- **Memory:** each instance has its own WebAssembly memory, so a 3-stage pipeline uses about three times as much. The remote cache is shared.
- **Files:** two stages writing the same file: the last close wins. A stage reading a file another stage is writing sees the old contents, because writes appear on close. Temporary files (`samtools sort -T`) should go in the folder or the stage's own `/tmp`.
- **Not every tool streams:** tools that seek on their input fail with `ESPIPE` on a pipe. Tools such as `sort` read everything first, so they only overlap with the stage before them.
- **Headers:** as in a shell, `samtools view in.sam | samtools view -` fails without `-h`, because the second stage sees no header.

Tested in Chrome (400 000-read SAM on an OPFS folder):

- `samtools view -b big.sam | samtools view -c -` counts 400 000, as without a pipe.
- `samtools view -h big.sam | samtools sort -o piped.bam -` gives the same records as the two-step version (0.44 s vs 0.60 s).
- `minimap2 -a … 2> mm.log | samtools sort -o mm.bam -` works, with the log in the folder.
- `samtools view big.sam | head -n 3` ends in 34 ms: `samtools` gets a broken pipe (141, ignored), exit code 0, no error printed.
- Three stages, a `lazy` tool (`wc`) started on first use, `<`, `>>` and `2>` on a middle stage, a failing middle stage (exit code 1), and live stderr tagged by stage.
- Cancel during a sort: exit code 130 at once, an existing output file is unchanged, no `.crswap` is left, and the next pipeline runs normally.
- Node, from this folder: `node --test ../shared/command.test.mjs pipe/pipe.test.mjs` (ring buffer with `worker_threads`: 64 MiB through a 64 KiB buffer checked by hash, wrap-around, EPIPE, end of file; and `parseCommand`/`parsePipeline`).

### Chaining with &&

`a && b` runs `b` only if `a` exited with 0, as in a shell. Each side can be a pipeline:

```ts
await mayo.exec("minimap2 -a ref.fa reads.fq | samtools sort -o aln.bam - && samtools index aln.bam");
```

- `parseCommand` (in `../shared/command.ts`) splits on ` && ` and parses each side with `parsePipeline`, so each side has its own redirections. An empty side (`a &&`, `&& b`) is rejected, and so is `&&` without spaces (`a&&b`).
- The coordinator (`CommandRunner.exec`) runs the pipelines one after the other. Every program is checked before anything runs, so a typo in the last pipeline fails before the first one starts. Each pipeline sees the files the previous one wrote, because outputs are saved when a program closes them.
- Result: `stdout` and `stderr` are each pipeline's in turn; `exitCode` is the last pipeline that ran (the first failure, since the chain stops there; `pipefail` applies within each pipeline); `stages` lists every stage that ran, with `pipeline` (0, 1, …) telling which side it belongs to; `remote` sums them all. Stages that did not run are not listed.
- Live stderr numbers stages across the whole command: in `a | b && c`, `c` is stage 2.
- `cancel()` stops the running pipeline and the rest of the chain does not start. A cancel sent while workers are still starting is also honoured (exit code 130).
- Tested in Chrome: `minimap2 -a … | samtools sort -o sorted.bam - && samtools index sorted.bam && samtools idxstats sorted.bam` (writes `sorted.bam` and `sorted.bam.bai`, stdout is the idxstats output); a failing first or middle command stops the chain with its exit code; cancel during the first pipeline and right after `exec` both give 130 with no later stage run; live stderr from the third stage is tagged 2.

### Not Yet Implemented

- `||`, `;`, `2>&1`, quoting in command strings, and Aioli's `cat`/`ls` helpers.
- Running several `exec` at once, or a limit on the number of stages based on memory.
- Multi-threaded tools (Emscripten pthreads) inside pipes.
