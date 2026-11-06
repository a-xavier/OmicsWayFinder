# OmicsWayfinder

**A research project exploring guided, reproducible biological analysis in the browser.**

OmicsWayfinder investigates whether unfamiliar biological files can be turned into
scientifically justified analyses without requiring researchers to install a
specialist software environment or configure hundreds of command-line arguments.
The goal is to connect file evidence, experimental context, explicit scientific
decisions and accessible local execution, while making uncertainty and limitations
visible.

**[Try the browser prototype](https://a-xavier.github.io/OmicsWayFinder/)**

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

## Research Status

This repository contains an evolving prototype and early decision-contract drafts,
not a validated end-to-end analysis platform. The aims above are research
objectives, not a list of completed features. Evaluation will test context
reconstruction, decision validity, reproducibility, recovery, accessibility and
researcher understanding. Environmental DNA metabarcoding is the planned primary
end-to-end example, with environmental metagenomics and plant population genomics
providing transfer tests.

OmicsWayfinder aims to support scientific expertise, not replace bioinformaticians
or treat successful software execution as proof of a scientifically valid result.

## Website Deployment

In GitHub, open **Settings > Pages** and set **Source** to **GitHub Actions**.

Pushes to the repository's default branch build the site, publish the contents of
`dist` to the `gh-page` branch, and deploy to GitHub Pages. The workflow can also
be run manually from the **Actions** tab on the default branch. Other branches
do not deploy. No additional token or secret is required.

Website: https://a-xavier.github.io/OmicsWayFinder/