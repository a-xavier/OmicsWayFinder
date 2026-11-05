import { AsyncGunzip } from "fflate";
import type { FastqFile } from "../biotypes"

export async function ungzipArrayBuffer(
  buffer: ArrayBuffer,
  chunkSize = 64 * 1024, // 64 KB chunks
): Promise<string> {
  const gunzip = new AsyncGunzip();
  const decoder = new TextDecoder("utf-8");

  let text = "";
  let aborted = false;

  const data = new Uint8Array(buffer);

  await new Promise<void>((resolve) => {
    gunzip.ondata = (err, chunk, final) => {
      // ✅ Case 1: valid decompressed data
      if (!err && chunk?.length) {
        text += decoder.decode(chunk, { stream: true });
        return;
      }

      // ✅ Case 2: expected truncation (EOF in BGZF / partial gzip)
      if (err && err.message?.includes("EOF")) {
        aborted = true;
        text += decoder.decode();
        resolve();
        return;
      }

      // ❌ Case 3: real error (still resolve, worker decides validity)
      if (err) {
        aborted = true;
        text += decoder.decode();
        resolve();
        return;
      }

      // ✅ Case 4: clean finish (rare with BGZF)
      if (final) {
        text += decoder.decode();
        resolve();
      }
    };

    // Feed data incrementally to mimic streaming behavior
    for (let offset = 0; offset < data.length && !aborted; offset += chunkSize) {
      const slice = data.subarray(offset, offset + chunkSize);
      gunzip.push(slice);
    }

    // Always signal end
    gunzip.push(new Uint8Array(0), true);
  });

  return text;
}

export async function validateFastqFromArrayBuffer(
  chunk: ArrayBuffer,
  filename: string,
): Promise<{ isValid: boolean; fastqFile: FastqFile }> {
  let text = "";

  if (filename.endsWith(".gz") || filename.endsWith(".bgz") || filename.endsWith(".bgzip")) {
    text = await ungzipArrayBuffer(chunk);
  } else {
    text = await new TextDecoder("utf-8").decode(chunk);
  }

  // Split into lines and every 4 lines create a read object and push to reads array. Stop after 1000 reads or end of file
  const lines = text.split("\n");
  const reads = [];
  for (let i = 0; i < lines.length; i += 4) {
    if (i + 3 >= lines.length) {
      break;
    }
    const read: FastqRead = {
      header: lines[i],
      sequence: lines[i + 1],
      quality: lines[i + 3],
    };
    reads.push(read);
    if (reads.length >= 1000) {
      break;
    }

    // Remove last item of reads to avoid having an incomplete read (from truncated file)
    if (i + 4 >= lines.length) {
      reads.pop();
    }
  }

  // Check validity: header starts with @, sequence and quality have the same length, quality only contains ASCII characters between 33 and 126
  let isValid = false;
  let invalidReason: string | undefined = undefined;
  const proportionATGCN =
    reads.reduce((acc, read) => {
      const seq = read.sequence.toUpperCase();
      const atgcnCount = (seq.match(/[ATGCN]/g) || []).length;
      return acc + atgcnCount / seq.length;
    }, 0) / reads.length;

  if (reads.length === 0) {
    isValid = false; // Not valid if no reads
    invalidReason = "No reads found in FASTQ file";
  }

  // Separate conditions so we get more info if invalid
  if (
    reads.length > 0 &&
    proportionATGCN > 0.8 // most character are ATGCN in sequence
  ) {
    isValid = true;
  } else {
    isValid = false;
    invalidReason = "Invalid FASTQ format: Contains high (>20%) proportion of non-ATGCN characters";
  }

  if (reads[0].header.startsWith("@")) {
    isValid = true;
  } else {
    isValid = false;
    invalidReason =
      "Invalid FASTQ format: Header does not start with @ or sequence and quality lengths do not match";
  }

  if (reads.every((read) => read.sequence.length === read.quality.length)) {
    isValid = true;
  } else {
    invalidReason =
      "Sequence and quality lengths do not match for all reads (can happen after truncation)";
    // do not invalidate because sometime we truncate file in the middle of a read (especially long reads)
  }

  // Average read length and quality
  let totalReadLength = 0;
  let totalReadQuality = 0;
  for (const read of reads) {
    totalReadLength += read.sequence.length;
    totalReadQuality +=
      read.quality.split("").reduce((acc, char) => acc + char.charCodeAt(0) - 33, 0) /
      read.quality.length;
  }
  const avgReadLength = totalReadLength / reads.length;
  const avgReadQuality = totalReadQuality / reads.length;

  // Get read length standard deviation (will be usefull for metagenmics maybe to distinguish between 16S and chromosome sequencing for example)
  let varianceReadLength = 0;
  for (const read of reads) {
    varianceReadLength += Math.pow(read.sequence.length - avgReadLength, 2);
  }
  varianceReadLength = varianceReadLength / reads.length;
  const stdDevReadLength = Math.sqrt(varianceReadLength);

  // Detect R1 R2 from header if it ends with /1 or /2 or :1 or :2
  let inferredRead: "R1" | "R2" | "UNKNOWN" = "UNKNOWN";
  // Check if /1 in all headers or /2 in all headers or :1 in all headers or :2 in all headers
  const r1Count = reads.filter((read) => classifyFastqBasedOnHeader(read.header) === "R1").length;
  const r2Count = reads.filter((read) => classifyFastqBasedOnHeader(read.header) === "R2").length;
  if (r1Count === reads.length && r2Count === 0) {
    inferredRead = "R1";
  } else if (r2Count === reads.length && r1Count === 0) {
    inferredRead = "R2";
  }

  // Platform
  // if avg length > 600 and quality > 30 then PACBIO
  // if avg length > 600 and quality < 30 then ONT
  // if avg length < 600  then SHORT_READS
  // else UNKNOWN
  let platform: "PACBIO" | "ONT" | "SHORT_READS" | "UNKNOWN" = "UNKNOWN";
  if (avgReadLength > 600 && avgReadQuality > 30) {
    platform = "PACBIO";
  } else if (avgReadLength > 600 && avgReadQuality <= 30) {
    platform = "ONT";
  } else if (avgReadLength <= 600) {
    platform = "SHORT_READS";
  } else {
    platform = "UNKNOWN";
  }

  // CHeck for UMI using the firs 10 reads, if they have 25% G C T A in the first N reads and the it changes then has UMI as first N reads
  // Steps
  // For each position i in 1 to 10 calculate the percentage of G C T A in that position across the first all reads
  // If not between 0.245 and 0.255 then no UMI
  // Else could be UMI go to position i+1 and repeat until we find a position that is not between 0.245 and 0.255 or we reach position 10. If we reach position 10 then we have a UMI of length 10, else we have a UMI of length i.
  // TODO: NOT SURE IF NECESSARY
  // SKIP FOR NOW

  // for (let i = 0; i < 12; i++) {
  //     const baseCounts = { A: 0, C: 0, G: 0, T: 0 };
  //     let totalBases = 0;

  //     for (const read of reads) {
  //         if (read.sequence.length <= i) continue;
  //         const base = read.sequence[i].toUpperCase();
  //         if (base === "A" || base === "C" || base === "G" || base === "T") {
  //             baseCounts[base]++;
  //             totalBases++;
  //         }
  //     }

  //     if (totalBases === 0) break;

  //     const H = entropy(baseCounts, totalBases);

  //     console.log(
  //         `Position ${i + 1}: H=${H.toFixed(3)} ` +
  //         `A=${(baseCounts.A / totalBases).toFixed(2)} ` +
  //         `C=${(baseCounts.C / totalBases).toFixed(2)} ` +
  //         `G=${(baseCounts.G / totalBases).toFixed(2)} ` +
  //         `T=${(baseCounts.T / totalBases).toFixed(2)}`
  //     );

  //     const stats = collisionRateAnalysis(reads, i);

  //     console.log(
  //         `Collision rate at prefix length ${i + 1}: ${(stats.collisionRate * 100).toFixed(2)}% ` +
  //         `(Unique prefixes: ${stats.uniquePrefixes}, Singleton prefixes: ${stats.singletonPrefixes}, Multi-hit prefixes: ${stats.multiHitPrefixes})`
  //     );

  // }

  // Return dummy data for now until we implement the actual validation logic
  return {
    isValid: isValid,
    fastqFile: {
      id: "", // assigned properly later
      kind: "FASTQ_FILE",
      format:
        filename.endsWith(".gz") || filename.endsWith(".bgz") || filename.endsWith(".bgzip")
          ? "FASTQ.GZ"
          : "FASTQ",
      validity: isValid ? "VALID" : "INVALID",
      invalidReason: invalidReason,
      stats: {
        firstHeader: reads.length > 0 ? reads[0].header : "",
        readLength: avgReadLength,
        readQuality: avgReadQuality,
        inferredRead: inferredRead,
      },
      platform: platform,
      input: {
        source: "FILE",
        file: new File([], ""),
        size: 0, // size is compulsory
      },
      info: {
        stdDevReadLength: stdDevReadLength,
      },
    } as FastqFile,
  };
}

