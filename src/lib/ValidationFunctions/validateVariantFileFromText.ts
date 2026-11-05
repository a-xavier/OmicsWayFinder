import {type VariantFile} from '../biotypes'

export default async function validateVariantFileFromText(header: string, body: string, filename: string): Promise<{isValid: boolean, result: VariantFile}> {
 let invalidReason: string | undefined = undefined;
 let isValid = true;
  let format_of_file: "VCF.GZ" | "VCF" | "BCF" | "INVALID" = "INVALID";

  // Assign format
  if (filename.endsWith(".vcf.gz") || filename.endsWith(".vcf.bgz")) {
    format_of_file = "VCF.GZ";
  } else if (filename.endsWith(".vcf")) {
    format_of_file = "VCF";
  } else if (filename.endsWith(".bcf")) {
    format_of_file = "BCF";
  } else {
    return {
      isValid: false,
      result: {
        kind: "VARIANT",
        format: "INVALID",
        validity: "INVALID",
        invalidReason:
          "File extension is not .vcf, .vcf.gz or .bcf, cannot be a valid VCF/BCF file",
        info: {},
        multiSample: false,
        id: "",
        input: {
          source: "FILE",
          file: new File([], filename),
          size: 0,
        },
      } as VariantFile,
    };
  }

  // Split fileOutput into headerLines and bodyLines
  const headerLines = header.split("\n")
  const bodyLines = body.split("\n") 

  // Validity checks
  if (headerLines.length === 0) {
    isValid = false;
    invalidReason = "No header lines found in VCF output, likely not a valid VCF/BCF file";
  }
  if (bodyLines.length === 0) {
    isValid = false;
    invalidReason = "No body lines found in VCF output, likely not a valid VCF/BCF file";
  }

  // Split by = and remove all #
  const headerInfo = headerLines
    .map((line) => {
      const cleaned = line.replace(/^#+/, "");
      const idx = cleaned.indexOf("=");
      if (idx === -1) return null;
      return [cleaned.slice(0, idx), cleaned.slice(idx + 1)];
    })
    .filter((parts): parts is [string, string] => Array.isArray(parts) && parts.length === 2);

  // Check if any headerInfo[1] contains (lowercase) hg19 / hg38 / grch37 / grch38 / T2T / CHM13 and return
  // hg19 for hg19/Grch37, hg38 for hg38/Grch38 abd t2t for T2T/CHM13, otherwise INVALID
  let human_assembly_name: "hg19" | "hg38" | "t2t" | "UNKNOWN" = "UNKNOWN";
  for (const [key, value] of headerInfo) {
    if (value.toLowerCase().includes("hg19") || value.toLowerCase().includes("grch37")) {
      human_assembly_name = "hg19";
      break;
    } else if (value.toLowerCase().includes("hg38") || value.toLowerCase().includes("grch38")) {
      human_assembly_name = "hg38";
      break;
    } else if (value.toLowerCase().includes("t2t") || value.toLowerCase().includes("chm13")) {
      human_assembly_name = "t2t";
      break;
    }
  }

  // Check header for contig lines
  const humanContigsChr = new Set([
    "chr1",
    "chr2",
    "chr3",
    "chr4",
    "chr5",
    "chr6",
    "chr7",
    "chr8",
    "chr9",
    "chr10",
    "chr11",
    "chr12",
    "chr13",
    "chr14",
    "chr15",
    "chr16",
    "chr17",
    "chr18",
    "chr19",
    "chr20",
    "chr21",
    "chr22",
  ]);
  const humanContigsNoChr = new Set([
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "11",
    "12",
    "13",
    "14",
    "15",
    "16",
    "17",
    "18",
    "19",
    "20",
    "21",
    "22",
    "X",
    "Y",
    "M",
  ]);
  const contigLines = headerLines.filter((line) => line.startsWith("##contig="));
  const contigs = contigLines
    .map((line) => {
      const idMatch = line.match(/ID=([^,>]+)/);
      return idMatch ? idMatch[1] : null;
    })
    .filter((contig): contig is string => contig !== null);

  let humanLike = false;
  let hasChrPrefix: "WITH_CHR" | "WITHOUT_CHR" | "UNKNOWN" = "UNKNOWN";
  if (humanContigsChr.has([...contigs].find((contig) => humanContigsChr.has(contig)) || "")) {
    humanLike = true;
    hasChrPrefix = "WITH_CHR";
  }
  if (humanContigsNoChr.has([...contigs].find((contig) => humanContigsNoChr.has(contig)) || "")) {
    humanLike = true;
    hasChrPrefix = "WITHOUT_CHR";
  }

  // Grab sample names from header (lines that starts with #CHROM and split by tab, sample names are from 10th column onwards)
  const sampleNames: string[] = [];
  const chromLine = headerLines.find((line) => line.startsWith("#CHROM"));
  if (chromLine) {
    const parts = chromLine.split("\t");
    if (parts.length > 9) {
      sampleNames.push(...parts.slice(9));
    }
  }

  // IF WE HAVE a VCF or VCF.gz we can get the body
  let numSamples = 0;
  let isPhased = false;
  let hasRsids = false;
  // Split by tab
  const raw_variants = bodyLines.map((line) => {
    const [chrom, pos, id, ref, alt, qual, filter, info, format, ...samples] = line.split("\t");
    return {
      chrom,
      pos: Number(pos),
      id,
      ref,
      alt,
      qual: Number(qual),
      filter,
      info,
      format,
      samples,
    };
  });

  // Sometimes can bug and have the very last variant empty because of truncated file 
  // Also first line might be error because of truncated file [W::bcf_sr_add_reader] No BGZF EOF marker; file '/tmp/chunk.bcf' may be truncated
  // Remove items where alt undefined or ref undefined or id undefined
    const variants = raw_variants.filter((variant) => variant.alt && variant.ref && variant.id);

  // Check if any rsids in the id column
  hasRsids = variants.some((variant) => variant.id.startsWith("rs"));

  // Get Number of Samples
  numSamples = variants.length > 0 ? variants[0].samples.length : 0;

  // VERY IMPORTANT
  if (numSamples === 0) {
    isValid = false; // Not valid if no samples
    invalidReason = "No samples found in VCF body";
  }

  // Check if phased (more than 50% of the variant has | in the first sample column)
  isPhased =
    variants.length > 0 && numSamples > 0
      ? variants.filter((variant) => variant.samples[0].includes("|")).length / variants.length >
        0.5
      : false;

  // Returns dummy result for now, to be implemented later
  return {
    isValid: isValid,
    result: {
      kind: "VARIANT",
      format: format_of_file,
      validity: isValid ? "VALID" : "INVALID",
      invalidReason: invalidReason,
      info: {
        human_assembly_name,
        human_like: humanLike,
        chr_prefix: hasChrPrefix,
        has_rsids: hasRsids,
        num_samples: numSamples,
        sampleNames: sampleNames,
        is_phased: isPhased,
      },
      multiSample: numSamples > 1,
      id: "",
      input: {
        source: "FILE",
        file: new File([], ""),
        size: 0,
      },
    },
  };
}


// #CHROM  POS     ID      REF     ALT     QUAL    FILTER  INFO    FORMAT SAMPLE1 SAMPLE2 ... SAMPLEN
export type Variant = {
  chrom: string;
  pos: number;
  id: string;
  ref: string;
  alt: string;
  qual: number;
  filter: string;
  info: string;
  format: string;
  samples: string[];
};
