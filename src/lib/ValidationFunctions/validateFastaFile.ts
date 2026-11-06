import type { FastaFile } from "../biotypes";
import { Gunzip } from "fflate";


export const DNA_BASES = new Set(['A', 'C', 'G', 'T', "N", "a", "c", "g", "t", "n"]);
export const RNA_BASES = new Set(['A', 'C', 'G', 'U', "N", "a", "c", "g", "u", "n"]);
export const AMINO_ACIDS = new Set([
    'A', 'R', 'N', 'D', 'C', 'Q', 'E', 'G', 'H', 'I', 
    'L', 'K', 'M', 'F', 'P', 'S', 'T', 'W', 'Y', 'V',
    "a", "r", "n", "d", "c", "q", "e", "g", "h", "i", 
    "l", "k", "m", "f", "p", "s", "t", "w", "y", "v"
]);

export default async function validateFastaFile(comp: string, file: File): Promise<{isValid: boolean, result: FastaFile}> {

    // get first MB of file or full file if smaller
    let text = ""
    let isValid = true;
    let type: "DNA" | "RNA" | "PROTEIN" | "UNKNOWN" = "UNKNOWN";
    const maxSize = 1024 * 1024; // 1 MB
    let mixedCase = false;
    let invalidReason: string | undefined = undefined;



    // PARSE comp RESULTS WHICH FORMAT IS 
// 1	248956422	67070277	48055043	48111528	67244164	0	0	18475410	18	    0	    0
// 2	242193529	71791213	48318180	48450903	71987932	0	0	1645301	4385340	    0	    0	    0
// 3	198295559	59689091	39233483	39344259	59833302	0	0	195424	3346586	    0	    0	    0
// 4	190214555	58561236	36236976	36331025	58623430	0	0	461888	3006858	    0	    0	    0
// 5	181538259	54699094	35731600	35879674	54955010	0	0	272881	3133070	    0	    0	    0
// 6	170805979	51345477	33646690	33713330	51373025	0	0	727457	3022378	    0	    0	    0
// 7	159345973	47058248	32317984	32378859	47215040	0	0	375842	3245650	    0	    0	    0
// 8	145138636	43333530	29030173	29103787	43300646	0	0	370500	2676400	0	0	0
// 9	138394717	35736329	25099811	25170662	35783748	0	0	16604167	2511456	0	0	0
// 10	133797422	38875926	27639505	27719976	39027555	0	0	534460	2777956	0	0	0
// 11	135086622	39286730	27903257	27981801	39361954	0	0	552880	2666228	0	0	0
// 12	133275309	39370109	27092804	27182678	39492225	0	0	137493	2631936	0	0	0
// 13	114364328	30047611	18839192	18933605	30162717	0	0	16381203	1684938	0	0	0
// 14	107043718	26673415	18423758	18559033	26911943	0	0	16475569	1791762	0	0	0
// 15	101991189	24508669	17752941	17825903	24553812	0	0	17349864	1812052	0	0	0
// 16	90338345	22558319	18172742	18211322	22653477	0	0	0	0	0	0	0

// Output format: chr, length, #A, #C, #G, #T, #2, #3, #4, #CpG, #tv, #ts, #CpG-ts
// we only care about chr and length

const chrLengthMap: Record<string, number> = {};
const lines = comp.split('\n');
for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length >= 2) {
        const chr = parts[0];
        const length = parseInt(parts[1], 10);
        if (!isNaN(length)) {
            chrLengthMap[chr] = length;
        }
    }
}


    // PARSE BODY
    if (file.name.toLowerCase().endsWith('.gz')) {
        let bytesRead = 0;
        let compressedBytesRead = 0;
        let stage = 'initializing';

        try {
            const prefix = new Uint8Array(maxSize);
            const gunzip = new Gunzip(chunk => {
                const bytesToCopy = Math.min(chunk.length, maxSize - bytesRead);
                prefix.set(chunk.subarray(0, bytesToCopy), bytesRead);
                bytesRead += bytesToCopy;
            });

            const compressedChunkSize = 16 * 1024;
            while (bytesRead < maxSize && compressedBytesRead < file.size) {
                stage = 'reading';
                const end = Math.min(compressedBytesRead + compressedChunkSize, file.size);
                const chunk = new Uint8Array(await file.slice(compressedBytesRead, end).arrayBuffer());
                compressedBytesRead = end;
                stage = 'decompressing';
                gunzip.push(chunk, end === file.size);
            }
            if (file.size === 0) {
                stage = 'decompressing';
                gunzip.push(new Uint8Array(0), true);
            }

            stage = 'decoding';
            text = new TextDecoder().decode(prefix.subarray(0, bytesRead));
        } catch (error) {
            isValid = false;
            invalidReason = `Failed to decompress gzip while ${stage} after ${bytesRead} output bytes: ${error instanceof Error ? error.message : String(error)}`;
        }
    } else {
        const blob = file.slice(0, maxSize);
        text = await blob.text();
    }

    // Remove all lines starting with '>'
    const sequences = text.split(/\r?\n/).filter(line => !line.startsWith('>')).join('');
    // Flatten into a set (unique characters in the sequences)

    const uniqueChars = new Set(sequences);

    if (isValid && uniqueChars.size === 0) {
        invalidReason = "Empty sequence"; 
        isValid = false;
    }

    // first check if mix of upper and lower case
    const hasUpper = Array.from(uniqueChars).some(c => c === c.toUpperCase() && c !== c.toLowerCase());
    const hasLower = Array.from(uniqueChars).some(c => c === c.toLowerCase() && c !== c.toUpperCase());
    if (hasUpper && hasLower) {
        mixedCase = true;
    }
    // Check if the sequence contains only valid DNA, RNA, or amino acid characters
    const isDNA = Array.from(uniqueChars).every(c => DNA_BASES.has(c));
    const isRNA = Array.from(uniqueChars).every(c => RNA_BASES.has(c));
    const isProtein = Array.from(uniqueChars).every(c => AMINO_ACIDS.has(c));

    if (isDNA) {
        type = "DNA";
    } else if (isRNA) {
        type = "RNA";
    } else if (isProtein) {
        type = "PROTEIN";
    } else {
        type = "UNKNOWN";
    }

    // If DNA then check if human and if which sequence it matches 
    // check if ANY sequence matches ANY human reference sequence
    // check if any sequence in chrLengthMap matche size in HUMAN_REFERENCE_LENGTHS (check hg19 hg38 and T2T without prefix just compare size)
    let humanLike = false;
    let matchedReference = "";
    Object.values(chrLengthMap).forEach(element => {
        Object.entries(HUMAN_REFERENCE_LENGTHS).forEach(([reference, lengths]) => {
            Object.values(lengths.withoutChrPrefix).forEach(humanLength => {
                if (element === humanLength) {
                    humanLike = true;
                    matchedReference = reference;
                }
            });
        });
        
    });


  return { isValid, result: {
      id: "",
    input: { source: "FILE", file, size: file.size },
      kind: "FASTA",
    format: file.name.toLowerCase().endsWith('.gz') ? "FASTA.GZ" : "FASTA",
      validity: isValid ? "VALID" : "INVALID",
      invalidReason,
      info: {
          sequenceCount: Object.keys(chrLengthMap).length,
          sequences: chrLengthMap,
          lettersPresent: Array.from(uniqueChars),
          mixedCase,
          type,
          humanLike,
          matchedReference
      }
  } as FastaFile };
}

