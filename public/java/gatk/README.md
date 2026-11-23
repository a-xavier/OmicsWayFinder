# Slim GATK

GATK for the Java backend (CheerpJ), cut down to what its common tools really load.

GATK's release zip (667 MB) has only the 400 MB `gatk-package-*-local.jar`, which is too big for GitHub (100 MB per file) and mostly unused: Spark, Hadoop, Google Cloud, GenomicsDB, Scala... Instead, GATK is taken from Maven Central (`org.broadinstitute:gatk`, a 17 MB jar of its own classes) with its dependencies. Only the dependency jars it loads while running the tools below are kept, merged into one `gatk.jar`, laid out like the Emscripten tools: `java/<tool>/<version>/<tool>.jar`.

| | Jars | Size |
|---|---|---|
| Full runtime classpath | 365 | 375 MB |
| `4.6.2.0/gatk.jar` | 59, merged | 78 MB |
| Classes loaded by one run | 4,400 (tool list) to 5,600 (HaplotypeCaller) | ≈ 10–11 MB compressed |

On a desktop: `java -jar gatk.jar HaplotypeCaller ...`. CheerpJ uses HTTP range requests, but in a local Vite browser test `gatk --help` requested the entire jar and additional ranges (about 111 MB total according to Resource Timing). Download size on GitHub Pages has not yet been measured.

## Files

| File | Role |
|---|---|
| `pom.xml` | The GATK version and the dependencies left out: two that are not on Maven Central (`orc`, a POM-only parent; `jackson-module-scala_2.13:2.9.8`, never published; the Broad Institute's own Maven repository, which had them, is gone), and Spark's shaded Hadoop 3.3.4 (49 MB; GATK declares Hadoop 3.3.6, 4.6 MB, itself). |
| `trace-commands.txt` | The GATK commands run to find which jars are needed. |
| `jars.txt` | The jars they loaded, in classpath order. Written by `trace`. |
| `4.6.2.0/gatk.jar` | Those jars merged, served as `/app/java/gatk/4.6.2.0/gatk.jar`. Written by `build` and `trace`. |

## Building

[scripts/build-gatk.mjs](../../../scripts/build-gatk.mjs) (with [scripts/MergeJars.java](../../../scripts/MergeJars.java)) needs Java 17 or newer (`JAVA_HOME`, or `java` on the `PATH`), and Maven (`mvn` on the `PATH`, or it downloads Maven 3.9.9). Downloads, test data and logs go to `node_modules/.cache/gatk/`.

```sh
npm run build:tools           # refresh all BioWasm tools and build this jar locally
npm run build:gatk            # download GATK and its dependencies, merge the jars in jars.txt
npm run build:gatk -- trace   # find the jars again first, then merge them
```

Commit the resulting jar to the main branch; the Pages workflow publishes it
without running Maven. The combined tool builder uses the existing `jars.txt`;
use `trace` separately when updating the GATK version or traced commands.

`trace`:

1. Makes a small test sample whose answer is known: two random contigs (60 and 40 kb), 23 SNPs (some homozygous) and a 3 bp heterozygous deletion per contig, 30x of 150 bp reads written already aligned (no aligner needed), then `ref.fa`, `ref.fa.fai`, `ref.dict`, `reads.bam` and its index.
2. Runs GATK with no arguments (the tool list), then every line of `trace-commands.txt`, on the full classpath with `-Xlog:class+load`, and writes the jars the classes came from to `jars.txt`. The classpath is in Maven's order (GATK, then its dependencies as declared), not the folder's, so the same jar wins on every machine when two have the same class (log4j 1, commons-logging, servlet).
3. Merges them into `gatk.jar`, then runs the same commands on it alone and stops if any output differs (VCFs and text compared without their header lines, which hold dates and command lines; BAMs compared as decompressed bytes; indexes skipped).

The merge (`MergeJars.java`) keeps an entry from the first jar that has it, as the JVM does on a classpath; joins the `META-INF/services` files and the log4j2 plugin caches, which are read from every jar; keeps GATK's manifest (`Main-Class`, `Multi-Release`, `Add-Opens`) with each other jar's version per package (Picard writes its version into the BAMs it makes); and drops `module-info.class`. Entries get a fixed date, so the same jars always give the same bytes.

On the test sample, HaplotypeCaller calls all 25 planted variants.

## Adding a Tool or Updating GATK

- **A tool:** add one or more command lines using it to `trace-commands.txt` (on `ref.fa`, `reads.bam` or earlier outputs, writing to `out/`), then run `trace`. Commit the new `jars.txt`.
- **GATK:** change the version in `pom.xml`, run `trace`, delete the old version's folder, and update the version where the Java backend uses it. Maven Central can lag behind GitHub releases (4.6.2.0 there while GitHub has 4.7.0.0).

## Limits and Risks

- Only the code paths run by `trace-commands.txt` are covered. Other options of the same tools, other file formats (CRAM, BCF, `gs://` paths) or error paths may load a class from a dropped jar and fail with `NoClassDefFoundError`. Add a command that exercises them and run `trace` again.
- Intel GKL (AVX PairHMM, Deflater) is native code and is never used in the browser; GATK falls back to pure Java. On an ARM Mac, `trace` takes the same path, as the GKL libraries are x86-64 only. On x86-64 the traced classes are the same, as the GKL jars are kept either way.
- Spark and Hadoop stay: GATK loads a few of their classes when it starts. Cutting inside jars (ProGuard, or keeping only the classes listed by `-Xlog:class+load`) could shrink the 78 MB further; not needed for lazy loading, but GitHub refuses files over 100 MB.
- Only loaded classes are traced, not other resources (properties files, templates). One read from a jar that has no loaded class would be missing; the output check catches it if it changes a result.
- In CheerpJ, help, `CountReads` on a small SAM, and `CreateSequenceDictionary` on a small FASTA have been tested. Other commands still need browser testing.
