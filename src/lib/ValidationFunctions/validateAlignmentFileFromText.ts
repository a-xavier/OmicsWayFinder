import type { AlignmentFile } from "../biotypes"

/* ========================================================================
    Functions to validate the file from the blob using samtools and return info about the file
========================================================================== */

// Necessary function to validate the file from blob
// Offload them from the api route because it can be used in other places and also to avoid having to read the file twice (once in the api route and once in the validateFile function)

export async function validateAlignmentFileFromText(
  header: string,
  body: string,
  filename: string
): Promise<{ isValid: boolean; alignmentFile: AlignmentFile }> {
 
  /* =======================================================================
                Parse outputs and construct response
         ======================================================================== */

  // Things we are looking for in header:
  // @HD line with VN and SO tags -> valid header
  // @SQ lines with SN and LN tags -> valid reference sequences
  // Based on sequence and length we can infer assembly used (hg19 / 38 / T2T) / human or not
  // IF RG we can check PL for platform

  // Validate file (proper header and some reads present )
  let isValid = true; // start true and if any checks fail we set to false and add reason to invalidReason string which we return at the end for better UX
  let invalidReason: string | undefined = "";

  
  const headerInfo = headerToInfoRecord(header);

  // Things we are looking for in body:
  // tags for basemod like MM and ML for mod detection
  // if presence of a lot of

  const bodyInfo = bodyToInfoRecord(body);

  // If zero average length is invalid
  if (bodyInfo.averageSeqLength === 0) {
    isValid = false;
    invalidReason +=
      "Average read length is zero, likely not a valid BAM/CRAM/SAM file or empty file.\n";
  }

  /* =======================================================================
            Build final AlignmentFile object to return based on header and body info
         ======================================================================== */

  const returnALignmentFile: AlignmentFile = {
    kind: "ALIGNMENT",
    format: headerInfo.hasHD
      ? filename.endsWith(".bam")
        ? "BAM"
        : filename.endsWith(".cram")
          ? "CRAM"
          : filename.endsWith(".sam")
            ? "SAM"
            : "INVALID"
      : "INVALID",
    isAligned: headerInfo.aligned,
    hasBaseModification: bodyInfo.hasBaseMod,
    platform:
      bodyInfo.inferredPlatform === "SHORT_READS"
        ? "SHORT_READS"
        : bodyInfo.inferredPlatform === "PACBIO"
          ? "PACBIO"
          : bodyInfo.inferredPlatform === "ONT"
            ? "ONT"
            : "UNKNOWN",
    multiSample: headerInfo.numberOfSamplesFromRG > 1,
    stats: {
      meanReadLength: bodyInfo.averageSeqLength,
      meanReadQuality: bodyInfo.averageQualScore,
    },
    validity: isValid ? "VALID" : "INVALID",
    invalidReason: invalidReason,
    info: {
      header_info: headerInfo,
      body_info: bodyInfo,
    },
    id: "",
    input: {
      source: "FILE",
      file: new File([], filename), // Here we put placeholder because we just have blob so far
      size: 0,
    },
  };

  return { isValid, alignmentFile: returnALignmentFile };
}

// Helper functions

