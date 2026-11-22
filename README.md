# OmicsWayfinder

**A research project exploring guided, reproducible biological analysis in the browser.**

OmicsWayfinder investigates whether unfamiliar biological files can be turned into
scientifically justified analyses without requiring researchers to install a
specialist software environment or configure hundreds of command-line arguments.
The goal is to connect file evidence, experimental context, explicit scientific
decisions and accessible local execution, while making uncertainty and limitations
visible.

## Try the live prototype

# **[Open OmicsWayfinder in your browser](https://a-xavier.github.io/OmicsWayFinder/)** 

## Research Aims

1. **Extract evidence from biological files.** Identify and validate files, then
	recover metadata and properties such as read quality, sequencing platform,
	reference assembly and processing history. This is the current prototype's
	main implemented capability; systematic accuracy and generalisation remain to
	be evaluated.

2. **Reconstruct scientific and experimental context.** Investigate how reliably
	file evidence can distinguish whole-genome and whole-exome sequencing
	(WGS/WES), DNA and RNA sequencing, arrays and other assays, and identify
	organisms, including human versus non-human data. Separate what is observed
	from what is inferred, and ask targeted questions when files cannot establish
	the assay, controls, groups, replicates or other essential study information.

3. **Establish an open Omics Decision Contract format.** Aim to make every
	consequential analytical decision explicit and machine-readable: prerequisites,
	compatible tools and references, parameter-selection rules, clarification
	questions and supported claims. The research question is how much of this
	decision-making can be automated transparently and validated against expert
	judgement and benchmarks, rather than passed to users as hundreds of settings.
	Contracts must also explain when to skip a step or refuse an unsupported
	analysis. Read the [draft format overview](Contract_Spec_Drafting/README.md)
	and explore the [FASTQ trimming example contract](Contract_Spec_Drafting/Contract.yaml).

4. **Build a persistent browser workflow and execution engine.** Explore the
	Origin Private File System (OPFS) and IndexedDB for disk-backed intermediates,
	outputs, provenance and checkpoints. Test whether feasible workflows can run
	locally without mandatory data upload, resume safely after interruption and
	reproduce native results. Establish practical memory, storage and browser
	limits rather than assume every workload can run on every device. This will make full use of WASM technology and WEBGPU when needed.

5. **Produce statistical reports where scientifically supported.** Return
	documented analysis-ready outputs by default. When suitable study-design
	information is available, investigate supported comparisons, effect sizes,
	uncertainty and interpretable biological findings. Missing controls or
	replication must constrain conclusions, not be silently guessed.

6. **Make analysis accessible and ergonomic.** Design and evaluate the experience
	with researchers with disabilities and people using assistive technologies.
	Priorities include keyboard and screen-reader access, understandable language,
	clear uncertainty, manageable cognitive load and efficient workflows for
	different levels of experience.

## Development TODO

Work in progress on the browser execution engine (Mayo, the Emscripten backend). Read
[src/lib/execution_backend/emscripten/README.md](src/lib/execution_backend/emscripten/README.md)
first: it documents the current design, the API, the test setup and the planned work in detail.

**Current state:** tools (samtools, bcftools, seqtk, minimap2, …) run single-threaded, one worker
per tool instance, reading and writing the user's selected folder directly through a shared
synchronous I/O worker. Commands can be streaming pipelines (`minimap2 … | samtools sort … -`),
with every stage running at the same time, live stderr, `pipefail` exit codes and `Mayo.cancel()`.
Redirection (`<`, `>`, `>>`, `2>`) works. Remote files work as *URL link files* in the folder
(one line, `mayo-url <url>`), read lazily with HTTP range requests through a cache in the I/O
worker. Test everything with the Mayo tester page in real Chrome.

1. **Commit the URL link and pipes work.** Not committed yet; all of it is tested in Chrome and
	with `node --test` (see the "Pipes" and "Remote Files" sections of the emscripten README):
	- URL links: `mayo-url-fs.ts`, MAYOFS link support, `Mayo.addUrl`, the tester's "Remote files"
		panel.
	- Pipes: `mayo-pipe.ts`, `mayo-tool.worker.ts`, the multi-client I/O worker,
		`mayo-remote-cache.ts`, `parsePipeline`, `cancel()`, live stderr, and the tester's Stop button.
	- `&&` chains: `parseCommand`, the chain runner in `MayoTools.exec`, `pipeline` on stage results.
	- The old `mayo-worker.test.mjs` is deleted; `mayo.test.mjs` now tests `parseCommand`/`parsePipeline`.

2. (Done) Fix or replace the stale Node test.

3. (Done) Streaming pipes with one worker per tool. Settled: `pipefail` (ignoring broken-pipe
	stages), live stderr, no limit on the number of stages. `&&` is done too. Possible follow-ups:
	`||`, `;`, `2>&1`,
	quoting, and a memory-based warning for long pipelines.

4. **Multi-threaded tools (Emscripten pthreads) inside pipes**, e.g.
	`minimap2 -t 6 -ax sr ref.fa r1.fq r2.fq | samtools sort -@ 2 -o aln.bam -`. Not yet in the
	emscripten README. Add it there as a subsection of the "Pipes" section, then build it:
	- Each tool worker is the pthread "main thread". Its pthreads are nested workers that share only
		that tool's Wasm memory. Tools still connect only through the pipe.
	- Pthread file calls are forwarded to the tool worker's main thread, so MAYOFS, URL links and
		pipe devices work unchanged.
	- Nested workers cannot start while the tool worker is blocked in `callMain`. Build with
		`-sPTHREAD_POOL_SIZE=<JS expression, e.g. Module.mayoThreads>` and
		`-sPTHREAD_POOL_SIZE_STRICT=2`, and size the pool *before* `main` starts.
	- Tool manifests declare their thread flag: minimap2 `-t N` needs N threads; samtools `-@ N`
		means N *extra* threads, so N+1. The coordinator reads the flag to size each pool.
	- The coordinator checks the total threads against the detected core count (already detected in
		the app) and warns or caps.
	- Mayo's own `Atomics.wait` calls (I/O and pipe) must only wait on *other* workers, never on
		the tool's own pthreads, or they can deadlock.
	- Build flags: `-pthread`, `-msimd128` (minimap2), `-sEXIT_RUNTIME=1`, and a maximum memory
		setting (wasm32 caps out at 4 GB per tool, too small for a whole human minimap2 index). Point
		`samtools sort -T` at the folder so temporary files spill to disk.
	- `cancel()` must also terminate the tool's pthread workers.
	- This replaces the "tools stay single-threaded" rule in the emscripten README; update it.

5. **Java tools (future, parked).** GATK, snpEff, SnpSift and Beagle via CheerpJ, streaming the
	selected folder through a Java NIO bridge. The design and a proposed spike are in
	[src/lib/execution_backend/java/README.md](src/lib/execution_backend/java/README.md).

6. **Chips, the workflow engine on top of Mayo.** Tracks inputs, outputs, tools and commands,
	hashes them to detect changes, schedules tasks to fit the device, and resumes runs. Design,
	open questions and order of work are in [src/lib/chips/README.md](src/lib/chips/README.md).
	Settle the open questions (especially the syntax) with the maintainer before starting. Tool
	workers and pipes (step 3) are in place; running independent tasks in parallel still needs
	Mayo to accept several `exec` calls at once.

** RESEARCH USE ONLY **