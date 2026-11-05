import { type IdatFile } from '../biotypes'
import { AsyncGunzip } from "fflate";


export async function ungzipArrayBufferToUint8Array(
  buffer: ArrayBuffer,
): Promise<Uint8Array> {
  const gunzip = new AsyncGunzip();
  const chunks: Uint8Array[] = [];

  const input = new Uint8Array(buffer);

  await new Promise<void>((resolve) => {
    gunzip.ondata = (err, data, final) => {
      if (!err && data?.length) {
        chunks.push(data);
      }

      if (err || final) {
        resolve();
      }
    };

    gunzip.push(input, true);
  });

  // ---- Concatenate all output chunks ----
  let totalLength = 0;
  for (const chunk of chunks) totalLength += chunk.length;

  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

// Main function
export default async function validateIdatFromArrayBuffer(
  arrayBuffer: ArrayBuffer,
  filename: string,
): Promise<{ isValid: boolean; idatFile: IdatFile }> {
  // For now we will just return a placeholder IdatFile, but here is where the actual validation logic would go.
  let data: Uint8Array | undefined;
  if (filename.endsWith(".gz")) {
    // If it's gzipped, we need to ungzip it first before we can validate it as an IDAT file
    data = await ungzipArrayBufferToUint8Array(arrayBuffer);
  } else {
    data = new Uint8Array(arrayBuffer);
  }
  const results = readIdatPrefixBestEffort(data);

  // Validity
  let isValid = true;
  let invalidReason: string = "";

  if (!results.headerComplete) {
    isValid = false;
    invalidReason += "Incomplete header. ";
  }

  if (results.fileMagic !== "IDAT") {
    isValid = false;
    invalidReason += "File magic does not match IDAT. ";
  }

  if (results.version !== 3) {
    isValid = false;
    invalidReason += "Unsupported IDAT version: " + results.version + ". ";
  }

  return {
    isValid: isValid,

    idatFile: {
      id: "", // assigned properly later
      kind: "IDAT",
      format: filename.toLowerCase().endsWith(".gz") ? "IDAT_GZ" : "IDAT",
      color: filename.toLowerCase().includes("red")
        ? "RED"
        : filename.toLowerCase().includes("green")
          ? "GREEN"
          : "UNKNOWN", //
      validity: isValid ? "VALID" : "INVALID",
      invalidReason: isValid ? undefined : invalidReason,

      info: {
        fileMagic: results.fileMagic,
        version: results.version,
        nFields: results.nFields,
        headerComplete: results.headerComplete,
        directoryComplete: results.directoryComplete,
        bytesAvailable: results.bytesAvailable,
        bytesConsumedByDirectory: results.bytesConsumedByDirectory,
        nSNPsRead: results.nSNPsRead,
        barcode: results.barcode,
        chipType: results.chipType,
        redGreen: results.redGreen,
        stopReason: results.stopReason as string,
      },
      input: {
        source: "FILE",
        file: new File([], filename), // create a File object from the blob for consistency with the rest of the system
        size: 0,
      },
    } as IdatFile,
  };
}

/* ============================================================================
   Utility functions Binary idat reading
   ============================================================================ */
// ======================================================
// Types
// ======================================================

export type IdatKnownFieldName =
  | "nSNPsRead"
  | "IlluminaID"
  | "SD"
  | "Mean"
  | "NBeads"
  | "MidBlock"
  | "RunInfo"
  | "RedGreen"
  | "MostlyNull"
  | "Barcode"
  | "ChipType"
  | "MostlyA"
  | "Unknown_1"
  | "Unknown_2"
  | "Unknown_3"
  | "Unknown_4"
  | "Unknown_5"
  | "Unknown_6"
  | "Unknown_7"
  | `newField.${number}`;

export interface PrefixDirectoryEntry {
  code: number;
  name: IdatKnownFieldName;
  offset: number;
  nextOffset: number;
  availableBytes: number;
  startedInSlice: boolean;
}

export interface PrefixRunInfoRow {
  RunTime?: string;
  BlockType?: string;
  BlockPars?: string;
  BlockCode?: string;
  CodeVersion?: string;
  complete: boolean;
}

export type PrefixDecodedField =
  | {
      kind: "int32";
      complete: boolean;
      value?: number;
    }
  | {
      kind: "string";
      complete: boolean;
      value?: string;
      expectedLength?: number;
    }
  | {
      kind: "int32Array";
      complete: boolean;
      totalExpected?: number;
      values: Int32Array;
    }
  | {
      kind: "uint16Array";
      complete: boolean;
      totalExpected?: number;
      values: Uint16Array;
    }
  | {
      kind: "uint8Array";
      complete: boolean;
      totalExpected?: number;
      values: Uint8Array;
    }
  | {
      kind: "runInfo";
      complete: boolean;
      totalExpectedRows?: number;
      rows: PrefixRunInfoRow[];
    }
  | {
      kind: "raw";
      complete: boolean;
      bytes: Uint8Array;
    }
  | {
      kind: "not_started";
      complete: false;
    };

export interface IdatPrefixParseResult {
  fileMagic?: string;
  version?: number;
  nFields?: number;

  headerComplete: boolean;
  directoryComplete: boolean;

  bytesAvailable: number;
  bytesConsumedByDirectory: number;

  directory: PrefixDirectoryEntry[];
  fields: Partial<Record<IdatKnownFieldName, PrefixDecodedField>>;

  nSNPsRead?: number;
  barcode?: string;
  chipType?: string;
  redGreen?: number;

  quants?: {
    illuminaId?: Int32Array;
    mean?: Uint16Array;
    sd?: Uint16Array;
    nBeads?: Uint8Array;
    expectedCount?: number;
  };

  stopReason:
    | "ok"
    | "not_idat"
    | "need_more_for_header"
    | "need_more_for_directory"
    | "truncated_in_field";
}

// ======================================================
// Constants
// ======================================================

const KNOWN_CODES: Record<string, number> = {
  nSNPsRead: 1000,
  IlluminaID: 102,
  SD: 103,
  Mean: 104,
  NBeads: 107,
  MidBlock: 200,
  RunInfo: 300,
  RedGreen: 400,
  MostlyNull: 401,
  Barcode: 402,
  ChipType: 403,
  MostlyA: 404,
  Unknown_1: 405,
  Unknown_2: 406,
  Unknown_3: 407,
  Unknown_4: 408,
  Unknown_5: 409,
  Unknown_6: 410,
  Unknown_7: 510,
};

const CODE_TO_NAME = new Map<number, IdatKnownFieldName>(
  Object.entries(KNOWN_CODES).map(([name, code]) => [code, name as IdatKnownFieldName]),
);

// ======================================================
// Cursor
// ======================================================

class PrefixCursor {
  public pos = 0;
  public readonly bytes: Uint8Array;
  private readonly view: DataView;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  remaining(): number {
    return this.bytes.byteLength - this.pos;
  }

  canRead(n: number): boolean {
    return this.pos + n <= this.bytes.byteLength;
  }

  readUint8(): number {
    if (!this.canRead(1)) throw new RangeError("EOF");
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  readUint16LE(): number {
    if (!this.canRead(2)) throw new RangeError("EOF");
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  readInt32LE(): number {
    if (!this.canRead(4)) throw new RangeError("EOF");
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readBigInt64LE(): bigint {
    if (!this.canRead(8)) throw new RangeError("EOF");
    const v = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    return v;
  }

  readBytes(n: number): Uint8Array {
    if (!this.canRead(n)) throw new RangeError("EOF");
    const out = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /**
   * Best-effort read of illuminaio varlen string:
   * returns partial metadata if content is truncated.
   */
  tryReadVarString(): {
    complete: boolean;
    value?: string;
    expectedLength?: number;
  } {
    let n = 0;
    let shift = 0;
    const startPos = this.pos;

    try {
      while (true) {
        const m = this.readUint8();
        n += (m & 0x7f) << shift;
        if ((m & 0x80) === 0) break;
        shift += 7;
      }
    } catch {
      // Could not finish reading the length prefix
      this.pos = startPos;
      return { complete: false };
    }

    if (!this.canRead(n)) {
      const available = Math.max(0, this.remaining());
      const partial = this.bytes.subarray(this.pos, this.pos + available);
      const value = new TextDecoder("utf-8").decode(partial);
      this.pos = this.bytes.byteLength;
      return { complete: false, value, expectedLength: n };
    }

    const value = new TextDecoder("utf-8").decode(this.readBytes(n));
    return { complete: true, value, expectedLength: n };
  }
}

// ======================================================
// Helpers
// ======================================================

function ascii4(bytes: Uint8Array): string {
  return String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
}

function safeSubarray(bytes: Uint8Array, start: number, end: number): Uint8Array {
  const s = Math.max(0, Math.min(start, bytes.length));
  const e = Math.max(s, Math.min(end, bytes.length));
  return bytes.subarray(s, e);
}

// ======================================================
// Main prefix parser
// ======================================================

export function readIdatPrefixBestEffort(data: Uint8Array): IdatPrefixParseResult {
  const result: IdatPrefixParseResult = {
    headerComplete: false,
    directoryComplete: false,
    bytesAvailable: data.length,
    bytesConsumedByDirectory: 0,
    directory: [],
    fields: {},
    stopReason: "ok",
  };

  // ------------------------------
  // 1) Header
  // ------------------------------
  if (data.length < 4) {
    result.stopReason = "need_more_for_header";
    return result;
  }

  result.fileMagic = ascii4(data.subarray(0, 4));
  if (result.fileMagic !== "IDAT") {
    result.stopReason = "not_idat";
    return result;
  }

  if (data.length < 16) {
    result.stopReason = "need_more_for_header";
    return result;
  }

  try {
    const header = new PrefixCursor(data.subarray(4, 16));
    result.version = Number(header.readBigInt64LE());
    result.nFields = header.readInt32LE();
    result.headerComplete = true;
  } catch {
    result.stopReason = "need_more_for_header";
    return result;
  }

  if (!result.nFields || result.nFields <= 0) {
    result.stopReason = "need_more_for_directory";
    return result;
  }

  // ------------------------------
  // 2) Directory (partial-safe)
  // ------------------------------
  const dirStart = 16;
  const dirEntryBytes = 10; // uint16 code + int64 offset
  const maxEntriesAvailable = Math.floor((data.length - dirStart) / dirEntryBytes);
  const entriesToRead = Math.min(result.nFields, Math.max(0, maxEntriesAvailable));

  const tempEntries: Array<{ code: number; name: IdatKnownFieldName; offset: number }> = [];

  if (entriesToRead > 0) {
    const dirBytes = data.subarray(dirStart, dirStart + entriesToRead * dirEntryBytes);
    const c = new PrefixCursor(dirBytes);

    let newFieldCounter = 1;

    for (let i = 0; i < entriesToRead; i++) {
      try {
        const code = c.readUint16LE();
        const offset = Number(c.readBigInt64LE());
        const name =
          CODE_TO_NAME.get(code) ?? (`newField.${newFieldCounter++}` as IdatKnownFieldName);
        tempEntries.push({ code, name, offset });
      } catch {
        break;
      }
    }
  }

  result.bytesConsumedByDirectory = dirStart + tempEntries.length * dirEntryBytes;
  result.directoryComplete = tempEntries.length === result.nFields;

  if (tempEntries.length === 0) {
    result.stopReason = "need_more_for_directory";
    return result;
  }

  tempEntries.sort((a, b) => a.offset - b.offset);

  result.directory = tempEntries.map((entry, i) => {
    const nextOffset =
      i + 1 < tempEntries.length ? tempEntries[i + 1].offset : Number.POSITIVE_INFINITY;

    const availableEnd = Math.min(nextOffset, data.length);
    const availableBytes = Math.max(0, availableEnd - entry.offset);
    const startedInSlice = entry.offset < data.length;

    return {
      code: entry.code,
      name: entry.name,
      offset: entry.offset,
      nextOffset,
      availableBytes,
      startedInSlice,
    };
  });

  // ------------------------------
  // 3) nSNPsRead first, if reachable
  // ------------------------------
  const nEntry = result.directory.find((d) => d.name === "nSNPsRead");
  if (nEntry && nEntry.offset + 4 <= data.length) {
    try {
      const c = new PrefixCursor(data.subarray(nEntry.offset, nEntry.offset + 4));
      result.nSNPsRead = c.readInt32LE();
      result.fields.nSNPsRead = {
        kind: "int32",
        complete: true,
        value: result.nSNPsRead,
      };
    } catch {
      result.fields.nSNPsRead = { kind: "int32", complete: false };
    }
  } else if (nEntry) {
    result.fields.nSNPsRead = { kind: "int32", complete: false };
  }

  // ------------------------------
  // 4) Decode as much as possible
  // ------------------------------
  let sawTruncation = false;

  for (const entry of result.directory) {
    if (entry.name === "nSNPsRead") continue;

    if (!entry.startedInSlice) {
      result.fields[entry.name] = { kind: "not_started", complete: false };
      continue;
    }

    const fieldBytes = safeSubarray(data, entry.offset, Math.min(entry.nextOffset, data.length));
    const c = new PrefixCursor(fieldBytes);

    switch (entry.name) {
      case "RedGreen": {
        if (c.canRead(4)) {
          const value = c.readInt32LE();
          result.fields.RedGreen = { kind: "int32", complete: true, value };
          result.redGreen = value;
        } else {
          result.fields.RedGreen = { kind: "int32", complete: false };
          sawTruncation = true;
        }
        break;
      }

      case "Barcode":
      case "ChipType":
      case "MostlyNull":
      case "MostlyA":
      case "Unknown_1":
      case "Unknown_2":
      case "Unknown_3":
      case "Unknown_4":
      case "Unknown_5":
      case "Unknown_6":
      case "Unknown_7": {
        const str = c.tryReadVarString();
        result.fields[entry.name] = { kind: "string", ...str };
        if (!str.complete) sawTruncation = true;

        if (entry.name === "Barcode" && str.value !== undefined) result.barcode = str.value;
        if (entry.name === "ChipType" && str.value !== undefined) result.chipType = str.value;
        break;
      }

      case "IlluminaID": {
        const totalExpected = result.nSNPsRead;
        const nAvailable = Math.floor(fieldBytes.length / 4);
        const nToRead =
          totalExpected !== undefined ? Math.min(totalExpected, nAvailable) : nAvailable;

        const values = new Int32Array(nToRead);
        for (let i = 0; i < nToRead; i++) values[i] = c.readInt32LE();

        const complete = totalExpected !== undefined ? nToRead === totalExpected : false;
        result.fields.IlluminaID = {
          kind: "int32Array",
          complete,
          totalExpected,
          values,
        };
        if (!complete) sawTruncation = true;
        break;
      }

      case "Mean":
      case "SD": {
        const totalExpected = result.nSNPsRead;
        const nAvailable = Math.floor(fieldBytes.length / 2);
        const nToRead =
          totalExpected !== undefined ? Math.min(totalExpected, nAvailable) : nAvailable;

        const values = new Uint16Array(nToRead);
        for (let i = 0; i < nToRead; i++) values[i] = c.readUint16LE();

        const complete = totalExpected !== undefined ? nToRead === totalExpected : false;
        result.fields[entry.name] = {
          kind: "uint16Array",
          complete,
          totalExpected,
          values,
        };
        if (!complete) sawTruncation = true;
        break;
      }

      case "NBeads": {
        const totalExpected = result.nSNPsRead;
        const nAvailable = fieldBytes.length;
        const nToRead =
          totalExpected !== undefined ? Math.min(totalExpected, nAvailable) : nAvailable;

        const values = fieldBytes.subarray(0, nToRead);
        result.fields.NBeads = {
          kind: "uint8Array",
          complete: totalExpected !== undefined ? nToRead === totalExpected : false,
          totalExpected,
          values,
        };
        if (totalExpected === undefined || nToRead !== totalExpected) sawTruncation = true;
        break;
      }

      case "MidBlock": {
        if (!c.canRead(4)) {
          result.fields.MidBlock = {
            kind: "int32Array",
            complete: false,
            values: new Int32Array(0),
          };
          sawTruncation = true;
          break;
        }

        const totalExpected = c.readInt32LE();
        const nAvailable = Math.floor(c.remaining() / 4);
        const nToRead = Math.min(totalExpected, nAvailable);

        const values = new Int32Array(nToRead);
        for (let i = 0; i < nToRead; i++) values[i] = c.readInt32LE();

        const complete = nToRead === totalExpected;
        result.fields.MidBlock = {
          kind: "int32Array",
          complete,
          totalExpected,
          values,
        };
        if (!complete) sawTruncation = true;
        break;
      }

      case "RunInfo": {
        if (!c.canRead(4)) {
          result.fields.RunInfo = {
            kind: "runInfo",
            complete: false,
            rows: [],
          };
          sawTruncation = true;
          break;
        }

        const totalExpectedRows = c.readInt32LE();
        const rows: PrefixRunInfoRow[] = [];
        let complete = true;

        for (let i = 0; i < totalExpectedRows; i++) {
          const row: PrefixRunInfoRow = { complete: true };

          const a = c.tryReadVarString();
          row.RunTime = a.value;
          if (!a.complete) {
            row.complete = false;
            complete = false;
            rows.push(row);
            break;
          }

          const b = c.tryReadVarString();
          row.BlockType = b.value;
          if (!b.complete) {
            row.complete = false;
            complete = false;
            rows.push(row);
            break;
          }

          const d = c.tryReadVarString();
          row.BlockPars = d.value;
          if (!d.complete) {
            row.complete = false;
            complete = false;
            rows.push(row);
            break;
          }

          const e = c.tryReadVarString();
          row.BlockCode = e.value;
          if (!e.complete) {
            row.complete = false;
            complete = false;
            rows.push(row);
            break;
          }

          const f = c.tryReadVarString();
          row.CodeVersion = f.value;
          if (!f.complete) {
            row.complete = false;
            complete = false;
            rows.push(row);
            break;
          }

          rows.push(row);
        }

        result.fields.RunInfo = {
          kind: "runInfo",
          complete,
          totalExpectedRows,
          rows,
        };

        if (!complete) sawTruncation = true;
        break;
      }

      default: {
        // Unknown / new fields: keep raw bytes we have
        result.fields[entry.name] = {
          kind: "raw",
          complete: entry.nextOffset <= data.length,
          bytes: fieldBytes,
        };
        if (entry.nextOffset > data.length) sawTruncation = true;
        break;
      }
    }
  }

  // ------------------------------
  // 5) Convenience quants view
  // ------------------------------
  const illuminaIdField = result.fields.IlluminaID;
  const meanField = result.fields.Mean;
  const sdField = result.fields.SD;
  const nBeadsField = result.fields.NBeads;

  result.quants = {
    illuminaId: illuminaIdField?.kind === "int32Array" ? illuminaIdField.values : undefined,
    mean: meanField?.kind === "uint16Array" ? meanField.values : undefined,
    sd: sdField?.kind === "uint16Array" ? sdField.values : undefined,
    nBeads: nBeadsField?.kind === "uint8Array" ? nBeadsField.values : undefined,
    expectedCount: result.nSNPsRead,
  };

  if (sawTruncation) {
    result.stopReason = "truncated_in_field";
  }

  return result;
}