// Function that will parse the samtools header and returns some info
// about the file
export function headerToInfoRecord(header: string) {
  // Split header into lines
  const lines = header.split("\n");
  // Split each line into fields by tab
  const fields = lines.map((line) => line.split("\t"));

  // 1 Check if fields [0] [0] is @HD
  const hasHD = fields[0][0] === "@HD"; // Likely not valid bam
  const version = hasHD
    ? fields[0].find((f) => f.startsWith("VN:"))?.replace("VN:", "")
    : "UNKNOWN";
  const sortOrder = hasHD
    ? fields[0].find((f) => f.startsWith("SO:"))?.replace("SO:", "")
    : "UNKNOWN";

  // 2 Check if any fields have @SQ with SN and LN tags else tag as unaligned
  const sqLines = fields.filter((f) => f[0] === "@SQ");
  const hasSQ = sqLines.length > 0; // If no SQ lines likely unaligned

  // 3 Check if all SQ lines might be human and if so infer assembly based on length of chromosomes (might not have 1 2 3 etc but if we have chr1 chr2 chr3 etc likely human)

  let humanLike = false;
  let assemblyName = "UNKNOWN";

  if (hasSQ) {
    const { assemblyName: inferredAssembly, humanLike: isHumanLike } =
      GuessHumanAssemblyFromHeader(sqLines);
    humanLike = isHumanLike;
    assemblyName = inferredAssembly;
  }

  // 4 - Check RG for platform
  const rgLines = fields.filter((f) => f[0] === "@RG");

  // Create a list of maps from RG we can report
  // Get any key with any valude, split by :

  const readGroups = rgLines.map((line) => {
    const rgInfo: Record<string, string> = {};
    line.forEach((field) => {
      const [key, value] = field.split(":", 2);
      if (key && value) {
        rgInfo[key] = value;
      }
    });
    return rgInfo;
  });

  // Count unique SM values to get a sense of how many samples we have
  const sampleNames = new Set<string>();
  rgLines.forEach((line) => {
    const smField = line.find((f) => f.startsWith("SM:"));
    if (smField) {
      sampleNames.add(smField.replace("SM:", ""));
    }
  });

  let platform = "UNKNOWN";
  if (rgLines.length > 0) {
    const plField = rgLines[0].find((f) => f.startsWith("PL:"));
    if (plField) {
      platform = plField.replace("PL:", "");
    }
  }

  // 5- Grab all step to produce bam from @PG lines for more info in the future
  // Split into ID PN VN CL and put as null if not here
  const pgLines = fields.filter((f) => f[0] === "@PG");
  const pgInfo = pgLines.map((line) => {
    const idField = line.find((f) => f.startsWith("ID:"));
    const pnField = line.find((f) => f.startsWith("PN:"));
    const vnField = line.find((f) => f.startsWith("VN:"));
    const clField = line.find((f) => f.startsWith("CL:"));
    return {
      id: idField ? idField.replace("ID:", "") : null,
      program: pnField ? pnField.replace("PN:", "") : null,
      version: vnField ? vnField.replace("VN:", "") : null,
      commandLine: clField ? clField.replace("CL:", "") : null,
    };
  });

  return {
    hasHD: hasHD,
    version: version ?? "UNKNOWN",
    sortOrder: sortOrder ?? "UNKNOWN",
    aligned: hasSQ,
    humanLike: humanLike,
    assemblyName: assemblyName ?? "UNKNOWN",
    platformFromRG: platform ?? "UNKNOWN",
    programInfoFromPG: pgInfo,
    readGroups: readGroups,
    numberOfSamplesFromRG: sampleNames.size,
    contigFromHeader: sqLines.map((line) => {
      const snField = line.find((f) => f.startsWith("SN:"));
      const lnField = line.find((f) => f.startsWith("LN:"));
      return {
        name: snField ? snField.replace("SN:", "") : "UNKNOWN",
        length: lnField ? parseInt(lnField.replace("LN:", ""), 10) : 0,
      };
    }),
  };
}

// Get dictionary for human reference chromosome names and length
const humanReferenceChromosomes = {
  lengths: {
    hg19: [
      249250621, 243199373, 198022430, 191154276, 180915260, 171115067, 159138663, 146364022,
      141213431, 135534747, 135006516, 133851895, 115169878, 107349540, 102531392, 90354753,
      81195210, 78077248, 59128983, 63025520, 48129895, 51304566, 155270560, 59373566,
    ],
    hg38: [
      248956422, 242193529, 198295559, 190214555, 181538259, 170805979, 159345973, 145138636,
      138394717, 133797422, 135086622, 133275309, 114364328, 107043718, 101991189, 90338345,
      83257441, 80373285, 58617616, 64444167, 46709983, 50818468, 156040895, 57227415,
    ],
    T2T: [
      248387328, 242696752, 201105948, 193574945, 182045439, 172126628, 160567428, 146259331,
      150617247, 134758134, 135127769, 133324548, 113566686, 101161492, 99753195, 96330374,
      84276997, 80542538, 61707364, 66210255, 45090682, 51324926, 154259566, 62460029, 16569,
    ],
  },
};

function GuessHumanAssemblyFromHeader(sqLines: string[][]): {
  assemblyName: string;
  humanLike: boolean;
} {
  let humanLike = false;
  let assemblyName = "UNKNOWN";

  if (sqLines.length > 0) {
    const canonicalChromosomes = new Map(); // sn -> length

    for (const line of sqLines) {
      const snField = line.find((f) => f.startsWith("SN:"));
      const lnField = line.find((f) => f.startsWith("LN:"));
      if (!snField || !lnField) continue;

      let sn = snField.replace("SN:", "");
      const ln = parseInt(lnField.replace("LN:", ""), 10);
      if (Number.isNaN(ln)) continue;

      // Normalize "chr" prefix
      if (sn.startsWith("chr")) {
        sn = sn.slice(3);
      }

      // Keep only canonical chromosomes
      if (/^(?:[1-9]|1[0-9]|2[0-2]|X|Y|M|Mt)$/.test(sn)) {
        canonicalChromosomes.set(sn, ln);
      }
    }

    // Require enough signal to even consider this human
    if (canonicalChromosomes.size >= 6) {
      humanLike = true;

      // Assembly scoring
      const assemblyScores = Object.fromEntries(
        Object.keys(humanReferenceChromosomes.lengths).map((a) => [a, 0]),
      );

      for (const ln of canonicalChromosomes.values()) {
        for (const [assembly, lengths] of Object.entries(humanReferenceChromosomes.lengths)) {
          if (lengths.includes(ln)) {
            assemblyScores[assembly]++;
          }
        }
      }

      // Pick best assembly if confidence is high enough
      let bestAssembly = "UNKNOWN";
      let bestScore = 0;

      for (const [assembly, score] of Object.entries(assemblyScores)) {
        if (score > bestScore) {
          bestScore = score;
          bestAssembly = assembly;
        }
      }

      // Require multiple agreeing chromosomes
      if (bestScore >= 6) {
        assemblyName = bestAssembly;
      }
    }
  }

  return { assemblyName, humanLike };
}

