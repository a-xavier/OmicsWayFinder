# Omics Decision Contracts: Minimal Draft

An **Omics Decision Contract (ODC)** describes a decision connecting biological
file evidence to an action, software and arguments, with a readable explanation.
The aim is an EDAM-compatible format that makes decisions explicit rather than
asking users to choose hundreds of settings.

## Motivation

Bioinformatics tools often expose obscure terminology and hundreds of options
whose scientific consequences are difficult to assess. Choices that look like
technical details can substantially change which reads align, which variants
are retained and, ultimately, the biological interpretation. A command can run
successfully and reproducibly without being appropriate for the experiment.

Omics Decision Contracts aim to provide transparent, evidence-based guidelines:
what decision is needed, which observations support it, what settings follow and
when more information or specialist judgement is required. For example:

- **FASTQ trimming:** Is trimming needed at all? Should low-quality bases be
	removed from the 5' end, the 3' end or both, and how much sequence can be
	removed without compromising mapping, read merging or downstream analysis?
	Adapter removal and quality trimming are separate decisions.
- **Mapping options:** Which aligner, preset and parameters match the sequencing
	technology and assay? Short genomic reads, noisy long reads, HiFi reads and
	spliced RNA reads require different considerations. A convenient default can
	change alignment sensitivity, multimapping and downstream findings.
- **Variant filtering:** Is variant quality score recalibration (VQSR) supported
	by sufficient variant counts and appropriate training/truth resources, or is
	explicit hard filtering more appropriate? Neither approach is universally
	preferable; assay, organism, callset size and available evidence should guide
	the choice and justification of cutoffs.
- **Modified-base analysis:** Does a BAM contain usable modified-base tags
	(`MM`/`ML`), and are the modification types, alignment and reference suitable?
	This evidence could reveal an additional analysis route using modkit, such as
	summarising modification calls or generating reference-position summaries.
	Tag presence alone does not establish that every modified-base analysis is
	supported; absent tags cannot be replaced by ordinary alignment information.

The goal is not merely to hide command-line arguments. It is to formalise why
an analysis or setting is justified, expose new opportunities supported by the
data and explain when a route should be withheld. These examples motivate the
format; they are not all implemented contracts or validated recommendations.

This is a small design draft, not an implemented rule engine or a validated
scientific specification. Start with two examples and establish what is actually
needed before adding more fields.

## Initial Fields

| Field | Purpose |
| --- | --- |
| `odc_version` | Version of the ODC format, quoted as a string. |
| `id` | Stable, descriptive contract name/identifier. |
| `description` | What decision this contract describes. |
| `input_format` | Named input roles, each with an EDAM format URI and label. |
| `action` | An EDAM operation URI and label, where a suitable term exists. |
| `software` | Software name and canonical project URL. |
| `output_format` | Primary output's EDAM format URI and label. |
| `thresholds` | Named numeric cut-offs or settings, when applicable. |
| `sources` | Origins and definitions of statistics, and the rationale for thresholds. |
| `arguments` | Common/default software arguments, when applicable. |
| `rules` | Conditions, argument overrides and an explanation for each decision. |

