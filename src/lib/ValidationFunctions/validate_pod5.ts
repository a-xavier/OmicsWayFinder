import type { Pod5File } from '../biotypes';
import { tableFromIPC } from "apache-arrow";

export default async function validatePod5(file: File, setProcessing: (value: boolean) => void): Promise<{isValid: boolean, result: Pod5File}> {
   setProcessing(true);
   const result = await validatePod5File(file);
   setProcessing(false);

    return { 
        isValid: result.isValid,
        result: result.pod5File
    };
    
}



// Reference implementation in app/format_inspector/pod5/page.tsx

/* ==================================================================
    All helper functions 
================================================================== */
// ====================== POD5 constants ======================

const POD5_SIG = new Uint8Array([0x8b, 0x50, 0x4f, 0x44, 0x0d, 0x0a, 0x1a, 0x0a]);
const FOOTER_MAGIC = new Uint8Array([0x46, 0x4f, 0x4f, 0x54, 0x45, 0x52, 0x00, 0x00]);

const RUN_INFO_FIELDS = [
  "acquisition_id",
  "acquisition_start_time",
  "adc_max",
  "adc_min",
  "context_tags",
  "experiment_name",
  "flow_cell_id",
  "flow_cell_product_code",
  "protocol_name",
  "protocol_run_id",
  "protocol_start_time",
  "sample_id",
  "sample_rate",
  "sequencing_kit",
  "sequencer_position",
  "sequencer_position_type",
  "software",
  "system_name",
  "system_type",
  "tracking_id",
] as const;

// ====================== Types ======================

type EmbeddedFile = {
  offset: bigint;
  length: bigint;
  format: number;
  contentType: number;
};

type Pod5FooterSummary = {
  sectionMarkerHex: string;
  footer: {
    fileIdentifier: string;
    software: string;
    pod5Version: string;
    embeddedCount: number;
  };
  embedded: EmbeddedFile[];
};

export type RunInfoWanted = {
  experiment_type?: string | null;
  sequencing_kit?: string | null;
  protocol_name?: string | null;
  protocol_run_id?: string | null;
  protocol_start_time?: string | null;
  experiment_name?: string | null;
  flow_cell_id?: string | null;
  flow_cell_product_code?: string | null;
  sample_id?: string | null;
  sample_rate?: number | null;
  software?: string | null;
  system_name?: string | null;
  system_type?: string | null;
  sequencer_position?: string | null;
  sequencer_position_type?: string | null;

  barcoding_enabled?: string | null;
  barcoding_kits?: string | null;
  is_multiplexed_or_barcoded: boolean;

  context_tags: Record<string, string>;
  tracking_id: Record<string, string>;

  acquisition_id?: string | null;
  acquisition_start_time?: string | null;
};

// ====================== Helpers ======================

const hex = (u8: Uint8Array) =>
  Array.from(u8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const bytesEq = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

const dv = (u8: Uint8Array) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
const safeBigintToNumber = (x: bigint) => Number(x);

// ====================== Slice readers ======================

async function readSlice(file: File, start: number, length: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, start + length).arrayBuffer());
}

export async function readSliceFromUrl(
  url: string,
  start: number,
  length: number,
): Promise<Uint8Array> {
  const end = start + length - 1;
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (res.status !== 206) throw new Error("Server does not support HTTP Range requests");
  return new Uint8Array(await res.arrayBuffer());
}

// ====================== Flatbuffer helpers ======================

function fbRootTableOffset(buf: Uint8Array) {
  return dv(buf).getUint32(0, true);
}
function fbVTableOffset(buf: Uint8Array, table: number) {
  return table - dv(buf).getInt32(table, true);
}
function fbFieldOffset(buf: Uint8Array, table: number, field: number) {
  const vt = fbVTableOffset(buf, table);
  const len = dv(buf).getUint16(vt, true);
  const off = vt + 4 + field * 2;
  return off < vt + len ? dv(buf).getUint16(off, true) : 0;
}
function fbGetString(buf: Uint8Array, table: number, field: number) {
  const o = fbFieldOffset(buf, table, field);
  if (!o) return "";
  const p = table + o;
  const s = p + dv(buf).getUint32(p, true);
  const l = dv(buf).getUint32(s, true);
  return new TextDecoder().decode(buf.subarray(s + 4, s + 4 + l));
}
function fbGetVectorOfTables(buf: Uint8Array, table: number, field: number) {
  const o = fbFieldOffset(buf, table, field);
  if (!o) return [];
  const p = table + o;
  const s = p + dv(buf).getUint32(p, true);
  const l = dv(buf).getUint32(s, true);
  return Array.from({ length: l }, (_, i) => {
    const ep = s + 4 + i * 4;
    return ep + dv(buf).getUint32(ep, true);
  });
}
function fbGetI64(buf: Uint8Array, table: number, field: number) {
  const o = fbFieldOffset(buf, table, field);
  return o ? dv(buf).getBigInt64(table + o, true) : BigInt(0);
}
function fbGetI16(buf: Uint8Array, table: number, field: number) {
  const o = fbFieldOffset(buf, table, field);
  return o ? dv(buf).getInt16(table + o, true) : 0;
}