// Function to parse samtools reads (body) and return some info about the file like if we see mod tags etc
function bodyToInfoRecord(body: string) {
  const lines = body.split("\n");
  const numberOfReads = lines.length;
  const fields = lines.map((line) => line.split("\t"));

  // fields[x][0] should be QNAME, fields[x][1] should be FLAG, fields[x][2] should be RNAME, fields[x][3] should be POS, fields[x][4] should be MAPQ, fields[x][5] should be CIGAR, fields[x][6] should be RNEXT, fields[x][7] should be PNEXT, fields[x][8] should be TLEN, fields[x][9] should be SEQ, fields[x][10] should be QUAL and then optional tags start from fields[x][11]

  const modReads = fields.filter(
    (f) =>
      f.length > 11 && f.slice(11).some((tag) => tag.startsWith("MM:") || tag.startsWith("ML:")), // reads need both MM and ML tags for downstream tools to work
  );

  const hadBaseMod = modReads.length > 0;

  const baseMods = new Set<string>();

  // Grab which base modifications are there after the MM tag
  // SAM codes are:
  //   Mod	Name	SAM Code	CHEBI
  //   5mC	5-Methylcytosine	C+m	CHEBI:27551
  //   5hmC	5-Hydroxymethylcytosine	C+h	CHEBI:76792
  //   4mC	N(4)-methylcytosine	C+21839	CHEBI:21839
  //   6mA	6-Methyladenine	A+a	CHEBI:28871
  const modCodeToName: Record<string, string> = {
    "C+m": "5mC",
    "C+h": "5hmC",
    "C+21839": "4mC",
    "A+a": "6mA",
  };

  const modCodetoLongName: Record<string, string> = {
    "5mC": "5-Methylcytosine",
    "5hmC": "5-Hydroxymethylcytosine",
    "4mC": "N(4)-methylcytosine",
    "6mA": "6-Methyladenine",
  };

  for (const read of modReads) {
    const mmTag = read.find((tag) => tag.startsWith("MM:"));
    if (mmTag) {
      const modInfo = mmTag.split(":")[2]; // Format is MM:Z:C+m,0,1;A+a,0;
      const modsInRead = modInfo.split(";").map((m) => m.split(",")[0]); // Get C+m from C+m,0,1
      modsInRead.forEach((m) => {
        const modName = modCodeToName[m.replace("?", "")];
        if (modName) {
          baseMods.add(`${modName} (${modCodetoLongName[modName]})`);
        }
      });
    }
  }

  // Do average of all SEQ lengths
  const seqLengths = fields.map((f) => f[9]?.length || 0);
  const avgSeqLength = seqLengths.reduce((a, b) => a + b, 0) / seqLengths.length;

  // Do average of all QUAL scores
  const qualScores = fields.map((f) => (f[10] ? qualityStringToMeanQuality(f[10]) : 0));
  const avgQualScore = qualScores.reduce((a, b) => a + b, 0) / qualScores.length;

  // Do read length standard deviation (not super useful for now)
  const stdDevReadLength = Math.sqrt(
    seqLengths.reduce((a, b) => a + (b - avgSeqLength) ** 2, 0) / seqLengths.length,
  );

  // Guess a platform based on length and quality
  let platform = "UNKNOWN";
  if (avgSeqLength > 600 && avgQualScore < 30) {
    platform = "ONT";
  } else if (avgSeqLength > 600 && avgQualScore > 30) {
    platform = "PACBIO";
  } else if (avgSeqLength < 600 && avgQualScore > 30) {
    platform = "SHORT_READS";
  }

  // Check if maybe RNAseq based on cigar string containing N operators for spliced alignments
  const percentageSpliced = fields.filter((f) => f[5]?.includes("N")).length / numberOfReads;
  const isRNAseq = percentageSpliced > 0.05; // Arbitrary threshold of 5% spliced reads to call it RNA-seq

  return {
    hasBaseMod: hadBaseMod,
    baseMods: baseMods ? Array.from(baseMods) : [],
    averageSeqLength: avgSeqLength,
    averageQualScore: avgQualScore,
    stdDevReadLength: stdDevReadLength,
    inferredPlatform: platform,
    isRNAseq: isRNAseq,
  };
}

function qualityStringToMeanQuality(qual: string): number {
  // Convert ASCII quality string to mean quality score
  const scores = qual.split("").map((c) => c.charCodeAt(0) - 33);
  const meanQuality = scores.reduce((a, b) => a + b, 0) / scores.length;
  return meanQuality;
}
