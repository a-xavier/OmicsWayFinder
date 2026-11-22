# Chips: Workflow Engine (planned)

Status: **design, not started**. Nothing here is implemented yet.

Chips runs multi-step analyses on top of [Mayo](../execution_backend/emscripten/README.md) (tools in the browser on the user's folder). It keeps track of **inputs, outputs, tools and commands**, uses **hashes** to know what changed, runs as many tasks at once as the computer allows, and **resumes** after a failure or a closed tab without redoing finished work. Think of it as a small Nextflow/Snakemake for the browser.

## Objectives

1. **Dynamic pipelines from decision contracts.** [Omics Decision Contracts](../../../Contract_Spec_Drafting/README.md) choose the commands and arguments, and Chips assembles them into a pipeline, ideally as soon as the user drops their input files, when the evidence is fast enough to get. See [Contracts and Dynamic Pipelines](#3-contracts-and-dynamic-pipelines).
2. **A small file per command** (for example `samtools sort`) listing its inputs, outputs and arguments. It drives validation, command building, contracts, and a Galaxy-style GUI where steps are connected by compatible inputs and outputs. See [Command Files](#1-command-files).
3. **A pipeline format** that says "feed A to X, which produces B; feed B to Y", easy to parse, with `dispatch` (one task per item) and `collect` (gather items into one input) for now. See [Pipeline Format](#2-pipeline-format).

Roles:
- **Contracts** decide *what* to run and *with which arguments*, and why.
- **Command files** say what each command accepts, produces and allows.
- **Chips** turns a pipeline into tasks, decides *when* and *how many at once*, records what happened and skips what is already done.
- **Mayo** *runs* one command or pipe (`minimap2 … | samtools sort …`) in workers.

## Prior Art (checked November 2026)

There is no browser workflow engine we can reuse, so we build a small one and borrow formats and ideas.

| Project | Takeaway for Chips |
|---|---|
| [snakemake-wasm-app](https://github.com/snakemake/snakemake-wasm-app) | Real Snakemake in Pyodide plus an x86 Linux VM. Proves the idea but is too heavy, Chromium-only (JSPI), has no folder persistence or resume and no licence file. Worth reading for UI ideas. |
| Nextflow | A work folder per task keyed by a hash, `-resume`, `publishDir`, resource labels, `errorStrategy`, `collect()`. |
| Snakemake | `temp()` outputs, rerun when code or parameters change. |
| WDL / CWL | Typed steps with named inputs and outputs wired by reference (`step.output`); `scatter`. |
| Galaxy | Tool XML with typed, format-checked inputs and outputs; the workflow editor connects compatible ports. The model for the command files and the GUI. |
| [Boutiques](https://boutiques.github.io/) | JSON descriptors for command-line tools: inputs with flags, types, choices, ranges; output path templates; mutually-exclusive groups. The command file follows its model. |
| Bazel / Nix | Content-addressed caching, and *early cutoff*: if a rerun produces the same output, downstream steps are not rerun. |
| [nf-core modules `meta.yml`](https://github.com/nf-core/modules), bio.tools + EDAM | Per-module input/output types and patterns; tool identity and operation/format terms. |

## Concepts

| Term | Meaning |
|---|---|
| **Tool** | A program Mayo can load (`tool/version`), pinned by version and `.wasm` hash. |
| **Command** | One thing a tool does, like `samtools sort` or `minimap2` mapping, described by a command file. |
| **Port** | A named input or output of a command, with formats. Pipelines connect ports. |
| **Pipeline** | Steps connected by references (`trim.reads` feeds `align.reads`), with `dispatch` and `collect`. |
| **Step** | One node of a pipeline: a command (or a pipe of commands) with bound inputs and arguments. |
| **Task** | One concrete run of a step: actual files, actual values, a rendered command line. The unit of caching. |
| **Run** | One execution of a pipeline. Runs share the same task cache. |

## 1. Command Files

### Supported and Custom Commands

| Level | What it needs | What users get |
|---|---|---|
| **Supported** (curated, small: samtools, bcftools, minimap2, fastp, …) | A command file, plus tests against the native tool. | Contract recommendations, GUI ports and forms, validation, accurate scheduling and caching, "validated" in provenance. |
| **Custom** (bring your own Mayo-compatible tool) | A step with a free command line and declared inputs and outputs (see [Custom steps](#custom-steps)). | Runs, caches and resumes with safe defaults. Marked "unvalidated". Never suggested by contracts. |

A command becomes supported by adding its file and tests; the engine does not change. Start with the commands needed for one complete path (FASTQ → trim → align → sort/index → stats).

"Mayo-compatible" means an Emscripten build with the biowasm-style glue (`<program>.js` + `.wasm`, `callMain`, `FS` exported), not any `.wasm` file. WASI builds would go through a future WASI backend, Java tools through the Java backend.

### Layout

One small file per command, grouped by tool version. Arguments change between versions, so a version bump means copying the folder and checking the differences (see [Checks](#checks)).

```
src/lib/chips/tools/
  samtools/1.21/
    tool.yaml        shared: Mayo spec, .wasm hash, homepage, citation, bio.tools id, thread flag
    sort.yaml
    index.yaml
    view.yaml
  minimap2/2.28/
    tool.yaml
    map.yaml         minimap2 has no subcommands; its command files name its modes
```

A command is referred to as `tool@version/command`, for example `samtools@1.21/sort`.

### What a Command File Controls

Every argument of the command: what it is, its type, which arguments are input or output files, what is allowed together, and how to show it. From it Chips can:
- build the command line from values (never by pasting strings), so quoting and injection are not an issue;
- validate values before running (types, ranges, choices, required, conflicts);
- know a task's inputs and outputs exactly, including files the tool reads without being told (`.fai`, `.bai`) and outputs named after an input (`in.bam.bai`);
- show the command as a **node with typed ports** in a Galaxy-style editor, allowing only connections whose formats match;
- generate accessible forms: labels, help, units, sections, advanced options hidden by default, file pickers filtered by format;
- tell contracts and the planner which formats a command accepts and produces (EDAM).

Sketch (partial, not final):

```yaml
# samtools/1.21/tool.yaml
chips-tool: "0.1"
tool: samtools
version: "1.21"
mayo: samtools/1.21
wasm-sha256: "…"
homepage: https://www.htslib.org
biotools: samtools
citation: https://doi.org/10.1093/gigascience/giab008
threads: { flag: "-@", extra: 1, output-depends-on-threads: false }
```

```yaml
# samtools/1.21/sort.yaml
chips-command: "0.1"
command: sort
argv: [samtools, sort]
label: Sort alignments
operation: { id: "http://edamontology.org/operation_3802", label: "Sorting" }
sections: [Output, Sort order, Performance]

inputs:                                   # ports that read files
  - id: input
    position: 0
    formats: [sam, bam, cram]
    stdin: true                           # can be fed by a pipe
    label: Alignments to sort
outputs:                                  # ports that write files
  - id: output
    flag: -o
    formats: [bam, sam, cram]             # actual format from output_format, else file extension
    default: stdout
    stdout: true                          # can feed a pipe
    label: Sorted alignments
    section: Output
  - id: index
    path: "{output}.csi"
    when: write_index                     # only produced when that argument is set
    formats: [csi]
arguments:                                # values that are not files
  - id: output_format
    flag: -O
    type: enum
    choices: [sam, bam, cram]
    section: Output
    advanced: true
  - id: by_name
    flag: -n
    type: flag
    label: Sort by read name instead of position
    section: Sort order
    conflicts: [by_tag_only]
  - id: memory_per_thread
    flag: -m
    type: size
    default: 768M
    section: Performance
    affects-output: false                 # left out of the task key
  - id: tmp_prefix
    flag: -T
    type: temp-prefix                     # scratch files, placed in the task folder
    default: "{work}/sort.tmp"
  - id: write_index
    flag: --write-index
    type: flag
  # … every other sort argument, or listed under `unsupported`
unsupported:
  - { flag: --reference, reason: "Not tested with URL references yet" }
resources: { memory: "memory_per_thread × threads + 200 MB" }
reproducible: { byte-identical: false, because: "@PG line contains the command; use --no-PG for stable output" }
```

Port and argument fields:

| Field | Meaning |
|---|---|
| `id` | Stable name used in pipelines, contracts and forms. |
| `flag` / `position` / `path` | How it appears: `-o`, `--output`, a positional index, or a path template for outputs that are not on the command line (`{input}.bai`). `repeat`, `separator` for lists. |
| `formats` | Short format names mapped to EDAM URIs in one shared table (`src/lib/chips/formats.yaml`). Ports connect only when formats overlap. |
| `stdin` / `stdout` | The port can be fed by, or feed, a Mayo pipe. |
| `reads` | Files read implicitly next to an input (`{input}.fai`, `{input}.bai`), so they are hashed and staged too. |
| `when` / `unless` | Conditional outputs. |
| `type` | Arguments: `int`, `float`, `size`, `string`, `enum`, `flag`, `list`, `temp-prefix`. |
| `default`, `min`, `max`, `choices`, `required` | Validation. |
| `conflicts`, `requires`, `one-of` groups | Allowed combinations. |
| `affects-output` | `false` keeps the value out of the task key (threads, memory, temp paths). |
| `label`, `help`, `section`, `advanced`, `unit` | Forms. Labels and help are required, for accessibility. |

**Coverage:** describe whole commands, starting with those contracts use. Commands without a file are not available as supported (they can still run as custom steps). Within a command file, every argument is either described or listed under `unsupported` with a reason, so nothing passes through unchecked.

**Starting material:** Galaxy's curated wrappers (for example the `tools-iuc` samtools wrappers) already list parameters with labels, help, sections and formats for many commands; check the licence before reusing text.

### Checks

- **File vs tool:** a script runs each command's usage (`samtools sort` with no arguments prints it) in Mayo and lists flags that appear in the usage but not in the file, or the reverse. Run it on every version bump.
- **Behaviour:** a few tests per command with small data, comparing browser output with the native tool (byte-identical, or after removing `@PG` lines and similar), and checking that the declared outputs are exactly the files written (see below).
- **Resources:** measure memory and time on representative inputs to set `resources`.

### Watching File Access

Every file a tool touches goes through MAYOFS, so Mayo can record which files a task actually read and wrote. Chips uses this to:
- check command files in tests (declared outputs = files written);
- warn on custom steps that read files they did not declare, which would break caching;
- record the exact read set in `task.json`, so a change to an undeclared file (an index next to a BAM) still invalidates the cache.

## 2. Pipeline Format

### Choice

| Base | Good | Bad for us |
|---|---|---|
| Snakemake | File patterns and wildcards. | Python; works backwards from requested files, harder to show and to generate. |
| Nextflow | Channels, `collect`, widely known. | Groovy; can't be interpreted in the browser. |
| WDL / CWL | Typed steps wired by reference, `scatter`. | Verbose; needs parsers we would write. |
| Bpipe | Very small (`run { a + b }`). | Implicit file naming; little adoption. |

**Decision:** YAML (or the same structure as JSON), with steps wired by reference as in WDL/CWL, and two operators for now: `dispatch` and `collect`. Contracts, the GUI and people can all produce it; a schema validates it; it is hashed without interpreting a language. Text front ends (Bpipe-style `trim + align + index`) can come later and compile to the same structure.

### Structure

```yaml
chips: "0.1"
name: align-short-reads

inputs:                                    # what the user provides
  samples:   { type: list, item: { r1: fastq, r2: fastq } }   # from the dropped files
  reference: { type: file, format: fasta } # may be a Mayo URL link file

steps:
  trim:
    run: fastp@0.23.4/trim
    dispatch: samples                      # one task per sample
    in:   { reads1: samples.r1, reads2: samples.r2 }
    contract: odc:fastq-end-trimming       # arguments decided by the contract

  align:
    run: [minimap2@2.28/map, samtools@1.21/sort]   # a list = a Mayo pipe, stdout → stdin
    dispatch: trim                         # one task per trim task, same item keys
    in:   { reads: [trim.out1, trim.out2], reference: reference }
    args: { sort.output: "{item}.sorted.bam" }
    contract: { map: odc:minimap2-preset }

  index:
    run: samtools@1.21/index
    dispatch: align
    in:   { input: align.output }

  merge:
    run: samtools@1.21/merge
    in:   { inputs: collect(align.output) }  # all items as one list input
    args: { output: merged.bam }

outputs:                                   # published to results/
  per_sample: [align.output, index.output]
  merged: merge.output
```

### Rules

- **References:** `name` is a pipeline input; `step.port` is an output port of a step; inside a pipe, `command.port` (`sort.output`) addresses one stage. The graph is built from these references; step order in the file does not matter. Cycles are an error.
- **Values:** every reference is either *single* (one file or value) or *dispatched* (one per item, keyed by item id).
- **`dispatch: X`:** run one task per item of `X`, where `X` is a list input or a dispatched step. Outputs are dispatched with the same item keys. Two dispatched references in one step are paired by item key (not by position); mismatched keys are an error. Single references (like `reference`) are shared by every item.
- **`collect(ref)`:** turns a dispatched reference into one list, ordered by item key, for a step that takes many inputs (`samtools merge`, MultiQC). The step then runs once.
- **Item keys:** from the input list (sample id from the dropped files: the FASTQ pair grouping in [biotypes.ts](../biotypes.ts), or the file name stem). `{item}` is usable in output names.
- **Pipes:** `run: [A, B]` connects A's `stdout` port to B's `stdin` port with a Mayo pipe; both ports must allow it in their command files. The whole pipe is one task.
- **Arguments:** `args` by argument `id` from the command file; values are checked against it. Values may use `{item}` and `{params.x}`. Contract-chosen arguments are merged first, `args` last (an explicit `args` value overrides a contract and is recorded as a user override).
- **Output names:** default to `{item}.{step}.{ext}` inside the task folder; set explicitly only for files people will look at.
- **Validation before running:** every referenced step and port exists; connected formats overlap; required inputs are bound; argument values are valid; dispatch keys match.

### Custom Steps

For a tool without command files, a step gives a free command line and declares its ports:

```yaml
  trim_custom:
    tools: [seqtk@1.4]
    dispatch: samples
    in:   { reads: samples.r1 }
    out:  { trimmed: { path: "{item}.trim.fq", format: fastq } }
    command: seqtk trimfq {in.reads} > {out.trimmed}
```

Placeholders are quoted by Chips. Without command files Chips uses safe defaults: 1 thread, every argument in the task key, a conservative memory budget, no form, and "unvalidated" in provenance.

## 3. Contracts and Dynamic Pipelines

A contract today names its software, its input and output formats (EDAM), measured evidence (`stats.*`), thresholds, default `arguments` and `rules` (see [minimap2-preset.yaml](../../../Contract_Spec_Drafting/minimap2-preset.yaml)). Chips connects contracts in three places.

### Contract to command

- Add a `command: minimap2@2.28/map` field to contracts (proposed change to the contract format), so a contract points at exactly one command file instead of only `software.name`.
- Contract `arguments` keys are CLI flags today (`-x`, `--trim_front1`). Chips maps each flag to the argument `id` in the command file and validates the value. A flag that is missing from the command file, or listed as `unsupported`, makes the contract invalid; it never reaches the command line unchecked.
- The contract's `input_format` and `output_format` must match ports in the command file; checked once, when contracts and command files are loaded.

### Building the pipeline at input drop

```
dropped files ─► validate & quick evidence (current app) ─► goal ─► planner ─► pipeline (YAML) ─► user review ─► run
```

1. **Evidence.** The app already validates dropped files and computes quick statistics from file slices (read length, quality, format, pairing). This is fast, and is exactly what the minimap2 preset contract uses.
2. **Goal.** What the user wants, for example "aligned, sorted, indexed BAM" or "QC report". Chosen by the user or suggested from the files; the planner does not guess the purpose of the analysis.
3. **Planner.** Starting from the dropped files' formats, chain commands whose input ports accept the current formats until the goal formats are produced, using only commands that have a contract for the decision they need (or no decision to make). Each contract evaluates its rules on the evidence to set arguments. The search is small (a handful of commands), so it runs instantly.
4. **Pipeline.** The planner writes an ordinary pipeline document (section 2). It can be shown in the GUI, edited, saved, rerun and hashed like a hand-written one. Each step records which contract and which rule chose its arguments, with the evidence values used.
5. **Review.** The user sees the steps, the choices and their explanations before anything runs. Missing evidence or several possible routes become questions, not silent defaults (as the contract rules already require).

### Decisions that need more than a quick look

Some evidence is only available after a step runs: whole-file quality (FastQC), duplication rate, insert size after alignment. These decisions cannot be made at drop time. Two options, both kept explicit:
- **Decide later in the pipeline:** a step may be marked `decide: odc:…`. Its arguments are left open until the steps producing the evidence finish; Chips then evaluates the contract and records the decision. Its task key includes the decision, so caching still works.
- **Measure first:** the planner adds a measuring step, runs only that, and plans the rest once the evidence exists.

Steps that might be *skipped* by a decision (a contract saying "no trimming needed") pass their input through unchanged, so later references stay valid.

### What has to exist

- Quick evidence for each input type (partly done: FASTQ, alignment, variant, FASTA, BED validators).
- A goal list with their target formats.
- The `command` field and flag-to-id mapping in contracts.
- The planner: a small search over command files plus contract evaluation, written as pure functions with tests.

## Hashing and Change Detection

The **task key** is a hash of everything that can change a task's output:

- Chips format version.
- Each tool: name, version and the SHA-256 of its `.wasm`, so rebuilding a tool reruns its tasks.
- The rendered command, normalised: paths inside the work folder replaced by placeholders, whitespace collapsed.
- Parameter values.
- Input fingerprints, in input order.

Not in the key: thread counts and memory, when the tool declares that output does not depend on them. Otherwise `-t 6` vs `-t 4` would rerun everything on another computer.

**Input fingerprints**, cheap first, content when needed:

| Mode | Fingerprint | Cost |
|---|---|---|
| Quick (default for user files) | path + size + `lastModified` | Free. Misses a file replaced by another with the same size and time (rare). |
| Content | Streaming hash of the bytes | Seconds per GB. `crypto.subtle.digest` is one-shot only (whole file in memory), so use an incremental Wasm hash (for example xxHash3 or BLAKE3 from a small library). |
| URL link | URL + `ETag` / `Last-Modified` + size from `HEAD` | One request. |

- Content hashes are cached in `.chips/hashes.json`, keyed by path + size + `lastModified`, so each file is hashed once.
- **Outputs are hashed when a task finishes**, and downstream task keys use those output hashes, not the upstream key. Changes propagate down the graph, and **early cutoff** works: if a rerun of `align` produces an identical BAM, `index` is not rerun.
- Before skipping a task, check that its recorded outputs still exist with the same size and `lastModified`. If the user edited or deleted one, rerun that task and everything after it.
- Not every tool is byte-for-byte reproducible. `@PG` header lines contain the command line and gzip headers can contain timestamps. Early cutoff then just doesn't trigger; correctness is unaffected. Keep work-folder paths out of command lines where possible so `@PG` stays stable.

## Folder Layout

Everything lives in the user's folder, so the history moves with the data:

```
<selected folder>/
  .chips/
    work/ab/cdef…/          one folder per task, named by its key
      outputs…
      .command              rendered command
      .stdout .stderr
      task.json             status, exit code, key, input/output fingerprints, times, resources
    runs/<run id>.json      the pipeline, parameters, task list, timeline, device info
    hashes.json             content-hash cache
  results/                  published outputs
```

- **Commit marker:** a task is done only when `task.json` with `status: "done"` exists. It is written last, after exit code 0 and after every declared output exists. Mayo file writes already go to a swap file and appear on close, but a task folder without a done `task.json` is treated as incomplete and cleared on resume.
- **Publishing:** the File System Access API has no symlinks or hard links. Options: copy (doubles disk use), move (the cache entry then points at `results/`), or have the last step write straight into `results/`. Proposed: move, and record the published path as the cached output location.
- **Temporary outputs** (Snakemake `temp()`): deleted once all consumers are done, which matters for multi-GB SAM/BAM intermediates. A deleted temporary output means its task reruns if a later change needs it.
- **Cleaning:** `chips clean` removes task folders not referenced by any kept run.

## Resources and Scheduling

**Detecting the computer:**

| Signal | Notes |
|---|---|
| `navigator.hardwareConcurrency` | Logical cores; already detected in the app. |
| `navigator.deviceMemory` | Chromium only, coarse (rounded), capped. A hint, not a limit. |
| Wasm limits | 32-bit Wasm: at most 4 GB per tool instance, regardless of RAM. |
| Free disk | No API for the user's real disk (`navigator.storage.estimate` covers browser storage only). Estimate output sizes and warn; handle write errors. |

**Per-command resources:** threads (passed through the tool's thread flag, see the multi-threading note in the root README TODO), memory estimate (fixed, or a function of input size), optional labels like nf-core `process_low` / `process_medium` / `process_high`. A Mayo pipeline is one task whose resources are the sum of its stages.

**Scheduler:**
- Keep a ready queue (all inputs available) and start tasks while the CPU and memory budget allows. Leave one core for the page.
- Prefer tasks that let temporary files be deleted sooner, and tasks on the longest remaining path.
- If one task needs more than the whole budget, run it alone and warn, rather than never starting it.
- All tasks share Mayo's single I/O worker, so file-heavy tasks can be limited by it, not by CPUs. Measure before tuning.

## Resume, Failure and Browser Concerns

- **Resume:** build the graph, compute each task key in order, skip tasks with a valid done `task.json`, and run the rest. Resume is the normal way to run, not a special mode.
- **Failure:** per-step `errorStrategy`: `stop` (default: finish running tasks, start no new ones), `retry` (n times, optionally with more memory), `ignore`. Keep failed task folders for inspection.
- **Closed tab or reload:** running tasks die with the page. Their folders have no done marker and are cleared on the next run. The folder must be granted again after reload (Mayo already remembers it).
- **Two tabs on one folder:** take a Web Lock named after the folder so only one tab runs Chips on it. A lock file in `.chips/` catches other browsers or computers, with a timeout for stale locks.
- **Sleep:** a sleeping laptop stops everything. Offer the Screen Wake Lock API during long runs.
- **Dynamic outputs:** some tools write an unknown number of files (splitting by chromosome). Declare a file pattern; it is resolved after the task finishes and fans out to downstream tasks.
- **Cancel:** uses Mayo's planned `cancel()`; the task is marked `cancelled` and its folder cleared.

## Provenance

Each run records the pipeline, parameter values, tool versions and `.wasm` hashes, device info, and for each task the command, the input and output fingerprints, exit code and times. If arguments came from a decision contract, record its `id` and the evidence used. Later: export as a [Workflow Run RO-Crate](https://www.researchobject.org/workflow-run-crate/) for sharing and publication.

## Dependencies on Mayo

- Mayo now has per-tool workers and pipes (one task can be a pipe), but runs one `exec` at a time; running tasks in parallel needs concurrent `exec` support.
- `cancel()`, a per-task working folder (a `cwd` inside `.chips/work/…`), and exit codes and stderr per run.
- A list of files read and written per run, collected in MAYOFS.
- Multi-threaded tool builds for `threads` to mean anything.

## Open Questions

1. Hashing default: quick (size + time) with content hashing only for outputs, or content hashing for everything?
2. Publishing: move, copy, or write straight into `results/`?
3. Several pipelines running at once, or one at a time per folder?
4. Command files: our own YAML modelled on Boutiques (proposed), or Boutiques JSON as-is plus an extension block for EDAM, GUI and resource fields?
5. Should supported commands allow an "extra arguments" escape hatch (marking the task unvalidated), or be strict?
6. Contracts: add the `command` field and switch `arguments` keys from CLI flags to argument ids, or keep flags and map them?
7. Goals: a fixed list to start with (which ones?), and who picks the goal when several fit the dropped files?

## Order of Work

1. Schemas: command file, tool file, pipeline, with validators. The shared EDAM format table.
2. Command files for one complete path (for example fastp, minimap2, samtools sort/index/stats/merge), with the usage-vs-file check and native comparison tests.
3. Pipeline loading: references, `dispatch`, `collect`, pipes, validation, graph and cycle check. Pure functions with Node tests.
4. Hashing: task keys, quick fingerprints, incremental content hash, `hashes.json`.
5. Task folders and the `task.json` commit marker; run one task through Mayo with a working folder.
6. Scheduler with the resource budget (one task at a time first, parallel once Mayo tool workers exist).
7. Resume, failure strategies, temporary outputs, publishing, lock.
8. Contracts: `command` field, flag-to-id mapping, rule evaluation into step arguments.
9. Planner: goals, chaining by format, decisions at drop time; then `decide:` steps evaluated during a run.
10. GUI: pipeline as nodes and typed ports (Galaxy-style), forms from command files, task states, logs, cancel, resume.
11. Provenance export.