function parsePod5FooterFlatbuffer(buf: Uint8Array) {
  const root = fbRootTableOffset(buf);
  const embedded = fbGetVectorOfTables(buf, root, 3).map((t) => ({
    offset: fbGetI64(buf, t, 0),
    length: fbGetI64(buf, t, 1),
    format: fbGetI16(buf, t, 2),
    contentType: fbGetI16(buf, t, 3),
  }));
  return {
    fileIdentifier: fbGetString(buf, root, 0),
    software: fbGetString(buf, root, 1),
    pod5Version: fbGetString(buf, root, 2),
    embedded,
  };
}

// ====================== Footer parsing ======================

export async function parsePod5ContainerFooterCommon(
  size: number,
  read: (o: number, l: number) => Promise<Uint8Array>,
): Promise<Pod5FooterSummary | undefined> {
  const head = await read(0, 24);
  if (!bytesEq(head.subarray(0, 8), POD5_SIG)) throw new Error("Invalid POD5 header");

  const sectionMarkerHex = hex(head.subarray(8, 24));
  const probeLen = Math.min(64 * 1024, size);
  const tail = await read(size - probeLen, probeLen);

  if (!bytesEq(tail.subarray(tail.length - 8), POD5_SIG)) return undefined; // Not a POD5 file, but header was present - maybe truncated or just a false match?

  const footerLen = dv(tail).getBigInt64(tail.length - 32, true);
  const footerStart = size - safeBigintToNumber(footerLen) - 32;
  const magic = await read(footerStart - 8, 8);
  if (!bytesEq(magic, FOOTER_MAGIC)) throw new Error("Missing FOOTER magic");

  const footerBytes = await read(footerStart, safeBigintToNumber(footerLen));
  const parsed = parsePod5FooterFlatbuffer(footerBytes);

  return {
    sectionMarkerHex,
    footer: {
      fileIdentifier: parsed.fileIdentifier,
      software: parsed.software,
      pod5Version: parsed.pod5Version,
      embeddedCount: parsed.embedded.length,
    },
    embedded: parsed.embedded,
  };
}

async function parsePod5ContainerFooter(file: File) {
  return parsePod5ContainerFooterCommon(file.size, (o, l) => readSlice(file, o, l));
}

export async function parsePod5ContainerFooterFromUrl(url: string) {
  const h = await fetch(url, { method: "HEAD" });
  const size = Number(h.headers.get("Content-Length"));
  if (!size) throw new Error("Missing Content-Length");
  return parsePod5ContainerFooterCommon(size, (o, l) => readSliceFromUrl(url, o, l));
}

// ====================== Run Info extraction ======================

function mapLikeToObject(v: any): Record<string, string> {
  if (!v) return {};
  if (v instanceof Map) return Object.fromEntries(v);
  if (Array.isArray(v)) return Object.fromEntries(v.map((i: any) => [i.key, i.value]));
  return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, String(val)]));
}

function asISO(v: any) {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number") return new Date(v).toISOString();
  return v ? String(v) : null;
}

