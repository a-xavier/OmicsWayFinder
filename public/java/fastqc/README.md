# FastQC 0.13.0

Run `npm run build:fastqc` locally to recreate `0.13.0/`. It downloads the pinned
[FastQC release](https://github.com/s-andrews/FastQC/releases/tag/v0.13.0) and
source, verifies checksums, and compiles the browser adaptations using JDK 17+.
`npm run build:tools` runs this too. Commit the generated files for Pages; they
are not built during deployment.

The upstream release has loose classes, resources, dependency jars and a Python
command-line launcher, not one executable jar. The build packages its classes
and report resources into `fastqc.jar`, keeps the required dependency jars
beside it, and supplies a Java CLI adapter. It also changes FastQC's report
resource lookup for our jar class loader and ensures its analysis queue stops
after a run. Java worker failures are reported instead of leaving the launcher
waiting indefinitely. FastQC runs with a single analysis thread.

`source.zip` contains the corresponding FastQC sources, including these changes
and the build recipe. FastQC is GPLv3-or-later. HTSJDK contains MIT, LGPL and
other notices in its accompanying source; its class files in the release were
verified to match 2.24.1. The Apache Commons jars contain their notices, and
their source archives are included. FAST5 and its JHDF5 dependency are not
included in this browser build.

In the CheerpJ tester, select a folder containing a FASTQ and run:

```
fastqc reads.fastq
fastqc --outdir reports --threads 1 reads.fastq.gz
```

The output directory must already exist in the selected folder. The tool writes
`reads_fastqc.html` and `reads_fastqc.zip` there or next to the input. Small
plain and gzipped FASTQs, HTML/SVG reports, PNG reports, extraction, repeated
runs and errors were tested in Chrome with an OPFS directory handle. Other
formats and options need further testing.

Supported options are listed by `fastqc --help`. Unlisted options, including
`--delete` and `--fast5`, are rejected. The backend does not currently propagate
tool-initiated file deletion to the selected folder. FastQC paths cannot use
the reserved top-level `.tmp`, `uploads`, or `downloads` directories. Inputs are copied into
CheerpJ and outputs copied back, so large files remain subject to the backend's
memory and storage limitations.
