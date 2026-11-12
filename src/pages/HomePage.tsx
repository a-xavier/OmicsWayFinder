import './HomePage.css'

export default function HomePage() {
  return (
    <section className="app-page home-page">
      <p className="home-intro">
        A research project exploring guided, reproducible biological analysis in the browser.
      </p>
      <h2>Motivation</h2>
      <p>
        Bioinformatics is hard. We generate petabytes of sequencing and omics data
        and do actually very little with it. Usually, the person analysing the data
        is different of the one producing the data from the lab, and sometimes the
        pipeline Lab → Bioinformatics → Statistician creates a disconnect.
      </p>
      <p>
        On top of that,{' '}
        <a
          href="https://australianbiocommons.github.io/toolfinder/"
          target="_blank"
          rel="noopener noreferrer"
        >
          there are around 20 tools to perform each task
        </a>{' '}
        each with{' '}
        <a
          href="https://gatk.broadinstitute.org/hc/en-us/articles/360037225632-HaplotypeCaller#--active-probability-threshold"
          target="_blank"
          rel="noopener noreferrer"
        >
          approximately 300 arguments
        </a>{' '}
        to know which will influence the results.
      </p>
      <p>
        In addition, tools are often complex, command line, needing dependencies
        and specific environment, written by academic for academic with poor
        maintenance. They are obscure and can lack accessibility support.
      </p>
      <p>The alternative path would be to upload your data to online platforms for analysis, which can be insecure and raise privacy concerns.</p>
      <p>
        Finally, even using proper pipelines, there is a plethora of analysis that
        can be performed on data but are not, because the experiment was not
        designed with those analyses in mind (e.g. only getting SNPs on long read
        when you can easily get structural variants and base modifications).
      </p>

    <p>
        However, most computers now are powerful enough to handle real-world bioinformatics analyses locally (e.g 16-32Gb RAM multi-core CPUs are sufficient to handle WGS data).
        Every single computer in the world is equipped with a web browser. This means that using WASM based technologies, we can run bioinformatics tools directly in the browser without the need for complex local installations.
        Addditionally, most arguments used in bioinformatics tools can be set following sensible rules that can be auto-detected. 
        This is the motivation behind OmicsWayFinder.
    </p>

      <div className="home-tools">
        <a className="home-tool" data-tool="validator" href="#/filevalidator">
          <span className="home-tool__status">Prototype</span>
          <h2><strong>FileValidator</strong></h2>
          <p>Inspect biological files, check their structure and explore the metadata recovered from their contents.</p>
        </a>
        <a className="home-tool" data-tool="contracts" href="#/contracts">
          <span className="home-tool__status">Draft specification</span>
          <h2><strong>Contracts</strong></h2>
          <p>Explore decision rules that connect file evidence to analytical steps, software and parameter choices.</p>
        </a>
        <a className="home-tool" data-tool="analyser" href="#/analyser">
          <span className="home-tool__status">Planned</span>
          <h2><strong>Analyser</strong></h2>
          <p>Future local workflow execution and reproducible outputs. Analysis execution is not yet available.</p>
        </a>
      </div>
    </section>
  )
}