export type FastqRead = {
  header: string;
  sequence: string;
  quality: string;
};

export function classifyFastqBasedOnHeader(header: string): "R1" | "R2" | "UNKNOWN" {
  if (!header.startsWith("@")) return "UNKNOWN";

  // CASAVA ≥1.8
  const parts = header.slice(1).split(/\s+/);
  if (parts.length >= 2) {
    const read = parts[1].split(":", 1)[0];
    if (read === "1") return "R1";
    if (read === "2") return "R2";
  }

  // Pre-1.8 Illumina
  if (header.endsWith("/1")) return "R1";
  if (header.endsWith("/2")) return "R2";

  // Unknown or single-end
  return "UNKNOWN";
}

function entropy({ A, C, G, T }: Record<string, number>, total: number): number {
  let H = 0;
  for (const count of [A, C, G, T]) {
    if (count > 0) {
      const p = count / total;
      H -= p * Math.log2(p);
    }
  }
  return H;
}

export function collisionRateAnalysis(reads: FastqRead[], prefixLength: number) {
  const prefixCounts = new Map<string, number>();
  let usableReads = 0;

  for (const read of reads) {
    if (read.sequence.length < prefixLength) continue;

    const prefix = read.sequence.slice(0, prefixLength).toUpperCase();

    prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    usableReads++;
  }

  let singletonPrefixes = 0;
  let multiHitPrefixes = 0;
  let readsInCollisions = 0;

  for (const count of prefixCounts.values()) {
    if (count === 1) {
      singletonPrefixes++;
    } else {
      multiHitPrefixes++;
      readsInCollisions += count;
    }
  }

  return {
    prefixLength,
    totalReads: usableReads,
    uniquePrefixes: prefixCounts.size,
    singletonPrefixes,
    multiHitPrefixes,
    readsInCollisions,
    collisionRate: usableReads > 0 ? readsInCollisions / usableReads : 0,
  };
}
