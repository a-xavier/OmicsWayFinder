// ============================================================================
// Types repository – final version aligned with your stated goals
// ============================================================================

/* ============================================================================
   Shared primitives
   ========================================================================== */

export type Validity = "VALID" | "INVALID";

/* ============================================================================
   JSON-like metadata
   ========================================================================== */

export type JsonValue = string | number | boolean | null | JsonObject | JsonArray;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonArray = JsonValue[];

export type InfoRecord = JsonObject;

/* ============================================================================
   Transport / input layer
   ========================================================================== */

export type InputSource =
  | {
      source: "FILE";
      file: File;
      size: number;
    }
  | {
      source: "URL";
      file: File; // placeholder for name
      url: string;
      size: number;
    };

/* ============================================================================
   BioFile – atomic, physical file
   ========================================================================== */

export interface BioFileBase<K extends string, F extends string> {
  id: string;
  input: InputSource;
  kind: K;
  format: F;
  validity: Validity;
  invalidReason?: string;
  info?: InfoRecord;
}

/* ============================================================================
   Atomic BioFiles
   ========================================================================== */

export interface AlignmentFile extends BioFileBase<
  "ALIGNMENT",
  "SAM" | "BAM" | "CRAM" | "INVALID"
> {
  isAligned: boolean;
  hasBaseModification: boolean;
  platform?: "ONT" | "PACBIO" | "SHORT_READS" | "UNKNOWN";
  multiSample: boolean; // check from RG if different SM (if only one or non then false)
  stats?: {
    meanReadLength?: number;
    meanReadQuality?: number;
  };
}

export interface FastqFile extends BioFileBase<"FASTQ_FILE", "FASTQ" | "FASTQ.GZ" | "INVALID"> {
  stats?: {
    readLength?: number;
    readQuality?: number;
    inferredRead?: "R1" | "R2" | "UNKNOWN";
    firstHeader: string; // will store the first header line for potential use in grouping into pairs/lanes
  };

  platform?: "SHORT_READS" | "PACBIO" | "ONT" | "UNKNOWN";
}

export interface VariantFile extends BioFileBase<"VARIANT", "VCF" | "VCF.GZ" | "BCF" | "INVALID"> {
  multiSample: boolean; // check from header if multiple samples
}

export interface Pod5File extends BioFileBase<"POD5", "POD5" | "INVALID"> {
  multiSample: boolean; // true if barcoding enabled
}

export interface IdatFile extends BioFileBase<"IDAT", "IDAT" | "INVALID"> {
  color: "RED" | "GREEN";
}

export type BioFile =
  | AlignmentFile
  | FastqFile
  | VariantFile
  | Pod5File
  | IdatFile
  | BioFileBase<"UNKNOWN", "UNKNOWN">;

/* ============================================================================
   Valid payloads (structure-only, no validity, no InputSource)
   ========================================================================== */

export interface AlignmentPayload {
  kind: "ALIGNMENT";
  key: string; // All payload will have a key - It represent the filename or the common part of filenames for groups
  file: AlignmentFile;
}

export interface FastqGroupPayload {
  kind: "FASTQ_GROUP";
  key: string; // common part of filenames for grouping
  layout: "SINGLE" | "PAIRED";
  format: "FASTQ" | "FASTQ.GZ";
  lanes: Array<{
    laneId: string;
    R1: FastqFile;
    R2?: FastqFile;
  }>;
  platform?: "SHORT_READS" | "PACBIO" | "ONT" | "UNKNOWN";
}

export interface IdatGroupPayload {
  kind: "IDAT_GROUP";
  key: string; // common part of filenames for grouping
  red: IdatFile;
  green: IdatFile;
}

export interface VariantPayload {
  kind: "VARIANT";
  key: string;
  file: VariantFile;
}

// Done: Replace Pod5Payload with Pod5GroupPayload
// Rational is minknow create multiple small pod5 files for each run
// MEaning we NEED to analyse those together
// We group them by
// export interface Pod5Payload {
//   kind: "POD5";
//   key: string;
//   file: Pod5File;
// }

// Done: Replace Pod5Payload with Pod5GroupPayload
export interface Pod5GroupPayload {
  kind: "POD5_GROUP";
  key: string; // use protocol_run_id as key maybe add experiment name too?
  experimentName?: string | null;
  multiplexedOrBarcoded: boolean; // to know if need to analyse as one sample or multiple samples to demultiplex
  files: Pod5File[];
}

export type ValidPayload =
  | AlignmentPayload
  | FastqGroupPayload
  | IdatGroupPayload
  | VariantPayload
  | Pod5GroupPayload;

/* ============================================================================
   BioEntity – pipeline input unit
   ========================================================================== */

export interface BioEntity {
  id: string;

  /** Physical files backing this entity */
  biofiles: BioFile[];

  /** Structurally valid payload */
  payload: ValidPayload;

  /** Entity-level validity (derived during resolution) */
  validity: Validity;
  invalidReason?: string;
}

/* ============================================================================
   Pipeline classification (derived)
   ========================================================================== */

export type PipelineClassification =
  | "BAM_ALIGNED_BASEMOD"
  | "BAM_ALIGNED_NO_BASEMOD"
  | "BAM_UNALIGNED_BASEMOD"
  | "BAM_UNALIGNED_NO_BASEMOD"
  | "FASTQ"
  | "VARIANT"
  | "POD5"
  | "IDAT"
  | "INVALID";

/* ============================================================================
   Classification logic
   ========================================================================== */

export function classifyBioEntity(entity: BioEntity): PipelineClassification {
  if (entity.validity === "INVALID") return "INVALID";

  switch (entity.payload.kind) {
    case "ALIGNMENT": {
      const { isAligned, hasBaseModification } = entity.payload.file;
      if (isAligned) {
        return hasBaseModification ? "BAM_ALIGNED_BASEMOD" : "BAM_ALIGNED_NO_BASEMOD";
      }
      return hasBaseModification ? "BAM_UNALIGNED_BASEMOD" : "BAM_UNALIGNED_NO_BASEMOD";
    }

    case "FASTQ_GROUP":
      return "FASTQ";

    case "VARIANT":
      return "VARIANT";

    case "POD5_GROUP":
      return "POD5";

    case "IDAT_GROUP":
      return "IDAT";

    default:
      return "INVALID";
  }
}