Use full [EDAM](https://edamontology.org/) term URIs, not labels alone. Formats
describe file representations; operations describe actions. Software names,
thresholds and rules are ODC fields, not invented EDAM terms. If an operation
cannot yet be mapped, use `id: null` with a descriptive label and treat that
mapping as unresolved. EDAM annotations alone do not establish full conformance;
ontology-version policy and formal validation remain future work.

## Where Values Come From

Keep **measurements** separate from **decision criteria**. A quality report may
provide a mean Phred score; it does not automatically justify trimming below Q25.

`sources.stats` has one entry for each statistic used by a rule. Each entry names
its `provider`, the provider's `output` field or report section, the `calculation`
needed to obtain the contract statistic, its measurement `scope` and its `unit`.
Providers can differ between statistics: FastQC, OmicsWayfinder or another tool
can supply evidence, provided the calculation and scope match what the rule needs.
Provider fields are not necessarily the same names as the contract's `stats.*`.

`sources.thresholds` has one entry for each threshold. Its `kind` identifies the
origin, and `explanation` states why it was chosen. Both examples currently use
`draft_choice`: the numbers are explicit author choices, not validated defaults.
A future `publication`, `benchmark`, `user_supplied` or `derived` threshold must
identify its actual reference, user input or derivation in the explanation rather
than merely name a tool. Numeric values remain in `thresholds`, so rule syntax
does not change.

These are source **declarations**, not a record of a completed measurement. A
future execution record must retain the actual value, input identity, provider
version, report/artifact and sampling scope. No FastQC importer or new statistic
is implemented by these examples. An unavailable source requires obtaining the
measurement, not guessing it or silently substituting another provider.

## Rule Conventions

- `when` is illustrative expression syntax, not executable JavaScript or shell.
- `stats.*` refers to measured evidence; `thresholds.*` refers to this contract's
	settings. Missing, invalid or non-finite evidence stops evaluation and requires
	clarification; it must not silently trigger a fallback.
- `${thresholds.terminal_bases}` means substitute the numeric setting, preserving
	its type. Argument keys are literal CLI options; `true` emits a flag without a
	value, while numbers and strings supply option values.
- A matching rule overrides the corresponding default arguments. Distinct
	arguments accumulate, allowing independent front and tail trimming. If multiple
	rules set the same argument, the first matching assignment wins. `otherwise`
	applies only when no earlier rule matched.
- Input/output paths and named input bindings are supplied by a future executor,
	not embedded shell commands. These drafts do not run the tools.

## Example 1: FASTQ End Trimming

[Contract.yaml](Contract.yaml) uses fastp to trim exactly `N` bases from each end
independently when that end's terminal mean quality is **below Q25**. The example
sets `N = 5`; it is a configurable placeholder, not a validated recommendation.

`stats.mean_quality_first_n` and `stats.mean_quality_last_n` are arithmetic means
of decoded Phred scores across the first or last N bases of every input read.
The 3' window is measured relative to each read's end. Measure both before
trimming. This is file-wide fixed trimming, **not** per-read sliding-window
trimming or a requirement that every individual base is below Q25.

The declared provider is FastQC's **Per base sequence quality** report. For
fixed-length reads and ungrouped, single-cycle rows, averaging the first or last
N reported cycle means gives the intended terminal mean. FastQC can group cycles;
its grouped summaries cannot recover arbitrary exact N-base windows. For
variable-length reads, its final cycles are not the last N bases of every read.
Those cases require a suitable exact calculation from the reads or another
explicitly declared provider; do not treat FastQC's pass/warn/fail status or
per-sequence quality histogram as this statistic.

| First N mean | Last N mean | Front trim | Tail trim |
| --- | --- | --- | --- |
| 20 | 20 | N | N |
| 20 | 30 | N | 0 |
| 30 | 20 | 0 | N |
| 25 | 25 | 0 | 0 |

The example assumes one single-end, Phred+33 FASTQ file and a positive integer N.
Each read must retain at least one base after the selected trims; otherwise stop
and request a revised trimming decision. Paired-end handling is not defined yet.
Unrelated automatic adapter/polyG trimming and quality/length filtering are
disabled so the example does not silently introduce those decisions. fastp also
produces its standard QC reports; `output_format` describes the primary read output.

## Example 2: Minimap2 Preset Selection

[minimap2-preset.yaml](minimap2-preset.yaml) selects `-x` and uses `-a` to produce
SAM alignments against a supplied FASTA reference.

The declared provider is OmicsWayfinder's current FASTQ parser:
`stats.readLength` supplies `stats.mean_read_length`, and `stats.readQuality`
supplies `stats.mean_quality`. Length is the arithmetic mean read length in bases.
Quality is the arithmetic mean of per-read mean Phred scores, with each read
weighted equally. This differs from a base-weighted mean when lengths vary and
is not an average error probability or mapping quality. Both describe the parsed
reads, which may be only a file slice; they are not automatically whole-file
measurements. The example assumes a
nonempty genomic DNA read set with valid quality scores and an appropriate
reference; reference selection and RNA/spliced alignment are outside this example.

| Mean length | Mean quality | Preset |
| --- | --- | --- |
| < 600 bp | >= Q30 | `sr` |
| > 600 bp | < Q30 | `map-ont` |
| > 600 bp | > Q30 | `map-hifi` |
| Any other valid combination | Any | `sr` fallback |

Length exactly 600 bp and long reads at exactly Q30 deliberately reach the
fallback. Missing evidence does not. These are the requested illustrative rules,
not established platform-identification criteria: high-quality Nanopore reads
can exceed Q30, and short reads need not come from a short-read instrument.
The `sr` fallback is not a guarantee of scientific suitability. Platform evidence,
assay context and benchmarks would be needed before operational use.

## References

- [EDAM ontology](https://edamontology.org/)
- [fastp arguments and trimming behaviour](https://github.com/OpenGene/fastp)
- [minimap2 presets and SAM output](https://github.com/lh3/minimap2)
