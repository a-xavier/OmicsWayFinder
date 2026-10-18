import { PipelineGraph } from "./pipeline_graphs";

/**
 * Multi-domain sequencing pipeline possibility graph.
 *
 * Entry classifications:
 * - FASTQ
 * - POD5
 *
 * The graph represents possible downstream analyses. Edge labels describe
 * decisions that would eventually be evaluated from detected evidence,
 * metadata, or explicit user choices.
 */
export const sequencing_possibility_graph: PipelineGraph = {
  id: "sequencing_possibilities",

  title: "Sequencing Analysis Possibilities",

  nodes: [
    // =====================================================================
    // Row 1: inputs
    // =====================================================================

    {
      id: "FASTQ",
      data: {
        label: "FASTQ",
        sent_back: false,
      },
      position: { x: 400, y: 0 },
    },
    {
      id: "POD5",
      data: {
        label: "POD5",
        sent_back: false,
      },
      position: { x: 1000, y: 0 },
    },

    // =====================================================================
    // Row 2: sequencing preparation
    // =====================================================================

    {
      id: "fastq_detection",
      data: {
        label: "Detect platform, pairing and read structure",
        sent_back: false,
      },
      position: { x: 300, y: 180 },
    },
    {
      id: "nanopore_basecalling",
      data: {
        label: "Nanopore basecalling",
        sent_back: false,
      },
      position: { x: 900, y: 180 },
    },
    {
      id: "nanopore_demultiplexing",
      data: {
        label: "Barcode demultiplexing",
        sent_back: false,
      },
      position: { x: 1200, y: 180 },
    },

    // =====================================================================
    // Row 3: shared preprocessing
    // =====================================================================

    {
      id: "read_qc",
      data: {
        label: "Read quality assessment",
        sent_back: true,
      },
      position: { x: 420, y: 360 },
    },
    {
      id: "adapter_primer_detection",
      data: {
        label: "Detect adapters, primers and barcodes",
        sent_back: false,
      },
      position: { x: 730, y: 360 },
    },
    {
      id: "organism_detection",
      data: {
        label: "Detect organism or community",
        sent_back: false,
      },
      position: { x: 1040, y: 360 },
    },

    // =====================================================================
    // Row 4: organism or sample categories
    // =====================================================================

    {
      id: "human",
      data: {
        label: "Human",
        sent_back: false,
      },
      position: { x: 0, y: 580 },
    },
    {
      id: "virus",
      data: {
        label: "Virus",
        sent_back: false,
      },
      position: { x: 300, y: 580 },
    },
    {
      id: "bacteria",
      data: {
        label: "Bacteria",
        sent_back: false,
      },
      position: { x: 600, y: 580 },
    },
    {
      id: "plant",
      data: {
        label: "Plant",
        sent_back: false,
      },
      position: { x: 900, y: 580 },
    },
    {
      id: "fungus",
      data: {
        label: "Fungus",
        sent_back: false,
      },
      position: { x: 1200, y: 580 },
    },
    {
      id: "mixed",
      data: {
        label: "Mixed or unknown community",
        sent_back: false,
      },
      position: { x: 1500, y: 580 },
    },

    // =====================================================================
    // HUMAN BRANCH
    // =====================================================================

    // Human assay types

    {
      id: "human_dna",
      data: {
        label: "Human DNA sequencing",
        sent_back: false,
      },
      position: { x: -650, y: 800 },
    },
    {
      id: "human_rna",
      data: {
        label: "Human RNA sequencing",
        sent_back: false,
      },
      position: { x: -350, y: 800 },
    },
    {
      id: "human_epigenomics",
      data: {
        label: "Human epigenomics",
        sent_back: false,
      },
      position: { x: -50, y: 800 },
    },
    {
      id: "human_targeted_expression",
      data: {
        label: "Targeted expression assay",
        sent_back: false,
      },
      position: { x: 250, y: 800 },
    },

    // Human DNA subtypes

    {
      id: "human_wgs",
      data: {
        label: "Whole-genome sequencing",
        sent_back: false,
      },
      position: { x: -1250, y: 1020 },
    },
    {
      id: "human_exome",
      data: {
        label: "Whole-exome sequencing",
        sent_back: false,
      },
      position: { x: -1000, y: 1020 },
    },
    {
      id: "human_targeted_panel",
      data: {
        label: "Targeted gene panel",
        sent_back: false,
      },
      position: { x: -750, y: 1020 },
    },
    {
      id: "human_low_pass_wgs",
      data: {
        label: "Low-pass whole genome",
        sent_back: false,
      },
      position: { x: -500, y: 1020 },
    },
    {
      id: "human_mitochondrial",
      data: {
        label: "Mitochondrial sequencing",
        sent_back: false,
      },
      position: { x: -250, y: 1020 },
    },

    // Human RNA subtypes

    {
      id: "human_bulk_rnaseq",
      data: {
        label: "Bulk RNA-seq",
        sent_back: false,
      },
      position: { x: 0, y: 1020 },
    },
    {
      id: "human_small_rna",
      data: {
        label: "Small RNA-seq",
        sent_back: false,
      },
      position: { x: 250, y: 1020 },
    },
    {
      id: "human_single_cell",
      data: {
        label: "Single-cell RNA-seq",
        sent_back: false,
      },
      position: { x: 500, y: 1020 },
    },
    {
      id: "human_long_read_rna",
      data: {
        label: "Long-read transcriptomics",
        sent_back: false,
      },
      position: { x: 750, y: 1020 },
    },
    {
      id: "human_fusion_rna",
      data: {
        label: "Fusion-focused RNA analysis",
        sent_back: false,
      },
      position: { x: 1000, y: 1020 },
    },

    // Human epigenomic subtypes

    {
      id: "human_native_methylation",
      data: {
        label: "Native DNA methylation",
        sent_back: false,
      },
      position: { x: 1250, y: 1020 },
    },
    {
      id: "human_bisulfite",
      data: {
        label: "Bisulfite sequencing",
        sent_back: false,
      },
      position: { x: 1500, y: 1020 },
    },
    {
      id: "human_atacseq",
      data: {
        label: "ATAC-seq",
        sent_back: false,
      },
      position: { x: 1750, y: 1020 },
    },
    {
      id: "human_chipseq",
      data: {
        label: "ChIP-seq",
        sent_back: false,
      },
      position: { x: 2000, y: 1020 },
    },

    // Human DNA analyses

    {
      id: "human_germline_variants",
      data: {
        label: "Germline variant analysis",
        sent_back: true,
      },
      position: { x: -1400, y: 1260 },
    },
    {
      id: "human_somatic_variants",
      data: {
        label: "Somatic variant analysis",
        sent_back: true,
      },
      position: { x: -1150, y: 1260 },
    },
    {
      id: "human_structural_variants",
      data: {
        label: "Structural variants",
        sent_back: true,
      },
      position: { x: -900, y: 1260 },
    },
    {
      id: "human_copy_number",
      data: {
        label: "Copy-number analysis",
        sent_back: true,
      },
      position: { x: -650, y: 1260 },
    },
    {
      id: "human_clinical_annotation",
      data: {
        label: "Clinical variant annotation",
        sent_back: true,
      },
      position: { x: -400, y: 1260 },
    },
    {
      id: "human_population_analysis",
      data: {
        label: "Population and ancestry analysis",
        sent_back: true,
      },
      position: { x: -150, y: 1260 },
    },
    {
      id: "human_pgx",
      data: {
        label: "Pharmacogenomics report",
        sent_back: true,
      },
      position: { x: 100, y: 1260 },
    },

    // Human RNA analyses

    {
      id: "human_expression",
      data: {
        label: "Gene and transcript expression",
        sent_back: true,
      },
      position: { x: 350, y: 1260 },
    },
    {
      id: "human_differential_expression",
      data: {
        label: "Differential expression",
        sent_back: true,
      },
      position: { x: 600, y: 1260 },
    },
    {
      id: "human_splicing",
      data: {
        label: "Alternative splicing",
        sent_back: true,
      },
      position: { x: 850, y: 1260 },
    },
    {
      id: "human_fusions",
      data: {
        label: "Fusion transcripts",
        sent_back: true,
      },
      position: { x: 1100, y: 1260 },
    },
    {
      id: "human_cell_types",
      data: {
        label: "Cell types and clusters",
        sent_back: true,
      },
      position: { x: 1350, y: 1260 },
    },
    {
      id: "human_isoforms",
      data: {
        label: "Full-length isoforms",
        sent_back: true,
      },
      position: { x: 1600, y: 1260 },
    },

    // Human epigenomic analyses

    {
      id: "human_methylation_report",
      data: {
        label: "Methylation report",
        sent_back: true,
      },
      position: { x: 1850, y: 1260 },
    },
    {
      id: "human_chromatin_report",
      data: {
        label: "Chromatin accessibility report",
        sent_back: true,
      },
      position: { x: 2100, y: 1260 },
    },
    {
      id: "human_binding_report",
      data: {
        label: "Protein binding and peaks",
        sent_back: true,
      },
      position: { x: 2350, y: 1260 },
    },

    // =====================================================================
    // VIRUS BRANCH
    // =====================================================================

    {
      id: "viral_wgs",
      data: {
        label: "Viral whole-genome sequencing",
        sent_back: false,
      },
      position: { x: 2500, y: 800 },
    },
    {
      id: "viral_amplicon",
      data: {
        label: "Viral amplicon sequencing",
        sent_back: false,
      },
      position: { x: 2780, y: 800 },
    },
    {
      id: "viral_metagenomics",
      data: {
        label: "Untargeted viral metagenomics",
        sent_back: false,
      },
      position: { x: 3060, y: 800 },
    },
    {
      id: "viral_transcriptomics",
      data: {
        label: "Viral transcriptomics",
        sent_back: false,
      },
      position: { x: 3340, y: 800 },
    },

    {
      id: "viral_reference_mapping",
      data: {
        label: "Reference-guided viral analysis",
        sent_back: false,
      },
      position: { x: 2500, y: 1020 },
    },
    {
      id: "viral_denovo_assembly",
      data: {
        label: "Viral de novo assembly",
        sent_back: false,
      },
      position: { x: 2780, y: 1020 },
    },
    {
      id: "viral_host_removal",
      data: {
        label: "Remove host reads",
        sent_back: false,
      },
      position: { x: 3060, y: 1020 },
    },
    {
      id: "viral_taxonomic_screen",
      data: {
        label: "Viral taxonomic screening",
        sent_back: false,
      },
      position: { x: 3340, y: 1020 },
    },

    {
      id: "viral_consensus",
      data: {
        label: "Consensus viral genome",
        sent_back: true,
      },
      position: { x: 2450, y: 1260 },
    },
    {
      id: "viral_variants",
      data: {
        label: "Viral variants",
        sent_back: true,
      },
      position: { x: 2700, y: 1260 },
    },
    {
      id: "viral_lineage",
      data: {
        label: "Lineage or genotype",
        sent_back: true,
      },
      position: { x: 2950, y: 1260 },
    },
    {
      id: "viral_phylogeny",
      data: {
        label: "Phylogenetic placement",
        sent_back: true,
      },
      position: { x: 3200, y: 1260 },
    },
    {
      id: "viral_mixed_infection",
      data: {
        label: "Mixed infection assessment",
        sent_back: true,
      },
      position: { x: 3450, y: 1260 },
    },
    {
      id: "viral_expression_report",
      data: {
        label: "Viral expression report",
        sent_back: true,
      },
      position: { x: 3700, y: 1260 },
    },

    // =====================================================================
    // BACTERIA BRANCH
    // =====================================================================

    {
      id: "bacterial_isolate",
      data: {
        label: "Bacterial isolate WGS",
        sent_back: false,
      },
      position: { x: 3800, y: 800 },
    },
    {
      id: "bacterial_16s",
      data: {
        label: "16S metabarcoding",
        sent_back: false,
      },
      position: { x: 4060, y: 800 },
    },
    {
      id: "bacterial_shotgun",
      data: {
        label: "Shotgun metagenomics",
        sent_back: false,
      },
      position: { x: 4320, y: 800 },
    },
    {
      id: "bacterial_metatranscriptomics",
      data: {
        label: "Metatranscriptomics",
        sent_back: false,
      },
      position: { x: 4580, y: 800 },
    },
    {
      id: "bacterial_targeted",
      data: {
        label: "Targeted bacterial sequencing",
        sent_back: false,
      },
      position: { x: 4840, y: 800 },
    },
    {
      id: "bacterial_population",
      data: {
        label: "Bacterial population genomics",
        sent_back: false,
      },
      position: { x: 5100, y: 800 },
    },

    {
      id: "bacterial_assembly",
      data: {
        label: "Genome assembly and polishing",
        sent_back: false,
      },
      position: { x: 3800, y: 1020 },
    },
    {
      id: "bacterial_reference_variants",
      data: {
        label: "Reference-based variant calling",
        sent_back: false,
      },
      position: { x: 4060, y: 1020 },
    },
    {
      id: "bacterial_asv",
      data: {
        label: "ASV inference",
        sent_back: false,
      },
      position: { x: 4320, y: 1020 },
    },
    {
      id: "bacterial_taxonomic_profile",
      data: {
        label: "Taxonomic profiling",
        sent_back: false,
      },
      position: { x: 4580, y: 1020 },
    },
    {
      id: "bacterial_mag",
      data: {
        label: "Assembly, binning and MAG recovery",
        sent_back: false,
      },
      position: { x: 4840, y: 1020 },
    },
    {
      id: "bacterial_active_functions",
      data: {
        label: "Community expression analysis",
        sent_back: false,
      },
      position: { x: 5100, y: 1020 },
    },

    {
      id: "bacterial_species",
      data: {
        label: "Species and strain identification",
        sent_back: true,
      },
      position: { x: 3820, y: 1260 },
    },
    {
      id: "bacterial_genome",
      data: {
        label: "Annotated bacterial genome",
        sent_back: true,
      },
      position: { x: 4070, y: 1260 },
    },
    {
      id: "bacterial_amr",
      data: {
        label: "Antimicrobial resistance report",
        sent_back: true,
      },
      position: { x: 4320, y: 1260 },
    },
    {
      id: "bacterial_virulence",
      data: {
        label: "Virulence and plasmid report",
        sent_back: true,
      },
      position: { x: 4570, y: 1260 },
    },
    {
      id: "bacterial_community",
      data: {
        label: "Bacterial community profile",
        sent_back: true,
      },
      position: { x: 4820, y: 1260 },
    },
    {
      id: "bacterial_diversity",
      data: {
        label: "Microbial diversity report",
        sent_back: true,
      },
      position: { x: 5070, y: 1260 },
    },
    {
      id: "bacterial_outbreak",
      data: {
        label: "Outbreak and relatedness report",
        sent_back: true,
      },
      position: { x: 5320, y: 1260 },
    },
    {
      id: "bacterial_functional",
      data: {
        label: "Functional pathway profile",
        sent_back: true,
      },
      position: { x: 5570, y: 1260 },
    },

    // =====================================================================
    // PLANT BRANCH
    // =====================================================================

    {
      id: "plant_wgs",
      data: {
        label: "Plant whole-genome sequencing",
        sent_back: false,
      },
      position: { x: 5700, y: 800 },
    },
    {
      id: "plant_exome",
      data: {
        label: "Plant exome or gene-space sequencing",
        sent_back: false,
      },
      position: { x: 5970, y: 800 },
    },
    {
      id: "plant_targeted",
      data: {
        label: "Plant targeted sequencing",
        sent_back: false,
      },
      position: { x: 6240, y: 800 },
    },
    {
      id: "plant_rnaseq",
      data: {
        label: "Plant RNA-seq",
        sent_back: false,
      },
      position: { x: 6510, y: 800 },
    },
    {
      id: "plant_reduced_representation",
      data: {
        label: "GBS or RAD-seq",
        sent_back: false,
      },
      position: { x: 6780, y: 800 },
    },
    {
      id: "plant_organelle",
      data: {
        label: "Plant organelle sequencing",
        sent_back: false,
      },
      position: { x: 7050, y: 800 },
    },
    {
      id: "plant_pathogen",
      data: {
        label: "Plant pathogen detection",
        sent_back: false,
      },
      position: { x: 7320, y: 800 },
    },

    {
      id: "plant_reference_analysis",
      data: {
        label: "Reference-guided plant analysis",
        sent_back: false,
      },
      position: { x: 5770, y: 1020 },
    },
    {
      id: "plant_denovo_assembly",
      data: {
        label: "De novo plant assembly",
        sent_back: false,
      },
      position: { x: 6050, y: 1020 },
    },
    {
      id: "plant_expression_analysis",
      data: {
        label: "Plant expression analysis",
        sent_back: false,
      },
      position: { x: 6330, y: 1020 },
    },
    {
      id: "plant_marker_analysis",
      data: {
        label: "Marker and genotype analysis",
        sent_back: false,
      },
      position: { x: 6610, y: 1020 },
    },
    {
      id: "plant_pathogen_screen",
      data: {
        label: "Multi-kingdom pathogen screen",
        sent_back: false,
      },
      position: { x: 6890, y: 1020 },
    },

    {
      id: "plant_variants",
      data: {
        label: "Plant variants",
        sent_back: true,
      },
      position: { x: 5750, y: 1260 },
    },
    {
      id: "plant_structural_variants",
      data: {
        label: "Plant structural variants",
        sent_back: true,
      },
      position: { x: 6000, y: 1260 },
    },
    {
      id: "plant_population_structure",
      data: {
        label: "Plant population structure",
        sent_back: true,
      },
      position: { x: 6250, y: 1260 },
    },
    {
      id: "plant_trait_markers",
      data: {
        label: "Trait-associated markers",
        sent_back: true,
      },
      position: { x: 6500, y: 1260 },
    },
    {
      id: "plant_expression_report",
      data: {
        label: "Plant expression report",
        sent_back: true,
      },
      position: { x: 6750, y: 1260 },
    },
    {
      id: "plant_organelle_report",
      data: {
        label: "Organelle assembly and haplotypes",
        sent_back: true,
      },
      position: { x: 7000, y: 1260 },
    },
    {
      id: "plant_pathogen_report",
      data: {
        label: "Plant pathogen report",
        sent_back: true,
      },
      position: { x: 7250, y: 1260 },
    },

    // =====================================================================
    // FUNGAL BRANCH
    // =====================================================================

    {
      id: "fungal_isolate",
      data: {
        label: "Fungal isolate WGS",
        sent_back: false,
      },
      position: { x: 7500, y: 800 },
    },
    {
      id: "fungal_its",
      data: {
        label: "ITS metabarcoding",
        sent_back: false,
      },
      position: { x: 7760, y: 800 },
    },
    {
      id: "fungal_rnaseq",
      data: {
        label: "Fungal RNA-seq",
        sent_back: false,
      },
      position: { x: 8020, y: 800 },
    },
    {
      id: "fungal_population",
      data: {
        label: "Fungal population genomics",
        sent_back: false,
      },
      position: { x: 8280, y: 800 },
    },
    {
      id: "fungal_targeted",
      data: {
        label: "Targeted fungal detection",
        sent_back: false,
      },
      position: { x: 8540, y: 800 },
    },
    {
      id: "fungal_long_read",
      data: {
        label: "Long-read fungal assembly",
        sent_back: false,
      },
      position: { x: 8800, y: 800 },
    },

    {
      id: "fungal_assembly",
      data: {
        label: "Fungal assembly and annotation",
        sent_back: false,
      },
      position: { x: 7540, y: 1020 },
    },
    {
      id: "fungal_asv_otu",
      data: {
        label: "Fungal ASV or OTU inference",
        sent_back: false,
      },
      position: { x: 7820, y: 1020 },
    },
    {
      id: "fungal_expression_analysis",
      data: {
        label: "Fungal expression analysis",
        sent_back: false,
      },
      position: { x: 8100, y: 1020 },
    },
    {
      id: "fungal_variant_analysis",
      data: {
        label: "Fungal variant analysis",
        sent_back: false,
      },
      position: { x: 8380, y: 1020 },
    },

    {
      id: "fungal_species",
      data: {
        label: "Fungal species and strain",
        sent_back: true,
      },
      position: { x: 7500, y: 1260 },
    },
    {
      id: "fungal_genome",
      data: {
        label: "Annotated fungal genome",
        sent_back: true,
      },
      position: { x: 7750, y: 1260 },
    },
    {
      id: "fungal_resistance",
      data: {
        label: "Antifungal resistance report",
        sent_back: true,
      },
      position: { x: 8000, y: 1260 },
    },
    {
      id: "fungal_community",
      data: {
        label: "Fungal community profile",
        sent_back: true,
      },
      position: { x: 8250, y: 1260 },
    },
    {
      id: "fungal_guilds",
      data: {
        label: "Ecological guild prediction",
        sent_back: true,
      },
      position: { x: 8500, y: 1260 },
    },
    {
      id: "fungal_expression_report",
      data: {
        label: "Fungal expression report",
        sent_back: true,
      },
      position: { x: 8750, y: 1260 },
    },
    {
      id: "fungal_phylogeny",
      data: {
        label: "Fungal phylogeny",
        sent_back: true,
      },
      position: { x: 9000, y: 1260 },
    },

    // =====================================================================
    // MIXED OR UNKNOWN BRANCH
    // =====================================================================

    {
      id: "mixed_amplicon",
      data: {
        label: "Amplicon metabarcoding",
        sent_back: false,
      },
      position: { x: 9200, y: 800 },
    },
    {
      id: "mixed_shotgun",
      data: {
        label: "Shotgun metagenomics",
        sent_back: false,
      },
      position: { x: 9470, y: 800 },
    },
    {
      id: "mixed_metatranscriptomics",
      data: {
        label: "Metatranscriptomics",
        sent_back: false,
      },
      position: { x: 9740, y: 800 },
    },
    {
      id: "mixed_viral_discovery",
      data: {
        label: "Viral discovery",
        sent_back: false,
      },
      position: { x: 10010, y: 800 },
    },
    {
      id: "mixed_pathogen_detection",
      data: {
        label: "Pathogen detection",
        sent_back: false,
      },
      position: { x: 10280, y: 800 },
    },
    {
      id: "mixed_general_screen",
      data: {
        label: "General taxonomic screen",
        sent_back: false,
      },
      position: { x: 10550, y: 800 },
    },

    // Marker-specific metabarcoding branches

    {
      id: "marker_16s",
      data: {
        label: "16S bacteria and archaea",
        sent_back: false,
      },
      position: { x: 9100, y: 1020 },
    },
    {
      id: "marker_its",
      data: {
        label: "ITS fungi",
        sent_back: false,
      },
      position: { x: 9340, y: 1020 },
    },
    {
      id: "marker_18s",
      data: {
        label: "18S eukaryotes",
        sent_back: false,
      },
      position: { x: 9580, y: 1020 },
    },
    {
      id: "marker_coi",
      data: {
        label: "COI animals and eukaryotes",
        sent_back: false,
      },
      position: { x: 9820, y: 1020 },
    },
    {
      id: "marker_12s",
      data: {
        label: "12S vertebrates",
        sent_back: false,
      },
      position: { x: 10060, y: 1020 },
    },
    {
      id: "marker_custom",
      data: {
        label: "Custom marker",
        sent_back: false,
      },
      position: { x: 10300, y: 1020 },
    },

    // Mixed analysis processes

    {
      id: "mixed_host_removal",
      data: {
        label: "Host-read removal",
        sent_back: false,
      },
      position: { x: 10540, y: 1020 },
    },
    {
      id: "mixed_taxonomic_profiling",
      data: {
        label: "Multi-kingdom taxonomic profiling",
        sent_back: false,
      },
      position: { x: 10780, y: 1020 },
    },
    {
      id: "mixed_functional_profiling",
      data: {
        label: "Functional profiling",
        sent_back: false,
      },
      position: { x: 11020, y: 1020 },
    },
    {
      id: "mixed_assembly_binning",
      data: {
        label: "Assembly and genome binning",
        sent_back: false,
      },
      position: { x: 11260, y: 1020 },
    },

    // Mixed outputs

    {
      id: "mixed_asv_table",
      data: {
        label: "ASV or OTU table",
        sent_back: true,
      },
      position: { x: 9200, y: 1260 },
    },
    {
      id: "mixed_taxonomy",
      data: {
        label: "Taxonomic abundance report",
        sent_back: true,
      },
      position: { x: 9450, y: 1260 },
    },
    {
      id: "mixed_diversity",
      data: {
        label: "Biodiversity report",
        sent_back: true,
      },
      position: { x: 9700, y: 1260 },
    },
    {
      id: "mixed_differential_abundance",
      data: {
        label: "Differential abundance",
        sent_back: true,
      },
      position: { x: 9950, y: 1260 },
    },
    {
      id: "mixed_functional_report",
      data: {
        label: "Functional pathway report",
        sent_back: true,
      },
      position: { x: 10200, y: 1260 },
    },
    {
      id: "mixed_amr",
      data: {
        label: "Community resistance profile",
        sent_back: true,
      },
      position: { x: 10450, y: 1260 },
    },
    {
      id: "mixed_mags",
      data: {
        label: "Metagenome-assembled genomes",
        sent_back: true,
      },
      position: { x: 10700, y: 1260 },
    },
    {
      id: "mixed_pathogens",
      data: {
        label: "Candidate pathogen report",
        sent_back: true,
      },
      position: { x: 10950, y: 1260 },
    },
    {
      id: "mixed_active_taxa",
      data: {
        label: "Active taxa and pathways",
        sent_back: true,
      },
      position: { x: 11200, y: 1260 },
    },

    // =====================================================================
    // Shared final outputs
    // =====================================================================

    {
      id: "quality_report",
      data: {
        label: "Quality-control report",
        sent_back: true,
      },
      position: { x: 4500, y: 1500 },
    },
    {
      id: "methods_report",
      data: {
        label: "Methods and provenance report",
        sent_back: true,
      },
      position: { x: 4800, y: 1500 },
    },
    {
      id: "reusable_results",
      data: {
        label: "Reusable analysis-ready outputs",
        sent_back: true,
      },
      position: { x: 5100, y: 1500 },
    },
  ],

  edges: [
    // =====================================================================
    // Input processing
    // =====================================================================

    {
      id: "fastq-to-detection",
      source: "FASTQ",
      target: "fastq_detection",
      label: "Inspect reads",
    },
    {
      id: "pod5-to-basecalling",
      source: "POD5",
      target: "nanopore_basecalling",
      label: "Dorado",
    },
    {
      id: "basecalling-to-demultiplexing",
      source: "nanopore_basecalling",
      target: "nanopore_demultiplexing",
      label: "If barcoded",
    },
    {
      id: "basecalling-direct-to-qc",
      source: "nanopore_basecalling",
      target: "read_qc",
      label: "If not barcoded",
    },
    {
      id: "demultiplexing-to-qc",
      source: "nanopore_demultiplexing",
      target: "read_qc",
      label: "Basecalled reads",
    },
    {
      id: "fastq-detection-to-qc",
      source: "fastq_detection",
      target: "read_qc",
      label: "Detected FASTQ structure",
    },
    {
      id: "qc-to-adapter-detection",
      source: "read_qc",
      target: "adapter_primer_detection",
      label: "Inspect read content",
    },
    {
      id: "adapter-detection-to-organism",
      source: "adapter_primer_detection",
      target: "organism_detection",
      label: "Sequence and metadata evidence",
    },

    // Organism classification

    {
      id: "organism-to-human",
      source: "organism_detection",
      target: "human",
      label: "Human evidence",
    },
    {
      id: "organism-to-virus",
      source: "organism_detection",
      target: "virus",
      label: "Viral evidence",
    },
    {
      id: "organism-to-bacteria",
      source: "organism_detection",
      target: "bacteria",
      label: "Bacterial evidence",
    },
    {
      id: "organism-to-plant",
      source: "organism_detection",
      target: "plant",
      label: "Plant evidence",
    },
    {
      id: "organism-to-fungus",
      source: "organism_detection",
      target: "fungus",
      label: "Fungal evidence",
    },
    {
      id: "organism-to-mixed",
      source: "organism_detection",
      target: "mixed",
      label: "Multiple or unresolved taxa",
    },

    // =====================================================================
    // Human routing
    // =====================================================================

    {
      id: "human-to-dna",
      source: "human",
      target: "human_dna",
      label: "DNA assay",
    },
    {
      id: "human-to-rna",
      source: "human",
      target: "human_rna",
      label: "RNA assay",
    },
    {
      id: "human-to-epigenomics",
      source: "human",
      target: "human_epigenomics",
      label: "Epigenomic assay",
    },
    {
      id: "human-to-targeted-expression",
      source: "human",
      target: "human_targeted_expression",
      label: "Targeted expression",
    },

    // Human DNA subtypes

    {
      id: "human-dna-to-wgs",
      source: "human_dna",
      target: "human_wgs",
      label: "Genome-wide coverage",
    },
    {
      id: "human-dna-to-exome",
      source: "human_dna",
      target: "human_exome",
      label: "Exome capture",
    },
    {
      id: "human-dna-to-panel",
      source: "human_dna",
      target: "human_targeted_panel",
      label: "Target panel",
    },
    {
      id: "human-dna-to-low-pass",
      source: "human_dna",
      target: "human_low_pass_wgs",
      label: "Low genome coverage",
    },
    {
      id: "human-dna-to-mito",
      source: "human_dna",
      target: "human_mitochondrial",
      label: "Mitochondrial enrichment",
    },

    // Human DNA analyses

    {
      id: "human-wgs-to-germline",
      source: "human_wgs",
      target: "human_germline_variants",
      label: "GATK or DeepVariant",
    },
    {
      id: "human-wgs-to-somatic",
      source: "human_wgs",
      target: "human_somatic_variants",
      label: "If tumour or tumour-normal",
    },
    {
      id: "human-wgs-to-sv",
      source: "human_wgs",
      target: "human_structural_variants",
      label: "Manta, TIDDIT or Sniffles",
    },
    {
      id: "human-wgs-to-cnv",
      source: "human_wgs",
      target: "human_copy_number",
      label: "Copy-number caller",
    },
    {
      id: "human-wgs-to-population",
      source: "human_wgs",
      target: "human_population_analysis",
      label: "Population analysis",
    },
    {
      id: "human-wgs-to-pgx",
      source: "human_wgs",
      target: "human_pgx",
      label: "PharmCAT",
    },

    {
      id: "human-exome-to-germline",
      source: "human_exome",
      target: "human_germline_variants",
      label: "Coding variants",
    },
    {
      id: "human-exome-to-somatic",
      source: "human_exome",
      target: "human_somatic_variants",
      label: "If tumour or tumour-normal",
    },
    {
      id: "human-exome-to-cnv",
      source: "human_exome",
      target: "human_copy_number",
      label: "Capture-aware CNV",
    },

    {
      id: "human-panel-to-germline",
      source: "human_targeted_panel",
      target: "human_germline_variants",
      label: "Panel germline analysis",
    },
    {
      id: "human-panel-to-somatic",
      source: "human_targeted_panel",
      target: "human_somatic_variants",
      label: "Low-frequency somatic analysis",
    },

    {
      id: "human-low-pass-to-cnv",
      source: "human_low_pass_wgs",
      target: "human_copy_number",
      label: "Genome-wide copy number",
    },
    {
      id: "human-low-pass-to-population",
      source: "human_low_pass_wgs",
      target: "human_population_analysis",
      label: "Imputation and ancestry",
    },

    {
      id: "human-mito-to-germline",
      source: "human_mitochondrial",
      target: "human_germline_variants",
      label: "Mitochondrial variants",
    },
    {
      id: "human-mito-to-population",
      source: "human_mitochondrial",
      target: "human_population_analysis",
      label: "Mitochondrial haplogroup",
    },

    {
      id: "human-germline-to-clinical",
      source: "human_germline_variants",
      target: "human_clinical_annotation",
      label: "VEP and ACMG evidence",
    },
    {
      id: "human-somatic-to-clinical",
      source: "human_somatic_variants",
      target: "human_clinical_annotation",
      label: "Cancer annotation",
    },

    // Human RNA routing

    {
      id: "human-rna-to-bulk",
      source: "human_rna",
      target: "human_bulk_rnaseq",
      label: "Bulk library",
    },
    {
      id: "human-rna-to-small",
      source: "human_rna",
      target: "human_small_rna",
      label: "Small RNA library",
    },
    {
      id: "human-rna-to-single-cell",
      source: "human_rna",
      target: "human_single_cell",
      label: "Cell barcode structure",
    },
    {
      id: "human-rna-to-long-read",
      source: "human_rna",
      target: "human_long_read_rna",
      label: "Long reads",
    },
    {
      id: "human-rna-to-fusion",
      source: "human_rna",
      target: "human_fusion_rna",
      label: "Fusion-focused analysis",
    },

    {
      id: "bulk-to-expression",
      source: "human_bulk_rnaseq",
      target: "human_expression",
      label: "STAR and Salmon",
    },
    {
      id: "bulk-to-differential",
      source: "human_bulk_rnaseq",
      target: "human_differential_expression",
      label: "If groups supplied",
    },
    {
      id: "bulk-to-splicing",
      source: "human_bulk_rnaseq",
      target: "human_splicing",
      label: "Splicing analysis",
    },
    {
      id: "bulk-to-fusions",
      source: "human_bulk_rnaseq",
      target: "human_fusions",
      label: "Fusion caller",
    },

    {
      id: "small-rna-to-expression",
      source: "human_small_rna",
      target: "human_expression",
      label: "miRNA quantification",
    },
    {
      id: "small-rna-to-differential",
      source: "human_small_rna",
      target: "human_differential_expression",
      label: "If groups supplied",
    },

    {
      id: "single-cell-to-cell-types",
      source: "human_single_cell",
      target: "human_cell_types",
      label: "Clustering and annotation",
    },
    {
      id: "single-cell-to-differential",
      source: "human_single_cell",
      target: "human_differential_expression",
      label: "Cell-aware comparison",
    },

    {
      id: "long-rna-to-expression",
      source: "human_long_read_rna",
      target: "human_expression",
      label: "Transcript quantification",
    },
    {
      id: "long-rna-to-isoforms",
      source: "human_long_read_rna",
      target: "human_isoforms",
      label: "Isoform discovery",
    },
    {
      id: "long-rna-to-fusions",
      source: "human_long_read_rna",
      target: "human_fusions",
      label: "Long-read fusion evidence",
    },
    {
      id: "fusion-focused-to-fusions",
      source: "human_fusion_rna",
      target: "human_fusions",
      label: "Fusion detection",
    },

    {
      id: "targeted-expression-to-expression",
      source: "human_targeted_expression",
      target: "human_expression",
      label: "Panel quantification",
    },
    {
      id: "targeted-expression-to-differential",
      source: "human_targeted_expression",
      target: "human_differential_expression",
      label: "If groups supplied",
    },

    // Human epigenomics

    {
      id: "human-epigenomics-to-native",
      source: "human_epigenomics",
      target: "human_native_methylation",
      label: "Nanopore modified bases",
    },
    {
      id: "human-epigenomics-to-bisulfite",
      source: "human_epigenomics",
      target: "human_bisulfite",
      label: "Bisulfite conversion",
    },
    {
      id: "human-epigenomics-to-atac",
      source: "human_epigenomics",
      target: "human_atacseq",
      label: "Accessibility assay",
    },
    {
      id: "human-epigenomics-to-chip",
      source: "human_epigenomics",
      target: "human_chipseq",
      label: "Immunoprecipitation assay",
    },

    {
      id: "native-to-methylation",
      source: "human_native_methylation",
      target: "human_methylation_report",
      label: "modkit",
    },
    {
      id: "bisulfite-to-methylation",
      source: "human_bisulfite",
      target: "human_methylation_report",
      label: "Bisulfite methylation caller",
    },
    {
      id: "atac-to-chromatin",
      source: "human_atacseq",
      target: "human_chromatin_report",
      label: "Peak calling",
    },
    {
      id: "chip-to-binding",
      source: "human_chipseq",
      target: "human_binding_report",
      label: "Peak calling",
    },

    // =====================================================================
    // Viral routing
    // =====================================================================

    {
      id: "virus-to-wgs",
      source: "virus",
      target: "viral_wgs",
      label: "Known viral genome",
    },
    {
      id: "virus-to-amplicon",
      source: "virus",
      target: "viral_amplicon",
      label: "Primer scheme detected",
    },
    {
      id: "virus-to-metagenomics",
      source: "virus",
      target: "viral_metagenomics",
      label: "Untargeted sequencing",
    },
    {
      id: "virus-to-transcriptomics",
      source: "virus",
      target: "viral_transcriptomics",
      label: "RNA expression assay",
    },

    {
      id: "viral-wgs-to-reference",
      source: "viral_wgs",
      target: "viral_reference_mapping",
      label: "Map to reference",
    },
    {
      id: "viral-amplicon-to-reference",
      source: "viral_amplicon",
      target: "viral_reference_mapping",
      label: "Primer trimming and mapping",
    },
    {
      id: "viral-metagenomics-to-host-removal",
      source: "viral_metagenomics",
      target: "viral_host_removal",
      label: "Remove host reads",
    },
    {
      id: "viral-host-removal-to-screen",
      source: "viral_host_removal",
      target: "viral_taxonomic_screen",
      label: "Classify viral reads",
    },
    {
      id: "viral-screen-to-assembly",
      source: "viral_taxonomic_screen",
      target: "viral_denovo_assembly",
      label: "Assemble candidate viruses",
    },

    {
      id: "viral-reference-to-consensus",
      source: "viral_reference_mapping",
      target: "viral_consensus",
      label: "Consensus generation",
    },
    {
      id: "viral-reference-to-variants",
      source: "viral_reference_mapping",
      target: "viral_variants",
      label: "Variant calling",
    },
    {
      id: "viral-assembly-to-consensus",
      source: "viral_denovo_assembly",
      target: "viral_consensus",
      label: "Recovered genome",
    },
    {
      id: "viral-consensus-to-lineage",
      source: "viral_consensus",
      target: "viral_lineage",
      label: "Lineage assignment",
    },
    {
      id: "viral-consensus-to-phylogeny",
      source: "viral_consensus",
      target: "viral_phylogeny",
      label: "Phylogenetic placement",
    },
    {
      id: "viral-variants-to-mixed",
      source: "viral_variants",
      target: "viral_mixed_infection",
      label: "Mixture evidence",
    },
    {
      id: "viral-transcriptomics-to-expression",
      source: "viral_transcriptomics",
      target: "viral_expression_report",
      label: "Viral transcript quantification",
    },

    // =====================================================================
    // Bacterial routing
    // =====================================================================

    {
      id: "bacteria-to-isolate",
      source: "bacteria",
      target: "bacterial_isolate",
      label: "Isolate sequencing",
    },
    {
      id: "bacteria-to-16s",
      source: "bacteria",
      target: "bacterial_16s",
      label: "16S primers detected",
    },
    {
      id: "bacteria-to-shotgun",
      source: "bacteria",
      target: "bacterial_shotgun",
      label: "Community DNA",
    },
    {
      id: "bacteria-to-metatranscriptomics",
      source: "bacteria",
      target: "bacterial_metatranscriptomics",
      label: "Community RNA",
    },
    {
      id: "bacteria-to-targeted",
      source: "bacteria",
      target: "bacterial_targeted",
      label: "Targeted loci",
    },
    {
      id: "bacteria-to-population",
      source: "bacteria",
      target: "bacterial_population",
      label: "Multiple related isolates",
    },

    {
      id: "bacterial-isolate-to-assembly",
      source: "bacterial_isolate",
      target: "bacterial_assembly",
      label: "SPAdes, Unicycler or Flye",
    },
    {
      id: "bacterial-isolate-to-variants",
      source: "bacterial_isolate",
      target: "bacterial_reference_variants",
      label: "Reference available",
    },
    {
      id: "bacterial-16s-to-asv",
      source: "bacterial_16s",
      target: "bacterial_asv",
      label: "DADA2 or QIIME 2",
    },
    {
      id: "bacterial-shotgun-to-profile",
      source: "bacterial_shotgun",
      target: "bacterial_taxonomic_profile",
      label: "Kraken 2 or MetaPhlAn",
    },
    {
      id: "bacterial-shotgun-to-mag",
      source: "bacterial_shotgun",
      target: "bacterial_mag",
      label: "Assembly and binning",
    },
    {
      id: "bacterial-metatranscriptomics-to-functions",
      source: "bacterial_metatranscriptomics",
      target: "bacterial_active_functions",
      label: "Expression and pathways",
    },
    {
      id: "bacterial-targeted-to-variants",
      source: "bacterial_targeted",
      target: "bacterial_reference_variants",
      label: "Target-specific variants",
    },
    {
      id: "bacterial-population-to-variants",
      source: "bacterial_population",
      target: "bacterial_reference_variants",
      label: "Core-genome variants",
    },

    {
      id: "bacterial-assembly-to-species",
      source: "bacterial_assembly",
      target: "bacterial_species",
      label: "Taxonomic identification",
    },
    {
      id: "bacterial-assembly-to-genome",
      source: "bacterial_assembly",
      target: "bacterial_genome",
      label: "Genome annotation",
    },
    {
      id: "bacterial-assembly-to-amr",
      source: "bacterial_assembly",
      target: "bacterial_amr",
      label: "AMR databases",
    },
    {
      id: "bacterial-assembly-to-virulence",
      source: "bacterial_assembly",
      target: "bacterial_virulence",
      label: "Virulence and plasmid databases",
    },
    {
      id: "bacterial-variants-to-outbreak",
      source: "bacterial_reference_variants",
      target: "bacterial_outbreak",
      label: "Distance and phylogeny",
    },
    {
      id: "bacterial-asv-to-community",
      source: "bacterial_asv",
      target: "bacterial_community",
      label: "Taxonomic assignment",
    },
    {
      id: "bacterial-asv-to-diversity",
      source: "bacterial_asv",
      target: "bacterial_diversity",
      label: "Ecological statistics",
    },
    {
      id: "bacterial-profile-to-community",
      source: "bacterial_taxonomic_profile",
      target: "bacterial_community",
      label: "Taxonomic abundance",
    },
    {
      id: "bacterial-profile-to-functional",
      source: "bacterial_taxonomic_profile",
      target: "bacterial_functional",
      label: "Functional profiling",
    },
    {
      id: "bacterial-mag-to-genome",
      source: "bacterial_mag",
      target: "bacterial_genome",
      label: "Recovered genomes",
    },
    {
      id: "bacterial-mag-to-amr",
      source: "bacterial_mag",
      target: "bacterial_amr",
      label: "MAG resistance genes",
    },
    {
      id: "bacterial-active-to-functional",
      source: "bacterial_active_functions",
      target: "bacterial_functional",
      label: "Active pathways",
    },

    // =====================================================================
    // Plant routing
    // =====================================================================

    {
      id: "plant-to-wgs",
      source: "plant",
      target: "plant_wgs",
      label: "Genome-wide DNA",
    },
    {
      id: "plant-to-exome",
      source: "plant",
      target: "plant_exome",
      label: "Gene-space capture",
    },
    {
      id: "plant-to-targeted",
      source: "plant",
      target: "plant_targeted",
      label: "Targeted loci",
    },
    {
      id: "plant-to-rna",
      source: "plant",
      target: "plant_rnaseq",
      label: "RNA assay",
    },
    {
      id: "plant-to-reduced",
      source: "plant",
      target: "plant_reduced_representation",
      label: "Restriction-site library",
    },
    {
      id: "plant-to-organelle",
      source: "plant",
      target: "plant_organelle",
      label: "Organelle enrichment",
    },
    {
      id: "plant-to-pathogen",
      source: "plant",
      target: "plant_pathogen",
      label: "Non-plant reads detected",
    },

    {
      id: "plant-wgs-to-reference",
      source: "plant_wgs",
      target: "plant_reference_analysis",
      label: "Reference available",
    },
    {
      id: "plant-wgs-to-assembly",
      source: "plant_wgs",
      target: "plant_denovo_assembly",
      label: "No suitable reference",
    },
    {
      id: "plant-exome-to-reference",
      source: "plant_exome",
      target: "plant_reference_analysis",
      label: "Capture-aware analysis",
    },
    {
      id: "plant-targeted-to-marker",
      source: "plant_targeted",
      target: "plant_marker_analysis",
      label: "Target genotyping",
    },
    {
      id: "plant-rna-to-expression",
      source: "plant_rnaseq",
      target: "plant_expression_analysis",
      label: "Quantification",
    },
    {
      id: "plant-reduced-to-marker",
      source: "plant_reduced_representation",
      target: "plant_marker_analysis",
      label: "GBS or RAD loci",
    },
    {
      id: "plant-organelle-to-assembly",
      source: "plant_organelle",
      target: "plant_denovo_assembly",
      label: "Chloroplast or mitochondria",
    },
    {
      id: "plant-pathogen-to-screen",
      source: "plant_pathogen",
      target: "plant_pathogen_screen",
      label: "Virus, bacteria and fungi",
    },

    {
      id: "plant-reference-to-variants",
      source: "plant_reference_analysis",
      target: "plant_variants",
      label: "Variant calling",
    },
    {
      id: "plant-reference-to-sv",
      source: "plant_reference_analysis",
      target: "plant_structural_variants",
      label: "Structural variants",
    },
    {
      id: "plant-assembly-to-sv",
      source: "plant_denovo_assembly",
      target: "plant_structural_variants",
      label: "Assembly comparison",
    },
    {
      id: "plant-assembly-to-organelle",
      source: "plant_denovo_assembly",
      target: "plant_organelle_report",
      label: "If organelle data",
    },
    {
      id: "plant-expression-to-report",
      source: "plant_expression_analysis",
      target: "plant_expression_report",
      label: "Expression and pathways",
    },
    {
      id: "plant-marker-to-population",
      source: "plant_marker_analysis",
      target: "plant_population_structure",
      label: "Population genetics",
    },
    {
      id: "plant-marker-to-traits",
      source: "plant_marker_analysis",
      target: "plant_trait_markers",
      label: "Trait association",
    },
    {
      id: "plant-variants-to-population",
      source: "plant_variants",
      target: "plant_population_structure",
      label: "Population genetics",
    },
    {
      id: "plant-variants-to-traits",
      source: "plant_variants",
      target: "plant_trait_markers",
      label: "If phenotype supplied",
    },
    {
      id: "plant-screen-to-report",
      source: "plant_pathogen_screen",
      target: "plant_pathogen_report",
      label: "Pathogen evidence",
    },

    // =====================================================================
    // Fungal routing
    // =====================================================================

    {
      id: "fungus-to-isolate",
      source: "fungus",
      target: "fungal_isolate",
      label: "Isolate DNA",
    },
    {
      id: "fungus-to-its",
      source: "fungus",
      target: "fungal_its",
      label: "ITS primers detected",
    },
    {
      id: "fungus-to-rna",
      source: "fungus",
      target: "fungal_rnaseq",
      label: "RNA assay",
    },
    {
      id: "fungus-to-population",
      source: "fungus",
      target: "fungal_population",
      label: "Multiple isolates",
    },
    {
      id: "fungus-to-targeted",
      source: "fungus",
      target: "fungal_targeted",
      label: "Targeted loci",
    },
    {
      id: "fungus-to-long-read",
      source: "fungus",
      target: "fungal_long_read",
      label: "Long reads",
    },

    {
      id: "fungal-isolate-to-assembly",
      source: "fungal_isolate",
      target: "fungal_assembly",
      label: "Assembly and annotation",
    },
    {
      id: "fungal-its-to-asv",
      source: "fungal_its",
      target: "fungal_asv_otu",
      label: "Denoising or clustering",
    },
    {
      id: "fungal-rna-to-expression",
      source: "fungal_rnaseq",
      target: "fungal_expression_analysis",
      label: "Transcript quantification",
    },
    {
      id: "fungal-population-to-variants",
      source: "fungal_population",
      target: "fungal_variant_analysis",
      label: "Population variants",
    },
    {
      id: "fungal-targeted-to-variants",
      source: "fungal_targeted",
      target: "fungal_variant_analysis",
      label: "Target alleles",
    },
    {
      id: "fungal-long-read-to-assembly",
      source: "fungal_long_read",
      target: "fungal_assembly",
      label: "Flye or Canu",
    },

    {
      id: "fungal-assembly-to-species",
      source: "fungal_assembly",
      target: "fungal_species",
      label: "Species identification",
    },
    {
      id: "fungal-assembly-to-genome",
      source: "fungal_assembly",
      target: "fungal_genome",
      label: "Genome annotation",
    },
    {
      id: "fungal-assembly-to-resistance",
      source: "fungal_assembly",
      target: "fungal_resistance",
      label: "Resistance markers",
    },
    {
      id: "fungal-asv-to-community",
      source: "fungal_asv_otu",
      target: "fungal_community",
      label: "Taxonomic assignment",
    },
    {
      id: "fungal-asv-to-guilds",
      source: "fungal_asv_otu",
      target: "fungal_guilds",
      label: "Guild assignment",
    },
    {
      id: "fungal-expression-to-report",
      source: "fungal_expression_analysis",
      target: "fungal_expression_report",
      label: "Expression and pathways",
    },
    {
      id: "fungal-variants-to-phylogeny",
      source: "fungal_variant_analysis",
      target: "fungal_phylogeny",
      label: "Phylogenetic analysis",
    },
    {
      id: "fungal-variants-to-resistance",
      source: "fungal_variant_analysis",
      target: "fungal_resistance",
      label: "Resistance variants",
    },

    // =====================================================================
    // Mixed or unknown routing
    // =====================================================================

    {
      id: "mixed-to-amplicon",
      source: "mixed",
      target: "mixed_amplicon",
      label: "Marker primers detected",
    },
    {
      id: "mixed-to-shotgun",
      source: "mixed",
      target: "mixed_shotgun",
      label: "Community DNA",
    },
    {
      id: "mixed-to-metatranscriptomics",
      source: "mixed",
      target: "mixed_metatranscriptomics",
      label: "Community RNA",
    },
    {
      id: "mixed-to-viral-discovery",
      source: "mixed",
      target: "mixed_viral_discovery",
      label: "Viral discovery",
    },
    {
      id: "mixed-to-pathogens",
      source: "mixed",
      target: "mixed_pathogen_detection",
      label: "Pathogen screen",
    },
    {
      id: "mixed-to-general",
      source: "mixed",
      target: "mixed_general_screen",
      label: "Assay unresolved",
    },

    // Marker detection

    {
      id: "amplicon-to-16s",
      source: "mixed_amplicon",
      target: "marker_16s",
      label: "16S primers",
    },
    {
      id: "amplicon-to-its",
      source: "mixed_amplicon",
      target: "marker_its",
      label: "ITS primers",
    },
    {
      id: "amplicon-to-18s",
      source: "mixed_amplicon",
      target: "marker_18s",
      label: "18S primers",
    },
    {
      id: "amplicon-to-coi",
      source: "mixed_amplicon",
      target: "marker_coi",
      label: "COI primers",
    },
    {
      id: "amplicon-to-12s",
      source: "mixed_amplicon",
      target: "marker_12s",
      label: "12S primers",
    },
    {
      id: "amplicon-to-custom",
      source: "mixed_amplicon",
      target: "marker_custom",
      label: "Other marker",
    },

    // All markers to common output

    {
      id: "16s-to-asv",
      source: "marker_16s",
      target: "mixed_asv_table",
      label: "DADA2 or QIIME 2",
    },
    {
      id: "its-to-asv",
      source: "marker_its",
      target: "mixed_asv_table",
      label: "DADA2 or clustering",
    },
    {
      id: "18s-to-asv",
      source: "marker_18s",
      target: "mixed_asv_table",
      label: "Denoising",
    },
    {
      id: "coi-to-asv",
      source: "marker_coi",
      target: "mixed_asv_table",
      label: "Denoising",
    },
    {
      id: "12s-to-asv",
      source: "marker_12s",
      target: "mixed_asv_table",
      label: "Denoising",
    },
    {
      id: "custom-to-asv",
      source: "marker_custom",
      target: "mixed_asv_table",
      label: "Configured workflow",
    },

    {
      id: "asv-to-taxonomy",
      source: "mixed_asv_table",
      target: "mixed_taxonomy",
      label: "Reference database",
    },
    {
      id: "taxonomy-to-diversity",
      source: "mixed_taxonomy",
      target: "mixed_diversity",
      label: "Ecological statistics",
    },
    {
      id: "taxonomy-to-differential",
      source: "mixed_taxonomy",
      target: "mixed_differential_abundance",
      label: "If groups supplied",
    },

    // Shotgun and metatranscriptomic routes

    {
      id: "shotgun-to-host-removal",
      source: "mixed_shotgun",
      target: "mixed_host_removal",
      label: "Remove host reads",
    },
    {
      id: "metatranscriptomics-to-host-removal",
      source: "mixed_metatranscriptomics",
      target: "mixed_host_removal",
      label: "Remove host reads",
    },
    {
      id: "viral-discovery-to-host-removal",
      source: "mixed_viral_discovery",
      target: "mixed_host_removal",
      label: "Remove host reads",
    },
    {
      id: "pathogen-detection-to-host-removal",
      source: "mixed_pathogen_detection",
      target: "mixed_host_removal",
      label: "Remove host reads",
    },
    {
      id: "general-screen-to-taxonomic",
      source: "mixed_general_screen",
      target: "mixed_taxonomic_profiling",
      label: "Broad classifier",
    },

    {
      id: "host-removal-to-taxonomic",
      source: "mixed_host_removal",
      target: "mixed_taxonomic_profiling",
      label: "Classify remaining reads",
    },
    {
      id: "host-removal-to-functional",
      source: "mixed_host_removal",
      target: "mixed_functional_profiling",
      label: "Functional profiling",
    },
    {
      id: "host-removal-to-assembly",
      source: "mixed_host_removal",
      target: "mixed_assembly_binning",
      label: "Assembly and binning",
    },

    {
      id: "mixed-profile-to-taxonomy",
      source: "mixed_taxonomic_profiling",
      target: "mixed_taxonomy",
      label: "Taxonomic abundances",
    },
    {
      id: "mixed-profile-to-pathogens",
      source: "mixed_taxonomic_profiling",
      target: "mixed_pathogens",
      label: "Pathogen evidence",
    },
    {
      id: "mixed-functional-to-report",
      source: "mixed_functional_profiling",
      target: "mixed_functional_report",
      label: "Pathways and genes",
    },
    {
      id: "mixed-functional-to-amr",
      source: "mixed_functional_profiling",
      target: "mixed_amr",
      label: "Resistance genes",
    },
    {
      id: "mixed-assembly-to-mags",
      source: "mixed_assembly_binning",
      target: "mixed_mags",
      label: "MAG recovery",
    },
    {
      id: "metatranscriptomics-to-active",
      source: "mixed_metatranscriptomics",
      target: "mixed_active_taxa",
      label: "Expression by taxon",
    },

    // =====================================================================
    // Shared reporting
    // =====================================================================

    {
      id: "read-qc-to-quality-report",
      source: "read_qc",
      target: "quality_report",
      label: "QC metrics",
    },
    {
      id: "quality-to-methods",
      source: "quality_report",
      target: "methods_report",
      label: "Record processing decisions",
    },
    {
      id: "methods-to-reusable",
      source: "methods_report",
      target: "reusable_results",
      label: "Export files and provenance",
    },
  ],
};