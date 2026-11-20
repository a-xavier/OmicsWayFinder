# Java Backend (planned)

Status: **idea, not started**. Nothing here is implemented yet. This file records the research so the work can be picked up later.

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
- Java 8, 11, 17, 21 and 25 are supported (`cheerpjInit({ version: 17 })`); 21 and 25 need CheerpJ 5.0. GATK 4.5+ needs Java 17; recent snpEff probably needs Java 21.
- Running a jar: `cheerpjRunMain("org.broadinstitute.hellbender.Main", "/app/gatk.jar:/app/mayo-nio.jar", ...args)` or `cheerpjRunJar(...)`; both resolve to the exit code.
- Its virtual filesystem has fixed mount points only:
  - `/app/`: the web server, read-only over HTTP (jars live here).
  - `/files/`: writable, kept in IndexedDB; JavaScript reads it with `cjFileBlob`.
  - `/str/`: data added from JavaScript (`cheerpOSAddStringFile`), in memory, read-only for Java.
  - There is **no public API to add a mount**, so MAYOFS cannot be plugged in the way it is for Emscripten.
- Java `native` methods can be implemented in JavaScript and **may be `async`**: `Java_<class>_<method>(lib, self?, ...args)`, passed with `cheerpjInit({ natives: { ... } })`. The Java thread waits while the promise resolves. This is the key to the folder bridge below.
- `cheerpjInit({ javaProperties: ["key=value"] })` sets system properties.

## Getting the User's Folder to Java

### 1. Copy In and Out

Read inputs from the folder, add them with `cheerpOSAddStringFile("/str/x.vcf", bytes)`, run the tool writing to `/files/`, then copy the results back with `cjFileBlob`.

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
- Writes use `createWritable()` with explicit positions and are committed on close, as in MAYOFS.
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

1. **Hosting the jar.** GitHub rejects files over 100 MB, so the 400 MB `gatk-package-*-local.jar` cannot be served from Pages as is. Options: a jar slimmed with ProGuard (only the tools we need, without Spark, Hadoop, GCS and GenomicsDB; maybe 30–80 MB), or other hosting with CORS and range requests.
2. **COEP/COOP.** Our cross-origin isolation (coi-serviceworker) may block the CheerpJ loader from its CDN unless the CDN sends CORP/CORS headers. Self-hosting the runtime may need a licence.
3. **Main thread.** CheerpJ seems to run on the page's main thread (Java threads scheduled one at a time), not in a Web Worker. Long jobs could make the UI less responsive.
4. **Speed.** PairHMM in pure Java through CheerpJ's compiler; measure on a small genome.
5. **Licence.** Commercial or organisational use of CheerpJ needs a paid licence.

## Proposed Spike

1. Load CheerpJ on the Analyser page with isolation enabled and run a hello-world jar (answers risk 2).
2. Add one native `read(path, pos, len)` backed by the selected folder handle; check how `byte[]` data moves between JavaScript and Java.
3. Write the `mayo://` provider; open an indexed BAM from the folder with htsjdk alone and query a region.
4. Run GATK `CountReads`, then `HaplotypeCaller` on a bacterial BAM and FASTA (for example *Streptococcus agalactiae*); measure throughput and memory.
5. Try the default-provider property to drop the `mayo://` prefix.
6. Decide how to host the jar (slimmed or external).

If steps 1–3 work, the same bridge serves any Java tool that uses NIO.
