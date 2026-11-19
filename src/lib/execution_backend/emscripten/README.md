# Emscripten Backend

## Goal

Run existing bioinformatics tools compiled with Emscripten in the browser without rewriting their scientific code. The backend should expose a command-like interface, connect inputs and outputs to the workflow engine, and eventually support persistent, resumable execution.

## Mayo

`Mayo` is the Emscripten backend runtime, inspired by [Aioli](https://github.com/biowasm/aioli). Unlike Aioli, it works directly in a folder the user selects on their own computer instead of an in-memory filesystem. It currently scans the folder and reads files; running tools is not implemented yet.

### Usage

```ts
import { Mayo } from "./mayo";

const mayo = new Mayo();                           // starts the Mayo worker; no arguments
const directory = await window.showDirectoryPicker({ mode: "readwrite" });
const tree = await mayo.init(directory);           // scans the folder, starts file I/O
const bytes = await mayo.readFile("reads/sample.fastq");
const updated = await mayo.refreshTree();          // rescan after external changes
mayo.close();                                      // stop the workers, reject pending calls
```

| Method | Status | Description |
|---|---|---|
| `init(directory)` | Done | Recursively lists the folder (names, sizes, no contents) and starts the I/O worker. A failed init keeps the previous root and tree. |
| `getTree()` | Done | Returns the last tree snapshot. |
| `refreshTree()` | Done | Rescans the current folder. A failed refresh keeps the previous snapshot. |
| `readFile(path)` | Done | Reads a whole file relative to the folder. Needs cross-origin isolation. |
| `writeFile(path, data)` | Placeholder | Throws "not implemented". |
| `removeFile(path)` | Placeholder | Throws "not implemented". |
| `close()` | Done | Terminates the worker and rejects pending requests. |

The tree is a `MayoDirectory` whose `children` are `MayoFile` or `MayoDirectory` entries (`mayo.protocol.ts`). The root is always a directory.

The caller selects the directory and handles browser support and permission prompts. The File System Access directory picker is only available in Chromium browsers (Chrome, Edge). The handle is not persisted between sessions yet.

### Files

| File | Runs in | Role |
|---|---|---|
| `mayo.ts` | Main thread | Async client API. Sends requests to the worker and matches replies by id. |
| `mayo.protocol.ts` | Shared | Tree types and main ↔ worker message types. |
| `mayo.worker.ts` | Mayo worker | Processes requests one at a time; routes tree operations to `MayoTree` and file operations to `MayoFS`. |
| `mayo-tree.ts` | Mayo worker | `MayoTree`: scans the folder into a tree for display. |
| `mayo-fs.ts` | Mayo worker | `MayoFS`: synchronous file access; will become the shared Emscripten filesystem. |
| `mayo-io.protocol.ts` | Shared | Shared-memory layout and I/O request types. |
| `mayo-io.worker.ts` | I/O worker | Performs the asynchronous File System Access calls for `MayoFS`. |

### Threads

```text
main thread (React UI)
   │  postMessage (async)
   ▼
mayo.worker.ts  ── MayoTree, MayoFS; future Emscripten tools run here
   │  postMessage + Atomics.wait (blocks this worker only)
   ▼
mayo-io.worker.ts ── File System Access calls on the selected folder
```

- The UI thread never blocks: every `Mayo` method is async.
- The Mayo worker processes one request at a time, in arrival order, so a rescan and a read cannot race.
- Tools stay single-threaded (no Emscripten pthreads). The extra worker exists only to make file access synchronous.
- Errors are sent back as `{ name, message }` and rethrown by `mayo.ts`. If a worker crashes, all pending calls are rejected.

### Synchronous File Bridge

Emscripten filesystem callbacks (`open`, `read`, `write`, ...) are synchronous, but File System Access calls on a user-selected folder are asynchronous (`getFile`, `createWritable`, ...). Synchronous access handles exist only for OPFS, which we do not use. `MayoFS` bridges the two:

1. `MayoFS` writes `PENDING` into shared memory, posts the request to the I/O worker, and calls `Atomics.wait`.
2. The I/O worker `await`s the browser file API and copies the reply into the shared buffer.
3. It sets the status, length and `DONE` state, then calls `Atomics.notify`.
4. `MayoFS` wakes up, copies the bytes, and returns them, or throws the error text.

Details:

- The `SharedArrayBuffer` holds four `Int32` control slots (state, status, length) followed by a 1 MiB data area (`mayo-io.protocol.ts`). `readFile` first asks for the file size, then reads in 1 MiB chunks using `File.slice`, so the I/O worker never loads a whole file.
- The state is set to `PENDING` before posting, so the reply's notify cannot be missed.
- `init` starts a fresh I/O worker and waits asynchronously for its `ready` message. This handshake is required: a worker created from another worker only starts once its parent returns to the event loop, so blocking right after `new Worker()` would hang until the timeout.
- Paths are relative to the selected folder. Empty paths and `.` or `..` segments are rejected, so a path cannot escape the folder.
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

- `src/components/MayoTester.tsx` (on the Analyser page) is a manual test bench. It has a folder picker, buttons for each method, path and content fields, an isolation status line and an output log.
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

- `writeFile`, `removeFile`, rename and directory creation through the I/O worker.
- A custom Emscripten filesystem (`MAYOFS`) wrapping `MayoFS`, mounted for example at `/shared`, shared by all tools.
- Loading and running a self-hosted, single-threaded tool (for example coreutils `head`) with `callMain`, capturing stdout, stderr and the exit code.
- Persisting the directory handle (IndexedDB) and re-requesting permission.

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
