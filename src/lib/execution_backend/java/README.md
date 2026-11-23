# Java Backend (CheerpJ)

Status: **early spike**. CheerpJ 5 runs Java 21 in the page; `CheerpTester` (Analyser page, below the Mayo tester) prints the selected folder as a tree from Java, and runs bundled Java tools or a jar from the folder that reads and writes files in it (copy in and out, below), with the redirections `<`, `>`, `>>`, `2>` and `2>>`. No pipes yet, and not yet wired into Mayo commands.

## What Exists

| File | Role |
|---|---|
| `cheerpj.ts` | Loads the CheerpJ loader from its CDN once, starts the JVM (`cheerpjInit({ version: 21 })`), runs one main at a time through `omics.cheerp.Launcher`. `JAVA_TOOLS`, `runPublicToolCommand`, `runJava`, `javaFolderTree`, `runJarFromFolder`, `runJarCommand` (commands with redirections, parsed by [../shared/command.ts](../shared/command.ts)). Implements the `Stdio` natives. |
| `folder.ts` | JavaScript side of the folder: the natives of `omics.cheerp.Folder` on the folder handle, and `inputsForArgs` (which files to copy in). Paths go through [../shared/folder.ts](../shared/folder.ts), as in Mayo. |
| `src/omics/cheerp/Launcher.java` | Entry point of every run: connects the standard streams (`Stdio`), copies files in, runs the main class (or `-jar` with its own class loader), copies results back, reports the exit code. |
| `src/omics/cheerp/Stdio.java` | `System.out`/`System.err` as bytes to the page or to a redirect file, `System.in` from a `<` file (see [Redirections](#redirections)). |
| `src/omics/cheerp/Workspace.java` | The copy in and out of `/files/`. |
| `src/omics/cheerp/Folder.java` | Native methods implemented in `folder.ts`: `list`, `inputs`, `read`, `create`/`write`/`close`, `mkdir`. |
| `src/omics/cheerp/ExitTrap.java` | Turns `System.exit` into an exception (SecurityManager), so the copy back still runs. |
| `src/omics/cheerp/FolderTree.java` | Spike: prints the folder as a tree through `Folder.list`. |
| `scripts/build-java.mjs` | `npm run build:java`: compiles the Java sources (`--release 17`) into `public/java/omics-cheerp.jar` (served as `/app/java/omics-cheerp.jar`). The jar is committed, so building the site needs no JDK. |
| `public/java/gatk/`, `scripts/build-gatk.mjs` | `npm run build:gatk`: `public/java/gatk/4.6.2.0/gatk.jar`, GATK from Maven Central merged with the 59 jars it loads (78 MB instead of 375 MB), traced on a test sample. Java tools follow the Emscripten tools' layout, `java/<tool>/<version>/<tool>.jar`. See [public/java/gatk/README.md](../../../../public/java/gatk/README.md). |
| `scripts/fetch-java-tools.mjs` | Downloads checksum-pinned Java releases, licences and corresponding source where applicable. Also run as part of `npm run build:tools`. |

### Java Tools

The bundled tools below are early experiments, not certifications of every option or dataset. Java runs on one browser thread, and commands run one at a time. The small browser examples used an OPFS directory handle to exercise the folder bridge.

| Tool | Purpose | Status |
|---|---|---|
| [GATK](https://gatk.broadinstitute.org/) 4.6.2.0 | Variant calling and sequencing analysis, including some Picard commands | Bundled; see the [GATK recipe](../../../../public/java/gatk/README.md) for traced coverage. |
| [SnpEff and SnpSift](https://pcingola.github.io/SnpEff/) 5.4c | Variant annotation and VCF manipulation | Bundled; small annotation and field-extraction examples tested. |
| [Trimmomatic](https://github.com/usadellab/Trimmomatic) 0.40 | FASTQ trimming | Bundled; single-end quality and adapter trimming tested. Use `-threads 1`. Version 0.41 requires Java 25. |
| [Beagle](https://faculty.washington.edu/browning/beagle/beagle.html) 5.5 | Genotype phasing and imputation | Bundled; help works, but a small browser phasing test stalled while a comparable desktop run completed. |
| [FastQC](https://www.bioinformatics.babraham.ac.uk/projects/fastqc/) 0.13.0 | Read quality reports | Bundled; small FASTQ reports tested. See the [FastQC recipe](../../../../public/java/fastqc/README.md) for options and limitations. |
| [VarScan](https://varscan.sourceforge.net/) | Variant calling | Use a separately obtained jar via the folder-jar panel; redistribution permission for the published release is unclear. |
| [Picard](https://broadinstitute.github.io/picard/), [fgbio](https://github.com/fulcrumgenomics/fgbio), [JVarkit](https://github.com/lindenb/jvarkit), [IGV](https://igv.org/) | Alignment/variant utilities, UMI analysis, genomics utilities, visualization | Other notable Java tools; standalone packages or graphical tools have not been integrated or tested here. |

SnpEff requires a matching, separately obtained genome database and configuration in the selected folder. Pass the database directory explicitly so it is copied in; for example:

```
snpeff ann -nodownload -noLog -noStats -dataDir data -c snpEff.config genome input.vcf > annotated.vcf
snpsift extractFields annotated.vcf CHROM POS REF ALT > fields.txt
trimmomatic SE -threads 1 -phred33 reads.fastq trimmed.fastq ILLUMINACLIP:adapters/custom.fa:2:30:10 MINLEN:36
```

By default SnpEff can download missing databases and report usage; `-nodownload -noLog` disables those behaviors. Database files and third-party adapter sequences are not supplied. For Trimmomatic, use an adapter FASTA you have the right to use; the embedded `ILLUMINACLIP` path is staged from the selected folder. Other tools and options may make network requests, so offline operation is not guaranteed.

Beagle is GPLv3-or-later; its source and licence accompany its jar. Trimmomatic is GPLv3; its source archive excludes the upstream adapter sequences, which have a separate rights notice. Its bundled Jbzip2 dependency is MIT-licensed and its source and licence also accompany the jar. SnpEff and SnpSift are MIT-licensed; their upstream archives contain third-party notices in the jars. The pinned release URLs and checksums are in `scripts/fetch-java-tools.mjs`.

### How a Jar Sees the Folder

CheerpJ has no API to add a mount, and many tools use `java.io.File` (not NIO), so the folder is mirrored into `/files/`, which is Java's working directory (`user.dir=/files/`):

1. `inputsForArgs` picks the files from the arguments: an argument (or the value of `--key=value`) that names a file in the folder, plus the files next to it that share its name (`reads.bam.bai`, `reads.bai`, `ref.fa.fai`, `ref.dict`); every file under an argument that names a directory (`.` is the whole folder). Absolute paths, `..` and URLs are left alone.
2. `Launcher` empties `/files/` and copies those files in, 1 MB per native `read` (`File.slice` on the folder handle), recording each file's length and CRC32.
3. The tool runs; relative paths such as `normal.pileup` or `out/x.vcf` resolve under `/files/`. `java.io.tmpdir` is `/files/.tmp/`, which is not copied back.
4. After `main` returns, throws or calls `System.exit`, files that are new or whose length or CRC32 changed are written back (`createWritable`, committed on close), new directories are created, and `/files/` is emptied. Files deleted by the tool stay in the folder.

Bundled tools come from `/app/` using the site's base URL. Their names and versions are listed in `JAVA_TOOLS`; for example `runPublicToolCommand(folder, "gatk CountReads -I reads.bam > count.txt")`. A jar from the selected folder is instead added to the in-memory `/str/` mount (`cheerpOSAddStringFile`) at a new path per run.

The page shares the JVM initialization, run queue and native callback state across Java module reloads. Initializing again reuses the same JVM, including after Vite hot updates. The callbacks themselves are registered at startup, so changes to them require a full page reload, which starts a fresh JVM.

Checked in Chrome: `java.io` and NIO reads, writes, `RandomAccessFile`, `FileChannel`, `mkdirs`, a 3 MB binary, an in-place edit of an input, empty directories, temp files, exit codes; `VarScan.jar somatic normal.pileup tumor.pileup out` writes `out.snp` and `out.indel` byte-identical to a desktop JVM.
Bundled GATK `--help`, `CountReads` on a small SAM with stdout redirected, and `CreateSequenceDictionary` with a copied-back output also work in the browser. Help was also tested with a GitHub Pages-style base path.

### Redirections

`runJarCommand(folder, "VarScan.jar mpileup2snp x.pileup --output-vcf 1 > snps.vcf 2> log.txt")` parses the command with the shared parser (the first word is the jar's path in the folder) and refuses pipes. The redirections are handled in JavaScript, outside `/files/`:

- `>`, `>>`, `2>`, `2>>`: the folder file is opened with `openWritable` before the run. `Stdio.java` sends the bytes through the native `Stdio.write` in 1 MB blocks (per line when shown on the page). The file is committed when the run ends, even with a non-zero exit code (as in a shell), and dropped if the run fails to start. `>>` appends correctly, unlike a tool's own append in `/files/` (see below).
- `<`: `System.in` reads the folder file directly, 1 MB per `Folder.read`; it is not copied into `/files/`. Without `<`, `System.in` is empty.
- The `<` file must exist, and stdout and stderr cannot go to the same file.

### Findings

- Java 21 warns when `ExitTrap` installs its deprecated `SecurityManager`. The trap is needed to catch `System.exit` and copy output files back; it is not a security sandbox. Java 24 permanently disabled installing a security manager, so a different exit-handling mechanism is needed before upgrading.
- CheerpJ can log `JIT failure` for `Proxy$ProxyBuilder.addElementType` and `addElementTypes`. These exact messages are tracked in [leaningtech/cheerpj-meta#241](https://github.com/leaningtech/cheerpj-meta/issues/241); a CheerpJ maintainer says they are non-fatal. This does not establish that every tool or output is correct.
- CheerpJ's CDN (`cjrtnc.leaningtech.com`) sends `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin`, so it loads under our COOP/COEP isolation.
- Async natives work as documented: `String` in and out, `byte[]` arrives as an `Int8Array` view of Java's memory (copy it before awaiting), an `Int8Array` returned becomes a `byte[]`.
- **Append is broken in `/files/`**: `FileOutputStream(f, true)`, `FileWriter(f, true)` and NIO `APPEND` write at offset 0 instead of the end. Tools that append to an existing file get wrong results.
- `File.setLastModified` returns false and in-place writes do not change `lastModified` (one-second resolution), hence the CRC32.
- Each file passes through memory and IndexedDB twice (in and out), so this suits small and medium files; large data still needs the streaming bridge below.
- In a local Vite browser test, `gatk --help` requested the entire 78 MiB jar and additional byte ranges (about 111 MB total according to Resource Timing). Download size on GitHub Pages has not been measured.
- GATK made unsuccessful requests to `metadata.google.internal` while running local commands; cloud-provider initialization should be investigated before promising fully offline execution.

## Goal

Run bioinformatics tools written in Java (GATK, snpEff, SnpSift, Beagle, Picard…) in the browser, unchanged, on the folder the user selected. The Mayo command syntax should cover them too, for example:

```
gatk HaplotypeCaller -R ref.fa -I reads.bam -O out.vcf
```

## Java Runtime Options

| Option | How it works | GATK? |
|---|---|---|
| [CheerpJ](https://cheerpj.com/) (Leaning Technologies) | Full JVM in the browser (WebAssembly + JavaScript, compiles bytecode to JavaScript as it runs). Runs unmodified `.jar` files. | **Most realistic.** Full standard library, reflection, threads (all on one thread). Commercial use needs a licence. |
| GraalVM Web Image (Native Image → Wasm) | Compiles the app ahead of time to one `.wasm`. | Experimental. GATK relies heavily on reflection (Barclay command-line parser, plugin discovery, log4j), so it would need a lot of configuration. |
| TeaVM, JWebAssembly, Bytecoder | Compile ahead of time to JavaScript or Wasm. | Partial standard library and reflection; GATK will not run. |
| Doppio | JVM in JavaScript. | Not maintained, Java 8 at most. |

CheerpJ is the only option worth trying.

### CheerpJ Facts (checked against the CheerpJ 5 docs)

- It is not a single `.wasm` file. A loader script (`loader.js`) brings in the runtime (the core JVM in C++ compiled to Wasm/JavaScript, the OpenJDK class library and a JIT to JavaScript). The `.jar` is data: classes are read lazily over HTTP range requests, so a 400 MB jar is not downloaded in full.
- Java 8, 11, 17, 21 and 25 are supported (`cheerpjInit({ version: 21 })`); 21 and 25 need CheerpJ 5.0. The launcher uses `java.security.manager=allow` for Java 21's exit trap; Java 24+ permanently disabled the SecurityManager.
- Running a jar: `cheerpjRunMain("org.broadinstitute.hellbender.Main", "/app/gatk.jar:/app/mayo-nio.jar", ...args)` or `cheerpjRunJar(...)`; both resolve to the exit code.
- Its virtual filesystem has fixed mount points only:
  - `/app/`: the web server, read-only over HTTP (jars live here).
  - `/files/`: writable, kept in IndexedDB; JavaScript reads it with `cjFileBlob`.
  - `/str/`: data added from JavaScript (`cheerpOSAddStringFile`), in memory, read-only for Java.
  - There is **no public API to add a mount**, so FOLDERFS (Mayo's folder filesystem) cannot be plugged in the way it is for Emscripten.
- Java `native` methods can be implemented in JavaScript and **may be `async`**: `Java_<class>_<method>(lib, self?, ...args)`, passed with `cheerpjInit({ natives: { ... } })`. The Java thread waits while the promise resolves. This is the key to the folder bridge below.
- `cheerpjInit({ javaProperties: ["key=value"] })` sets system properties.

## Getting the User's Folder to Java

### 1. Copy In and Out (implemented, see above)

Copy the inputs from the folder into `/files/`, run the tool there, copy the results back. Implemented in Java (`Workspace.java`) through async natives, since JavaScript cannot write to `/files/` directly.

- Simple, works with any Java tool, including ones that use `java.io.File`.
- Every file passes through RAM (or is duplicated in IndexedDB). Fine for VCFs, small BAMs and bacterial genomes; not for a 30 GB BAM, a 3 GB reference and a 20 GB dbSNP.
- Large inputs could be split per region with the Emscripten tools first (`samtools view -b reads.bam chr20`, `samtools faidx ref.fa chr20`, `bcftools view -r chr20 dbsnp.vcf.gz`), with the results merged by `bcftools concat`. GATK pipelines already split this way.
  - Reference slices must be whole contigs: `faidx ref.fa chr20:1-5000000` names the sequence `chr20:1-5000000` and its coordinates start again at 1.
  - GATK checks that contigs agree between the BAM, reference and VCF headers; headers may need `samtools reheader` / `bcftools reheader` (to test).

### 2. Streaming Through a Java NIO Bridge (preferred for large data)

```
Mayo:   gatk HaplotypeCaller -R ref.fa -I reads.bam -O out.vcf
          └─ router: Java tool → CheerpJ runner (not Emscripten)
cheerpjRunMain("org.broadinstitute.hellbender.Main",
               "/app/tools/gatk/gatk.jar:/app/tools/mayo-nio.jar", ...args)

GATK/htsjdk ─ Files.newByteChannel(path) ─▶ MayoFileSystemProvider (small Java jar of ours)
                                              └─ native read(path, pos, len) / write / size / list
                                                   └─ JS (async): folder handle
                                                        read:  (await handle.getFile()).slice(pos, pos + len)
                                                        write: writable.write({ type: "write", position, data })
```

- Reads need no I/O worker and no SharedArrayBuffer: async natives can await `File.slice()`, which gives random access to a multi-GB BAM without loading it. A JavaScript cache of 1–4 MB blocks would cut the number of calls (htsjdk reads in 64 KB blocks).
- Writes use `createWritable()` with explicit positions and are committed on close, as in FOLDERFS.
- Java side, about 500–800 lines: `FileSystemProvider`, `FileSystem`, `Path`, `SeekableByteChannel`, directory listing and attributes. `Path` is the tedious part; it must support `resolveSibling`, because htsjdk finds `reads.bam.bai`, `ref.fa.fai`, `ref.dict` and `.tbi` files next to the main file.
- GATK accepts NIO paths for `-I`, `-R`, `-V`, `--dbsnp` and `-O` (that is how it handles `gs://`). Providers are found through `META-INF/services/java.nio.file.spi.FileSystemProvider`, so having `mayo-nio.jar` on the classpath should make `-I mayo://reads.bam` work.
- With a region (`-L chr20`) or a whole genome, GATK reads only the index blocks it needs, so nothing is copied and memory is only the JVM's own.

#### Without the `mayo://` Prefix

Since Java 9, `-Djava.nio.file.spi.DefaultFileSystemProvider=com.mayo.MayoProvider` replaces the default filesystem. Set through `javaProperties`, plain `reads.bam` paths would go to the user's folder, with `/app/` and `/files/` passed on to CheerpJ's own provider. Untested: CheerpJ may not honour the property.

Either way, code that uses `java.io.File` streams (`FileInputStream`, `RandomAccessFile`) skips NIO. That covers older Picard code paths and probably snpEff and Beagle, which would still need approach 1.

## Known Limits

- GATK's Intel GKL native code (AVX PairHMM, compression) cannot run; GATK falls back to pure Java, which is slower.
- GenomicsDBImport is native only and will not work; use CombineGVCFs for joint calling. Spark tools are out.
- HaplotypeCaller typically needs a 2–4 GB heap or more. Small genomes and restricted intervals are realistic; a whole human genome in one run probably is not.
- snpEff loads its whole annotation database into memory (several GB for human).
- Expect several times slower than a normal JVM.
- CheerpJ is a separate runtime from Emscripten. Piping between Java and Emscripten tools would need extra bridging.

## Risks to Check Early

1. **Hosting the jar.** GitHub rejects files over 100 MB, so the 400 MB `gatk-package-*-local.jar` cannot be served from Pages as is. Done with a slim jar instead: GATK's own jar from Maven Central merged with the 59 dependency jars it loads, 78 MB ([public/java/gatk/](../../../../public/java/gatk/README.md)).
2. **COEP/COOP.** Our cross-origin isolation (coi-serviceworker) may block the CheerpJ loader from its CDN unless the CDN sends CORP/CORS headers. Self-hosting the runtime may need a licence.
3. **Main thread.** CheerpJ seems to run on the page's main thread (Java threads scheduled one at a time), not in a Web Worker. Long jobs could make the UI less responsive.
4. **Speed.** PairHMM in pure Java through CheerpJ's compiler; measure on a small genome.
5. **Licence.** Commercial or organisational use of CheerpJ needs a paid licence.

## Proposed Spike

1. ~~Load CheerpJ on the Analyser page with isolation enabled and run a hello-world jar (answers risk 2).~~ Done.
2. ~~Add one native `read(path, pos, len)` backed by the selected folder handle; check how `byte[]` data moves between JavaScript and Java.~~ Done (copy in and out above).
3. Write the `mayo://` provider; open an indexed BAM from the folder with htsjdk alone and query a region.
4. Run GATK `CountReads`, then `HaplotypeCaller` on a bacterial BAM and FASTA (for example *Streptococcus agalactiae*); measure throughput and memory.
5. Try the default-provider property to drop the `mayo://` prefix.
6. ~~Decide how to host the jar (slimmed or external).~~ Slim `public/java/gatk/4.6.2.0/gatk.jar`; further test it in CheerpJ on the full `trace` test sample.

If steps 1–3 work, the same bridge serves any Java tool that uses NIO.
