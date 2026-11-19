# WASI Backend

## Goal

Run command-line bioinformatics programs compiled for WebAssembly System Interface (WASI) in the browser, keeping their command-oriented interface and scientific code intact. The backend should provide arguments, environment, standard streams, filesystem access, and workflow-level progress/recovery.

## Runtime and ABI

First select a WASI target and runtime contract. `wasm32-wasip1` (Preview 1) and `wasm32-wasip2` (Preview 2/component model) are not interchangeable. Inventory existing tool artifacts before choosing: record their target, WASI imports, libc/runtime assumptions, required syscalls, threading needs, and tool version. A binary that compiles for WASI is not automatically runnable in every browser runtime.

The backend/runtime must define:

- How a module is instantiated and how `argv`, environment variables, current directory, stdin, stdout, stderr, exit status, and termination are represented.
- Whether the runtime can execute one command only or can spawn processes and connect pipes.
- How clocks, random numbers, filesystem calls, and other WASI imports are supplied.
- How cancellation and resource limits are enforced without freezing the UI.

Keep command invocation structured: executable/tool ID plus an argument array, rather than building a shell string from untrusted names or values.

## Phase-One Execution Model: Single-Threaded

Run one workflow at a time, with stages sequenced explicitly. A dedicated Web Worker may host each single-threaded WASI command to prevent long jobs from blocking React and browser input. Communicate command start, cancel, progress, stdout/stderr, and exit status through messages. The only phase-one overlap is a producer and consumer connected by one declared streaming pipe.

For phase one, select single-threaded WASI builds and runtimes. Do not require WASI threads, shared memory, atomics, `SharedArrayBuffer`, or cross-origin-isolation headers (COOP/COEP). This keeps the initial deployment compatible with the current GitHub Pages setup. If a tool only has a threaded build, defer it or mark it unsupported until a later phase.

Treat parallel samples, unrelated concurrent workflow stages, and threads within one tool as out of scope for phase one. Revisit them only after profiling and confirming the exact WASI ABI/runtime, browser deployment headers, filesystem concurrency guarantees, and memory/storage limits.

## Filesystem and User-Directory Integration

WASI programs expect filesystem access to be supplied by their host runtime. They do not automatically see a directory picked by the user. The preferred design is to work directly in a user-selected directory, with inputs, scratch files, and outputs stored on the user's filesystem rather than copied into OPFS. The runtime generally exposes selected directories as preopened directories (capability-based paths) or mounts a filesystem under a guest path such as `/input`, `/work`, or `/output`.

Investigate and document:

1. Which WASI filesystem API the runtime implements and how preopens/path permissions are configured.
2. Whether a user-selected directory can be mounted read/write without copying, including support for directories, metadata, rename, delete, seek, truncate, and concurrent access.
3. How browser asynchronous storage APIs are adapted to the runtime's filesystem calls. A synchronous POSIX-like WASI call and an asynchronous browser file operation require an explicit runtime/adapter strategy; no filesystem mapping is automatic.
4. How permission lifetime and revocation are handled, and which browsers support the required directory operations.
5. Whether large files can be read and written in bounded chunks without copying them entirely into memory.

OPFS is not the default work area. If direct access is not feasible for a browser or tool, report the limitation rather than silently copying data into OPFS. Consider an alternative storage strategy only as an explicit future decision.

Treat every preopen as a capability: grant only the needed read/write access, keep guest paths contained, and do not provide ambient access to the user's entire filesystem.

## Pipelines and Persistent Workflows

Prefer bounded stdout-to-stdin streaming for large producer/consumer pipelines when the runtime supports it. For example, BWA-MEM can emit SAM directly to `samtools sort`, which can write temporary sort runs (`-T`) and the final BAM (`-o`) to the disk-backed filesystem. If no filtering or other transformation is needed, the separate `samtools view -b -` stage is unnecessary. This avoids a full WGS-sized SAM intermediate, though sorting still needs scratch space.

A streaming pipe requires producer and consumer commands to be active concurrently so the consumer can drain output and backpressure can reach the producer. Keep each command single-threaded, permit only this bounded concurrency inside a declared pipeline, and run one pipeline at a time. Do not run independent samples or workflows concurrently in phase one.

If the chosen WASI runtime cannot connect bounded binary streams between commands, use a measured disk-backed intermediate as a fallback. Prefer compressed/binary intermediates when compatible with the next tool. Do not silently spill uncompressed SAM for large-genome workflows.

A checkpoint manifest should record input identities/checksums, command and arguments, environment, module and runtime versions, file paths, output checksums, and stage state. Mark a stage complete only after its outputs are closed and validated. On restart, revalidate checkpoint artifacts and resume from the last valid stage; treat partial outputs as incomplete and safe to replace.

WASI modules may use large amounts of linear memory even when their files are disk-backed. Test guest memory limits and disk usage independently. Check available disk space where possible, and handle disk exhaustion, permission loss, cancellation, and browser shutdown as expected outcomes. Access to a previously selected directory may require the user to grant permission again.

## First Prototype Milestone

Build a tiny `wasm32-wasip1` command that accepts an output path and size, writes deterministic data in bounded chunks using ordinary Rust filesystem calls, and prints progress/errors to standard streams. Run it in the chosen browser WASI runtime with an explicitly preopened, user-selected test directory. Verify:

1. Arguments, exit status, stdout, and stderr reach the host correctly.
2. The guest can create and close a multi-chunk file under its preopened directory.
3. A browser refresh/reopen preserves the file and allows access to the selected directory, including any required permission renewal.
4. An interrupted write is not marked complete and can be safely retried.
5. The final artifact appears directly in the selected directory without an OPFS copy, or document why direct access is unsupported.
6. Confirm single-threaded commands run in workers without UI stalls; verify that only the producer/consumer pair in an explicit pipe overlaps and that independent jobs remain sequential.

This prototype validates one runtime and one filesystem path; it does not prove that arbitrary WASI tools or filesystem calls are supported.
