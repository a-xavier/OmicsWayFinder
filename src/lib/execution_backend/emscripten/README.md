# Emscripten Backend

## Goal

Run existing bioinformatics tools compiled with Emscripten in the browser without rewriting their scientific code. The backend should expose a command-like interface, connect inputs and outputs to the workflow engine, and eventually support persistent, resumable execution.

## Mayo

`Mayo` is the Emscripten backend runtime, inspired by [Aioli](https://github.com/biowasm/aioli). Unlike Aioli, it works directly in a folder the user selects on their own computer instead of an in-memory filesystem. It currently scans the folder, reads, writes and removes files, and loads and runs biowasm tools. Tools see the selected folder at `/shared/data` (their working directory) and can read and write it, so relative paths such as `samtools index reads.bam` work on the real files.

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
| `loadTools(specs)` | Done | Downloads and sets up tools (Aioli syntax, see [Tools](#tools)). Can be called again to add tools. Returns all loaded tools. Does not need `init` or cross-origin isolation. |
| `exec(command, args?, redirects?)` | Done | Runs a loaded program with `callMain` and returns `{ stdout, stderr, exitCode }`. With no `args`, `command` is split on whitespace (no quoting) and `>`, `>>`, `2>`, `2>>` are applied (see [Redirecting Output](#redirecting-output)). The selected folder is mounted at `/shared/data`, the working directory (see [Tools and the Selected Folder](#tools-and-the-selected-folder)). |
| `close()` | Done | Terminates the worker and rejects pending requests. |

The tree is a `MayoDirectory` whose `children` are `MayoFile` or `MayoDirectory` entries (`mayo.protocol.ts`). The root is always a directory.

The caller selects the directory and handles browser support and permission prompts. The File System Access directory picker is only available in Chromium browsers (Chrome, Edge). The handle is not persisted between sessions yet.

### Files

| File | Runs in | Role |
|---|---|---|
| `mayo.ts` | Main thread | Async client API. Sends requests to the worker and matches replies by id. |
| `mayo.protocol.ts` | Shared | Tree types and main ↔ worker message types. |
| `mayo.worker.ts` | Mayo worker | Processes requests one at a time; routes tree operations to `MayoTree` and file operations to `MayoFS`. |
| `mayo-folder-store.ts` | Page | Remembers the selected folder in IndexedDB and re-requests permission (see [Remembering the Folder](#remembering-the-folder)). |
| `mayo-tree.ts` | Mayo worker | `MayoTree`: scans the folder into a tree for display. |
| `mayo-fs.ts` | Mayo worker | `MayoFS`: synchronous file access; will become the shared Emscripten filesystem. |
| `mayo-tools.ts` | Mayo worker | `MayoTools`: downloads, sets up and runs Emscripten tools (port of Aioli's worker logic). |
| `mayo-emscripten-fs.ts` | Mayo worker | `MAYOFS`: Emscripten filesystem on top of `MayoFS`, mounted at `/shared/data`. |
| `mayo-io.protocol.ts` | Shared | Shared-memory layout and I/O request types. |
| `mayo-io.worker.ts` | I/O worker | Performs the asynchronous File System Access calls for `MayoFS`. |

### Remembering the Folder

`mayo-folder-store.ts` saves the selected folder's handle so the next visit can reopen it without the folder picker:

```ts
import { folderPermission, forgetFolder, loadFolder, requestFolderPermission, saveFolder } from "./mayo-folder-store";

await saveFolder(directory);                       // after showDirectoryPicker
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

```text
main thread (React UI)
   │  postMessage (async)
   ▼
mayo.worker.ts  ── MayoTree, MayoFS, MayoTools (Emscripten tools run here)
   │  postMessage + Atomics.wait (blocks this worker only)
   ▼
mayo-io.worker.ts ── File System Access calls on the selected folder
```

- The UI thread never blocks: every `Mayo` method is async.
- The Mayo worker processes one request at a time, in arrival order, so a rescan and a read cannot race.
- Tools stay single-threaded (no Emscripten pthreads). The extra worker exists only to make file access synchronous.
- Errors are sent back as `{ name, message }` and rethrown by `mayo.ts`. If a worker crashes, all pending calls are rejected.

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
- Files already present are not downloaded again. `npm run fetch:tools -- bcftools seqtk` updates only those tools.
- It writes `public/tools/manifest.json` (`tool`, `version`, `programs`, `description`), which the test bench reads to list the tools.

The test bench lists the manifest as checkboxes (one per tool, plus one per program for tools with several), with a filter and a choice between the local copy and the CDN. The Load button loads all ticked programs that are not loaded yet in one call (ticked programs that are already loaded are skipped and listed in the log); loading again adds tools. A "Loaded" list under the button shows every registered program with its tool, version, source (local or CDN), and base/lazy status. The first program loaded (in manifest order) becomes the base tool.

How it works (same model as Aioli, all in the Mayo worker, single-threaded):

- The biowasm `<program>.js` glue is a classic script. Module workers cannot use `importScripts`, so `MayoTools` fetches the text and evaluates it with `new Function`. The `.wasm` and `.data` files are located next to it with `locateFile`. Downloads are cached per URL.
- The biowasm CDN sends `Access-Control-Allow-Origin: *`, so it loads under COEP `require-corp`.
- The first non-`reinit` tool is the **base** (always eager). It owns `/shared` and `/shared/data`; the working directory is `/shared/data`.
- Other tools mount the base's `/shared` with `PROXYFS`, so files written by one tool are visible to the next (for example `samtools faidx … -o subset.fa` then `seqtk seq subset.fa`).
- Each tool's sample data (`/<tool>` in its `.data` package) is exposed at `/shared/<tool>`, for example `/shared/samtools/examples/toy.sam`.
- Exit codes: `callMain` returns nothing, so `Module.quit` is overridden to record the status. A crash gives exit code 1 and the error is appended to stderr. Modules stay alive between runs (`noExitRuntime`).
- stdout and stderr are flushed after each run (closed and reopened, as Aioli does), which also saves redirection files. stdin is empty (EOF).
- stdout and stderr are each capped at 16 MiB per run (`OUTPUT_LIMIT`). The rest is dropped and a `[Mayo] … was cut` line is added to stderr. Without the cap, `samtools view big.bam` (gigabytes of SAM text, all kept in memory and copied to the page) crashed the tab. Large outputs belong in files (`-o` or `>`); note that `/shared` is in memory too.
- A program that is already loaded from the same tool and version is skipped (also when listed twice in one call). The same program name from another tool or version is rejected, since `exec` finds programs by name. If one tool in a `loadTools` call fails, the whole call is rolled back.
- A wrong URL usually returns the dev server's or GitHub Pages' HTML page; `MayoTools` detects it and reports which URL failed.

### Tools and the Selected Folder

After `init`, tools see the selected folder at `/shared/data`, which is also their working directory, so relative paths work:

```ts
await mayo.init(directory);
await mayo.loadTools(["samtools/1.10"]);        // init and loadTools can come in either order
await mayo.exec("samtools idxstats reads.bam");  // reads reads.bam and reads.bam.bai from the folder
await mayo.exec("samtools index reads.bam");    // writes reads.bam.bai next to reads.bam
await mayo.exec("samtools view -b -o out/subset.bam reads.bam chr1:1-1000"); // out/ must exist
await mayo.exec("samtools view -b -o /shared/tmp.bam reads.bam");  // in memory, not in the folder
```

```text
/shared             in-memory (base tool's MEMFS), shared by all tools through PROXYFS
/shared/data        the selected folder (MAYOFS, read-write)     ← working directory
/shared/<tool>      each tool's sample data
```

`MAYOFS` (`mayo-emscripten-fs.ts`) is a custom Emscripten filesystem modelled on Emscripten's `WORKERFS`. Each node operation becomes a synchronous `MayoFS` call through the I/O worker:

| Emscripten operation | `MayoFS` / I/O request | Browser API |
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

- Mounted only in the base tool. Other tools reach it through their `PROXYFS` mount of `/shared`.
- Remounted before every `exec`. This drops the nodes Emscripten cached during the previous run (so files added, changed or removed outside the tool are seen), and picks up a folder selected after `loadTools`. Without a folder or without cross-origin isolation, `/shared/data` stays an in-memory folder.
- Read cache: programs read in small blocks, and each I/O request is a round trip to the I/O worker. Each open file keeps one block of up to 1 MiB; a read outside it fetches the next 1 MiB from that position. A 34 MB SAM (`samtools flagstat`) takes about 70 ms in Chrome on an OPFS test folder.
- Random access works: `samtools view reads.bam chr:start-end` uses the `.bai` index and only reads the needed blocks.
- An open file is a snapshot: `File` objects become unreadable (`NotReadableError` → `EIO`) if the file changes on disk while a tool reads it.
- Browser errors become errno codes: `NotFoundError` → `ENOENT`, `TypeMismatchError` → `ENOTDIR`, `NotAllowedError`/`SecurityError` → `EACCES`, invalid paths → `EINVAL`, anything else → `EIO`. So tools print normal messages ("No such file or directory") instead of crashing.
- This Emscripten version's `FS.ErrnoError` has no `code` field, but `PROXYFS` needs one to pass errors to other tools. `MAYOFS` errors set `code` (for example `"ENOENT"`), so `seqtk comp missing.fa` fails cleanly too.
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

- `parseCommand` (in `mayo.ts`) takes out `> file`, `>> file`, `2> file` and `2>> file` (also without the space, `>file`). `1>` is the same as `>`.
- In the worker, `redirectStdio` closes fd 1 (or 2) and opens the file in its place, so the program writes straight to the file: byte for byte (BAM works), no 16 MiB cap, nothing kept in memory. A redirected stream comes back empty in the result.
- Paths follow the same rules as program arguments: relative to the selected folder, and the parent folder must exist.
- Like a shell, the files are opened before the program starts. If one cannot be opened, the program does not run, stderr gets `mayo: <path>: No such file or directory` (or `Is a directory`, `Permission denied`) and the exit code is 1.
- After the run, Mayo calls `fflush(0)` so the C library writes what it still buffers (a file on stdout is fully buffered, unlike the terminal), then closes the file, which saves it. A failed save adds `[Mayo] could not save …` to stderr and sets the exit code to 1. stdout and stderr then go back to the result for the next run.
- Newer biowasm builds (for example blast, mash, fasttree) do not export `fflush`. Tools that flush their own output before exiting are unaffected (fasttree output was complete in testing), but a tool that relies on exit-time flushing could lose the last few KB. Prefer the tool's own output option (`-o`) when it has one.
- Tested in Chrome: `samtools view -h > out.sam` and `minimap2 -a > aln.sam` (a non-base tool through `PROXYFS`) match the captured stdout. `samtools view --no-PG -b > out.bam` is byte-identical to `-o`. `>>`, `2>`, a missing folder and `> .` behave as in a shell.
- `|`, `||`, `&&`, `&`, `;`, `<` and `2>&1` are rejected with "not supported yet" instead of being passed to the tool as arguments.

### Synchronous File Bridge

Emscripten filesystem callbacks (`open`, `read`, `write`, ...) are synchronous, but File System Access calls on a user-selected folder are asynchronous (`getFile`, `createWritable`, ...). Synchronous access handles exist only for OPFS, which we do not use. `MayoFS` bridges the two:

1. `MayoFS` writes `PENDING` into shared memory, posts the request to the I/O worker, and calls `Atomics.wait`.
2. The I/O worker `await`s the browser file API and copies the reply into the shared buffer.
3. It sets the status, length and `DONE` state, then calls `Atomics.notify`.
4. `MayoFS` wakes up, copies the bytes, and returns them, or throws the error text.

Details:

- The `SharedArrayBuffer` holds four `Int32` control slots (state, status, length) followed by a 1 MiB data area (`mayo-io.protocol.ts`). The data area carries replies (read bytes, errors) and write payloads.
- Reads use read handles: `openRead` gets the `File` once and returns its id and size, `read(id, offset, length)` returns up to 1 MiB using `File.slice`, and `close` releases it. `readFile` reads in 1 MiB chunks this way, so the I/O worker never loads a whole file.
- `stat` and `list` return JSON (`{ kind, size, mtime }`, `[{ name, kind }]`); the path `""` is the selected folder. A reply larger than the 1 MiB data area fails instead of being truncated.
- Errors keep the browser's `DOMException` name (`NotFoundError`, ...), which `MAYOFS` maps to errno codes.
- `writeFile` uses write handles, the same shape Emscripten's open/write/close calls will need later:
  1. `openWrite` creates the file if needed, opens a `createWritable()` stream, and returns a handle id.
  2. Each `write` copies up to 1 MiB into the data area before posting; the I/O worker copies it out (file streams reject shared-memory views) and appends it.
  3. `close` commits. The browser writes to a temporary file and only replaces the target on close, so a failed write leaves the original untouched; on error `MayoFS` sends `abort` to discard it.
- Write semantics are POSIX-like: missing parent folders are not created, and writing to a path that is a directory fails.
- In a real folder, Chrome's temporary file is visible as `<name>.crswap` while a write is in progress. If the I/O worker is killed mid-write (timeout, `close()`, tab closed), that file may be left behind.
- `removeFile` behaves like `unlink()`: it checks the entry is a file before calling `removeEntry`, because `removeEntry` would also delete an empty directory. Removing a missing file or a directory fails.
- The state is set to `PENDING` before posting, so the reply's notify cannot be missed.
- `init` starts a fresh I/O worker and waits asynchronously for its `ready` message. This handshake is required: a worker created from another worker only starts once its parent returns to the event loop, so blocking right after `new Worker()` would hang until the timeout.
- Paths are relative to the selected folder. `.` or `..` segments are rejected, so a path cannot escape the folder (Emscripten resolves them before calling `MAYOFS`). Empty paths are only allowed for `stat` and `list`.
- Each request times out after 30 seconds. The I/O worker is then terminated, and Mayo must be initialized again.

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

Without isolation, `init` and the tree methods still work, but file calls fail with an explicit "requires cross-origin isolation" error. The Mayo test bench shows the current status.

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

- `src/components/MayoTester.tsx` (on the Analyser page) is a manual test bench. Until a folder is chosen (or a remembered one reconnected) it only shows the folder picker; choosing a folder also runs `init`. Then it shows separate panels: Folder (init, getTree, refreshTree, forget), Files (path and content fields for readFile/writeFile/removeFile), Tools (filterable tool list, `loadTools` and the list of loaded programs), Run (command field for `exec`, Enter runs it, and a button that closes the worker), a status bar and the output log. An isolation status line sits at the top. Once visited, the Analyser page stays mounted (hidden on other pages), so a running `exec`, loaded tools and the log survive page changes; closing or reloading the tab during an `exec` asks for confirmation (`useLeaveGuard`).
- Test in Chrome or Edge. VS Code's embedded browser reports `crossOriginIsolated = false` even with the correct headers.
- The folder picker cannot be automated. For scripted tests, use an OPFS directory (`navigator.storage.getDirectory()`) in place of the picked folder, for example by stubbing `window.showDirectoryPicker`.
- To test the GitHub Pages setup, build with the deploy base and serve it from a static server that sends no headers:

  ```sh
  npx vite build --base=/OmicsWayFinder/ --outDir /tmp/site/OmicsWayFinder
  python3 -m http.server 4181 --directory /tmp/site
  # open http://127.0.0.1:4181/OmicsWayFinder/#/analyser
  ```

  The first load reloads once, then the test bench should show "Cross-origin isolated: yes".

### Not Yet Implemented

- stdin for `exec`, pipes (`|`), `&&`, `2>&1`, quoting in command strings, and Aioli's `mount`/`cat`/`ls`/`download` helpers.

## Runtime Model

An Emscripten build is commonly a package containing a `.wasm` module and generated JavaScript glue. The glue initializes the module, provides imports and runtime services, and often exposes a virtual filesystem and a `callMain`-style entrypoint. Treat the package, its tool version, build options, and runtime glue as one versioned artifact.

Before adopting a tool, record:

- Source and exact tool version, license, and reproducible build instructions.
- Emscripten version and target/runtime ABI.
- Required data packages, reference files, environment variables, and command arguments.
- Whether it needs pthreads, shared memory, SIMD, Asyncify, or other special build/runtime features.
- Startup time, peak linear memory, temporary disk use, output formats, and known unsupported operations.

## Filesystem Design Questions

Emscripten tools typically expect a POSIX-like filesystem. The preferred design is to work directly in a user-selected directory, with inputs, scratch files, and outputs stored on the user's filesystem rather than copied into OPFS. Determine which filesystem implementation the selected build uses and whether it can support that design. Do not assume a `File` mounted by the browser is writable or persistent.

The File System Access API does not automatically turn a selected directory into an Emscripten filesystem. An explicit bridge must adapt the tool's synchronous filesystem calls to browser APIs and handle permissions, asynchronous operations, cancellation, and browser support. Verify that it supports the tool's required operations and large sequential writes without copying whole files into memory.

OPFS is not the default work area. If direct access is not feasible for a browser or tool, report the limitation rather than silently copying data into OPFS. Consider an alternative storage strategy only as an explicit future decision.

The runtime should expose an explicit virtual layout, for example `/input`, `/work`, `/references`, and `/output`, and document which locations are read-only, temporary, persistent, or exported.

## Command and Pipeline Behavior

Define how the backend maps a workflow step to the tool's command and arguments. Determine whether `callMain` or the selected runtime supports the tool's actual CLI behavior, including exit codes, stderr, environment, signals, and working directory.

Prefer bounded stdout-to-stdin streaming for large producer/consumer pipelines when the runtime exposes binary-safe streams. For example, BWA-MEM can emit SAM on stdout directly to `samtools sort` on stdin; `samtools view -b -` is unnecessary if it performs no filtering or transformation. Configure `samtools sort` temporary runs (`-T`) and final output (`-o`) on the disk-backed filesystem. Sorting still needs scratch space, but this avoids storing the full intermediate SAM file.

This kind of pipe requires both single-threaded tools to be active concurrently so the consumer can drain output and apply backpressure. It does **not** require pthreads inside either tool. Phase one allows this bounded concurrency within one declared pipeline, but runs only one pipeline at a time; it does not run independent samples or pipelines in parallel.

If the Emscripten runtime cannot expose a backpressured binary stream between tool instances, use an intermediate only as a fallback. Measure its disk cost; for WGS, prefer a supported compressed or binary intermediate where semantics allow, and do not silently materialize uncompressed SAM.

Do not assume shell syntax, process spawning, signals, or pipes work just because a native build supports them. Validate each capability against the actual Emscripten artifact. Capture logs and errors as text and never infer success from the absence of an exception alone; check exit status and expected outputs.

## Phase-One Execution Model: Single-Threaded

Run one workflow at a time. Host each single-threaded Emscripten tool instance in a Web Worker so long analyses do not block React. A declared streaming pipeline may have a producer and consumer active concurrently, connected by a bounded channel; all other stages and samples remain sequential.

For phase one, use single-threaded tool builds: do not enable Emscripten pthreads or shared WebAssembly memory. Mayo's file bridge already requires cross-origin isolation (see above), but tools themselves stay single-threaded. Only explicitly connected pipeline processes may overlap; avoid independent concurrent jobs.

Record whether a candidate tool requires pthreads. If no single-threaded build exists, defer it or document it as unsupported for phase one rather than silently changing the execution model. Revisit parallel execution only after measuring representative workloads and confirming runtime, filesystem, deployment-header, and resource-limit support.

## Large Files and Persistence

Avoid copying a whole large file into a JavaScript `ArrayBuffer` or Emscripten memory unless the workload explicitly fits a measured memory budget. Test streaming reads, writes, and the total size of intermediate files. Check available disk space where possible, and handle disk exhaustion and lost or revoked directory permission. Access to a previously selected directory may require the user to grant permission again.

A resumable run needs a manifest recording input identity/checksum, tool and build versions, arguments, references, output paths, completed stages, and validation status. Write to temporary output paths; mark a stage complete only after output is closed, validated, and recorded. Recover by checking the manifest and output, then resume at the last valid checkpoint.

## Security and Isolation

The virtual filesystem is not the user's general filesystem. Require explicit user selection and limit access to the chosen directory and necessary permissions. Keep path construction within the configured virtual root, avoid evaluating user-supplied shell strings, and pass arguments as an array when the runtime supports it. Handle untrusted biological files, permission failures, and disk exhaustion as normal error cases.

## First Prototype Milestone

Use one small, existing Emscripten bioinformatics tool with a known version and license. Demonstrate:

1. Load and run its actual `.wasm` plus glue package in the chosen worker/runtime.
2. Pass an input and arguments; capture stdout, stderr, and exit status.
3. Produce an output without blocking the UI.
4. Measure peak memory and storage for a representative input.
5. Reopen or refresh the app and verify access to the selected directory and its persisted files, then simulate an interrupted/incomplete output.
6. Document unsupported CLI/runtime features, browser and permission requirements, and the exact boundary between virtual paths and the user-selected directory.
7. Confirm the selected builds are single-threaded; test a bounded BWA-MEM stdout to samtools-sort stdin pipeline without a full SAM intermediate, including cancellation and backpressure.

Do not claim general Emscripten compatibility or resumability based on one tool passing this test.