export async function extractRunInfoCommon(
  read: (o: number, l: number) => Promise<Uint8Array>,
  footer: Pod5FooterSummary,
) {
  let bestTable: any = null;
  let bestScore = -1;
  const decodedTablesDebug: any[] = [];

  for (let i = 0; i < footer.embedded.length; i++) {
    const ef = footer.embedded[i];
    if (ef.length > BigInt(50000000)) continue;

    const bytes = await read(safeBigintToNumber(ef.offset), safeBigintToNumber(ef.length));
    let table;
    try {
      table = tableFromIPC(bytes);
    } catch {
      continue;
    }

    const cols = table.schema.fields.map((f: any) => f.name);
    const score = cols.filter((c: string) => RUN_INFO_FIELDS.includes(c as any)).length;
    decodedTablesDebug.push({ idx: i, cols, score });

    if (score > bestScore) {
      bestScore = score;
      bestTable = table;
    }
  }

  if (!bestTable) throw new Error("Run Info table not found");

  const get = (n: string) => bestTable.getChild?.(n)?.get(0);
  const context_tags = mapLikeToObject(get("context_tags"));
  const tracking_id = mapLikeToObject(get("tracking_id"));

  const runInfo: RunInfoWanted = {
    experiment_type: context_tags["experiment_type"] ?? null,
    sequencing_kit: get("sequencing_kit") ?? null,
    protocol_name: get("protocol_name") ?? null,
    protocol_run_id: get("protocol_run_id") ?? null,
    protocol_start_time: asISO(get("protocol_start_time")),
    experiment_name: get("experiment_name") ?? null,
    flow_cell_id: get("flow_cell_id") ?? null,
    flow_cell_product_code: get("flow_cell_product_code") ?? null,
    sample_id: get("sample_id") ?? null,
    sample_rate: get("sample_rate") ?? null,
    software: get("software") ?? null,
    system_name: get("system_name") ?? null,
    system_type: get("system_type") ?? null,
    sequencer_position: get("sequencer_position") ?? null,
    sequencer_position_type: get("sequencer_position_type") ?? null,
    acquisition_id: get("acquisition_id") ?? null,
    acquisition_start_time: asISO(get("acquisition_start_time")),

    barcoding_enabled: context_tags["barcoding_enabled"] ?? null,
    barcoding_kits: context_tags["barcoding_kits"] ?? null,
    is_multiplexed_or_barcoded:
      context_tags["barcoding_enabled"] === "1" || !!context_tags["barcoding_kits"],

    context_tags,
    tracking_id,
  };

  return { runInfo, decodedTablesDebug };
}

/* ==================================================================
    Main  functions: Validate File and Validate URL
================================================================== */

// Validate POD5 file or URL directly in browser
export async function validatePod5File(
  file: File,
): Promise<{ isValid: boolean; pod5File: Pod5File }> {
  const footer = await parsePod5ContainerFooter(file);

  if (!footer) {
    return {
      isValid: false,
      pod5File: {
        kind: "POD5",
        format: "POD5",
        validity: "INVALID",
        invalidReason: "Footer not found or invalid - file may be truncated or not a POD5 file",
        id: "",
        multiSample: false,
        input: {
          source: "FILE",
          file: new File([], ""),
          size: 0,
        },
      },
    };
  }

  const res = await extractRunInfoCommon((o, l) => readSlice(file, o, l), footer);
  const runInfo = res.runInfo;
  // TODO: Use the decoded-table debug data or remove this binding.
  const _decodedTablesDebug = res.decodedTablesDebug;
  void _decodedTablesDebug;

  // we need
  // barcoding enabled
  // barcoding kits
  // sequencing kit
  // protocol name
  // protocol run id
  // flow cell id
  // sample rate
  const mandatoryFields: (keyof RunInfoWanted)[] = [
    "barcoding_enabled",
    "sequencing_kit",
    "protocol_name",
    "protocol_run_id",
    "experiment_name",
    "flow_cell_id",
    "sample_rate",
  ];

  const missingFields = mandatoryFields.filter((f) => !runInfo[f]);

  if (missingFields.length > 0) {
    return {
      isValid: false,
      pod5File: {
        kind: "POD5",
        format: "POD5",
        validity: "INVALID",
        invalidReason: `Missing mandatory Run Info fields: ${missingFields.join(", ")}`,
        multiSample: runInfo.barcoding_enabled === "1",
        info: runInfo,
        id: "",
        input: {
          source: "FILE",
          file: new File([], ""),
          size: 0,
        },
      },
    };
  }


  // Final real result
  const pod5File: Pod5File = {
    kind: "POD5",
    format: "POD5",
    validity: "VALID", // if it reaches here it's valid
    info: runInfo,
    multiSample: runInfo.barcoding_enabled === "1",
    id: "",
    input: {
      source: "FILE",
      file: new File([], ""),
      size: 0,
    },
  };

  return { isValid: pod5File.validity === "VALID", pod5File };
}

export async function validatePod5URL(
  url: string,
): Promise<{ isValid: boolean; pod5File: Pod5File }> {
  // Call api
  const response = await fetch("/api/file_validation/pod5_url", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Server error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const { isValid, pod5File } = await response.json();

  return { isValid, pod5File };
}