// Nuclear chromosome lengths from NCBI assembly reports (mitochondria excluded).
// hg19: GRCh37.p13, GCF_000001405.25; hg38: GRCh38.p14, GCF_000001405.40.
// T2T: CHM13v2.0, GCA_009914755.4, including the NA24385 Y chromosome.

const HUMAN_REFERENCE_LENGTHS = {
    hg19: {

    withChrPrefix:         // With chr prefix 
        {
        chr1: 249250621,
        chr2: 243199373,
        chr3: 198022430,
        chr4: 191154276,
        chr5: 180915260,
        chr6: 171115067,
        chr7: 159138663,
        chr8: 146364022,
        chr9: 141213431,
        chr10: 135534747,
        chr11: 135006516,
        chr12: 133851895,
        chr13: 115169878,
        chr14: 107349540,
        chr15: 102531392,
        chr16: 90354753,
        chr17: 81195210,
        chr18: 78077248,
        chr19: 59128983,
        chr20: 63025520,
        chr21: 48129895,
        chr22: 51304566,
        chrX: 155270560,
        chrY: 59373566
    },
    withoutChrPrefix: {
        1: 249250621,
        2: 243199373,
        3: 198022430,
        4: 191154276,
        5: 180915260,
        6: 171115067,
        7: 159138663,
        8: 146364022,
        9: 141213431,
        10: 135534747,
        11: 135006516,
        12: 133851895,
        13: 115169878,
        14: 107349540,
        15: 102531392,
        16: 90354753,
        17: 81195210,
        18: 78077248,
        19: 59128983,
        20: 63025520,
        21: 48129895,
        22: 51304566,
        X: 155270560,
        Y: 59373566
    },
    },
    hg38: {
        withChrPrefix: {
            chr1: 248956422,
            chr2: 242193529,
            chr3: 198295559,
            chr4: 190214555,
            chr5: 181538259,
            chr6: 170805979,
            chr7: 159345973,
            chr8: 145138636,
            chr9: 138394717,
            chr10: 133797422,
            chr11: 135086622,
            chr12: 133275309,
            chr13: 114364328,
            chr14: 107043718,
            chr15: 101991189,
            chr16: 90338345,
            chr17: 83257441,
            chr18: 80373285,
            chr19: 58617616,
            chr20: 64444167,
            chr21: 46709983,
            chr22: 50818468,
            chrX: 156040895,
            chrY: 57227415
        },
        withoutChrPrefix: {
            1: 248956422,
            2: 242193529,
            3: 198295559,
            4: 190214555,
            5: 181538259,
            6: 170805979,
            7: 159345973,
            8: 145138636,
            9: 138394717,
            10: 133797422,
            11: 135086622,
            12: 133275309,
            13: 114364328,
            14: 107043718,
            15: 101991189,
            16: 90338345,
            17: 83257441,
            18: 80373285,
            19: 58617616,
            20: 64444167,
            21: 46709983,
            22: 50818468,
            X: 156040895,
            Y: 57227415
        }
    },
    T2T: {
        withChrPrefix: {
            chr1: 248387328,
            chr2: 242696752,
            chr3: 201105948,
            chr4: 193574945,
            chr5: 182045439,
            chr6: 172126628,
            chr7: 160567428,
            chr8: 146259331,
            chr9: 150617247,
            chr10: 134758134,
            chr11: 135127769,
            chr12: 133324548,
            chr13: 113566686,
            chr14: 101161492,
            chr15: 99753195,
            chr16: 96330374,
            chr17: 84276897,
            chr18: 80542538,
            chr19: 61707364,
            chr20: 66210255,
            chr21: 45090682,
            chr22: 51324926,
            chrX: 154259566,
            chrY: 62460029
        },
        withoutChrPrefix: {
            1: 248387328,
            2: 242696752,
            3: 201105948,
            4: 193574945,
            5: 182045439,
            6: 172126628,
            7: 160567428,
            8: 146259331,
            9: 150617247,
            10: 134758134,
            11: 135127769,
            12: 133324548,
            13: 113566686,
            14: 101161492,
            15: 99753195,
            16: 96330374,
            17: 84276897,
            18: 80542538,
            19: 61707364,
            20: 66210255,
            21: 45090682,
            22: 51324926,
            X: 154259566,
            Y: 62460029
        }
    }
};