import './ContractPage.css'

const draftFields = [
	['ODC version', 'Identifies which version of the contract format is used.'],
	['ID and description', 'Names the decision and explains its purpose.'],
	['Input and output formats', 'Uses EDAM format identifiers where a suitable term exists.'],
	['Action', 'Describes the operation, using an EDAM operation identifier where possible.'],
	['Software and arguments', 'Names the tool and the options selected by the rules.'],
	['Thresholds and sources', 'Records cut-offs separately from where measurements came from and why cut-offs were chosen.'],
	['Rules and explanation', 'Connects evidence to arguments and explains the resulting decision.'],
]

export default function ContractPage() {
	return (
		<article className="app-page contract-page">
			<header className="contract-intro">
				<p className="contract-eyebrow">Research draft · ODC 0.1</p>
				<h1>Omics Decision Contracts</h1>
				<p className="contract-lede">
					A contract makes an analytical decision explicit: what evidence is used,
					what action follows, which software arguments are selected, and why.
				</p>
			</header>

			<section className="contract-section" aria-labelledby="contract-motivation">
				<h2 id="contract-motivation">Why formalise decisions?</h2>
				<p>
					Bioinformatics is complicated and each tool needs to be chosen carefully. Each tool also needs to be properly used and have the correct arguments used or results can become biologically wrong.
                    This is why formalising decisions in a contract is important. This way we can probide best practice evidence and provide it to the general public for everyine to use.
				</p>
				<p>
					A contract should also say when evidence is missing, a workflow is not
					applicable, or a recommendation should be withheld. It guides analysis;
					it does not replace scientific review.
				</p>

				<p className="contract-note contract-ai-note">
				<span className="contract-ai-note__title">It also makes AI useful in biology</span>
                    In addition to making decision easier for researcher Omics Decision Contracts are also made to be machine readable and in the age of AI, meant to train AI that can justify their choices.
                    They provide structured evidence that AI systems can use to understand and replicate human decision-making in bioinformatics workflows.
                </p>
			</section>

			<section className="contract-section" aria-labelledby="contract-contents">
				<h2 id="contract-contents">What a contract records</h2>
				<dl className="contract-fields">
					{draftFields.map(([name, description]) => (
						<div className="contract-field" key={name}>
							<dt>{name}</dt>
							<dd>{description}</dd>
						</div>
					))}
				</dl>
				<p className="contract-note">
					EDAM identifies data formats and operations. It does not define the
					contract's thresholds, statistics, software arguments, or decision rules.
					This draft uses EDAM identifiers when a suitable term is available;
					formal ontology-versioning and conformance rules are still future work.
				</p>
			</section>

			<section className="contract-section" aria-labelledby="contract-provenance">
				<h2 id="contract-provenance">Evidence provenance</h2>
				<p>
					Each statistic needs a source and a definition: the provider, output
					field, calculation, scope, and unit. Thresholds have separate provenance:
					whether they came from a publication, benchmark, user, derivation, or
					currently just a draft author choice.
				</p>
				<p>
					For example, FastQC may report per-cycle quality, but it does not endorse
					trimming below Q25. The report's cycle grouping and read-length scope also
					determine whether it can supply the exact statistic a rule needs.
				</p>
			</section>

			<section className="contract-examples" aria-labelledby="contract-examples-title">
				<h2 id="contract-examples-title">Two illustrative decisions</h2>

				<article className="contract-example" data-example="trimming">
					<div className="contract-example__heading">
						<span className="contract-example__number">01</span>
						<div>
							<p className="contract-eyebrow">FASTQ · fastp · sequence trimming</p>
							<h3>Trim low-quality read ends</h3>
						</div>
					</div>
					<p>
						Independently inspect the mean Phred quality over the first and last
						<code>N</code> bases. If either mean is below Q25, trim exactly
						<code>N</code> bases from that end. The draft sets <code>N = 5</code>.
					</p>
					<ul>
						<li>Statistics: FastQC per-base quality, with its grouping and read-length limits documented.</li>
						<li>Thresholds: Q25 and N = 5 are illustrative author choices, not validated defaults.</li>
						<li>Scope: fixed-length, single-end reads; paired-end behavior is not specified.</li>
					</ul>
					<a
						className="contract-example__link"
						href="https://github.com/a-xavier/OmicsWayFinder/blob/main/Contract_Spec_Drafting/Contract.yaml"
					>
						View the FASTQ trimming YAML draft
					</a>
				</article>

				<article className="contract-example" data-example="mapping">
					<div className="contract-example__heading">
						<span className="contract-example__number">02</span>
						<div>
							<p className="contract-eyebrow">FASTQ + FASTA · minimap2 · read mapping</p>
							<h3>Select a minimap2 preset</h3>
						</div>
					</div>
					<p>
						Use mean read length and mean Phred quality to choose <code>sr</code>,
						<code>map-ont</code>, or <code>map-hifi</code>; emit SAM with
						<code>-a</code>. Unmatched valid cases use the requested <code>sr</code>
						fallback.
					</p>
					<ul>
						<li>Shorter than 600 bp and quality at least Q30: <code>sr</code>.</li>
						<li>Longer than 600 bp and quality below Q30: <code>map-ont</code>.</li>
						<li>Longer than 600 bp and quality above Q30: <code>map-hifi</code>.</li>
						<li>Boundary cases, including exactly 600 bp or exactly Q30 when long, use the <code>sr</code> fallback.</li>
					</ul>
					<p className="contract-caveat">
						These are draft heuristics, not reliable sequencing-platform
						identification. Read length and quality alone cannot establish
						technology or prove that a preset is scientifically appropriate.
					</p>
					<a
						className="contract-example__link"
						href="https://github.com/a-xavier/OmicsWayFinder/blob/main/Contract_Spec_Drafting/minimap2-preset.yaml"
					>
						View the minimap2 YAML draft
					</a>
				</article>
			</section>

			<footer className="contract-status">
				<strong>Prototype specification, not an execution engine.</strong>
				<span>The YAML examples are illustrative, unvalidated, and do not run tools.</span>
			</footer>
		</article>
	)
}
