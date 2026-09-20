/**
 * Chunked .obfus container.
 *
 * Layout
 * ------
 *   container header   32 B, plaintext, CRC-protected, ECC-protected
 *   [header parity]    RS_NSYM B, present when ECC is on
 *   chunk record  x N
 *
 * Chunk record
 * ------------
 *   record header      8 B   u32le storedLen, u32le crc32(blob)
 *   blob               storedLen B   = obfus pack(chunk plaintext)
 *   [parity]           RS parity over (record header || blob)
 *
 * Each chunk is packed independently with its own random 4-bit seed, so one
 * damaged chunk cannot take out the rest of the file.
 *
 * Interop
 * -------
 * A file that needs neither chunking nor ECC is written as a bare upstream
 * blob with no container at all, so it stays byte-compatible with obfus.py.
 * Readers detect the container by its magic and fall back to a bare blob.
 */

import { pack, unpack, MAGIC_LEN, looksLikeObfus } from './obfus';
import { crc32 } from './crc32';
import { eccEncode, eccRepair, eccParityLen, RS_K, RS_NSYM } from './ecc';
import type { MemoryBudget } from './budget';

export const CONTAINER_MAGIC = new Uint8Array([0x4f, 0x42, 0x46, 0x53, 0x43, 0x54, 0x52, 0x31]); // OBFSCTR1
export const HEADER_LEN = 32;
export const RECORD_HEADER_LEN = 8;
export const CONTAINER_VERSION = 1;
export const FLAG_ECC = 1 << 0;

export interface ContainerHeader {
  version: number;
  ecc: boolean;
  rsK: number;
  rsNsym: number;
  chunkSize: number;
  chunkCount: number;
  originalSize: number;
}

function writeHeader(h: ContainerHeader): Uint8Array {
  const buf = new Uint8Array(HEADER_LEN);
  const dv = new DataView(buf.buffer);
  buf.set(CONTAINER_MAGIC, 0);
  dv.setUint8(8, h.version);
  dv.setUint8(9, h.ecc ? FLAG_ECC : 0);
  dv.setUint16(10, h.ecc ? h.rsNsym : 0, true);
  dv.setUint16(12, h.ecc ? h.rsK : 0, true);
  dv.setUint32(14, h.chunkSize, true);
  dv.setUint32(18, h.chunkCount, true);
  dv.setBigUint64(22, BigInt(h.originalSize), true);
  // bytes 30..31 reserved (zero), then CRC is stored in the record stream
  dv.setUint16(30, 0, true);
  return buf;
}

/**
 * Parity bytes guarding the container header.
 *
 * Deliberately a format constant rather than `h.rsK`/`h.rsNsym`: the header
 * carries those fields, so trusting them to decode the header itself is
 * circular — a corrupted `rsK` would pick the wrong code and the repair would
 * fail exactly when it is needed.
 */
export const HEADER_PARITY_LEN = eccParityLen(HEADER_LEN);

/**
 * Repair a header against its parity and return it only if the magic then
 * matches. Returns null when the bytes are not a recoverable header.
 *
 * A false positive needs random bytes to correct into the 6-byte magic, which
 * is about 1 in 2^48.
 */
export function repairHeader(
  head: Uint8Array,
  parity: Uint8Array,
): { header: Uint8Array; corrected: number } | null {
  if (head.length < HEADER_LEN || parity.length < HEADER_PARITY_LEN) return null;
  const copy = new Uint8Array(head.subarray(0, HEADER_LEN));
  let corrected: number;
  try {
    corrected = eccRepair(copy, parity.subarray(0, HEADER_PARITY_LEN)).corrected;
  } catch {
    return null;
  }
  return isContainer(copy) ? { header: copy, corrected } : null;
}

export function isContainer(head: Uint8Array): boolean {
  if (head.length < HEADER_LEN) return false;
  for (let i = 0; i < CONTAINER_MAGIC.length; i++) {
    if (head[i] !== CONTAINER_MAGIC[i]) return false;
  }
  return true;
}

function readHeader(buf: Uint8Array): ContainerHeader {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const version = dv.getUint8(8);
  if (version !== CONTAINER_VERSION) {
    throw new Error(`unsupported container version ${version}`);
  }
  const flags = dv.getUint8(9);
  const ecc = (flags & FLAG_ECC) !== 0;
  return {
    version,
    ecc,
    rsNsym: ecc ? dv.getUint16(10, true) : 0,
    rsK: ecc ? dv.getUint16(12, true) : 0,
    chunkSize: dv.getUint32(14, true),
    chunkCount: dv.getUint32(18, true),
    originalSize: Number(dv.getBigUint64(22, true)),
  };
}

/** A random-access byte source (a File, or a Uint8Array in tests). */
export interface ByteSource {
  readonly size: number;
  slice(start: number, end: number): Promise<Uint8Array>;
}

export function bytesSource(data: Uint8Array): ByteSource {
  return {
    size: data.length,
    async slice(start, end) { return data.subarray(start, end); },
  };
}

export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    async slice(start, end) {
      return new Uint8Array(await blob.slice(start, end).arrayBuffer());
    },
  };
}

export interface ProgressInfo {
  bytesDone: number;
  bytesTotal: number;
  chunkIndex: number;
  chunkCount: number;
}

/**
 * Where output bytes go. Results are streamed rather than returned so the
 * engine never holds the whole output, which is what makes the memory ceiling
 * meaningful on large files.
 */
export interface PartSink {
  write(part: Uint8Array): void | Promise<void>;
}

/** Collects parts in memory. For tests and small payloads only. */
export function arraySink(): PartSink & { parts: Uint8Array[] } {
  const parts: Uint8Array[] = [];
  return { parts, write(p) { parts.push(p); } };
}

export interface PackOptions {
  chunkSize: number;
  ecc: boolean;
  budget: MemoryBudget;
  sink: PartSink;
  onProgress?: (p: ProgressInfo) => void;
  signal?: AbortSignal;
}

export interface PackResult {
  bytesOut: number;
  chunkCount: number;
  container: boolean;
}

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
};

/** Pack a source into .obfus bytes, chunk by chunk, within the budget. */
export async function packSource(
  src: ByteSource,
  opts: PackOptions,
): Promise<PackResult> {
  const { chunkSize, ecc, budget, sink, onProgress, signal } = opts;
  const total = src.size;
  const chunkCount = Math.max(1, Math.ceil(total / chunkSize));

  // A small file with no ECC gets written as a bare upstream blob, keeping it
  // readable by obfus.py.
  const useContainer = ecc || chunkCount > 1;

  let bytesOut = 0;
  const emit = async (b: Uint8Array) => { await sink.write(b); bytesOut += b.length; };

  if (!useContainer) {
    throwIfAborted(signal);
    const { release } = budget.alloc(total + MAGIC_LEN);
    try {
      const plain = await src.slice(0, total);
      await emit(pack(plain));
    } finally { release(); }
    onProgress?.({ bytesDone: total, bytesTotal: total, chunkIndex: 1, chunkCount: 1 });
    return { bytesOut, chunkCount: 1, container: false };
  }

  const header = writeHeader({
    version: CONTAINER_VERSION,
    ecc,
    rsK: RS_K,
    rsNsym: RS_NSYM,
    chunkSize,
    chunkCount,
    originalSize: total,
  });
  await emit(header);
  if (ecc) {
    const hp = new Uint8Array(HEADER_PARITY_LEN);
    eccEncode(header, hp);
    await emit(hp);
  }

  for (let i = 0; i < chunkCount; i++) {
    throwIfAborted(signal);

    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, total);
    const plainLen = end - start;
    const storedLen = plainLen + MAGIC_LEN;
    const dataLen = RECORD_HEADER_LEN + storedLen;
    const parityLen = ecc ? eccParityLen(dataLen) : 0;

    // plaintext slice + packed blob + keystream, plus the record and parity.
    const { release } = budget.alloc(plainLen * 2 + storedLen * 2 + parityLen);
    try {
      const plain = await src.slice(start, end);
      const blob = pack(plain);

      const record = new Uint8Array(dataLen);
      new DataView(record.buffer).setUint32(0, storedLen, true);
      new DataView(record.buffer).setUint32(4, crc32(blob), true);
      record.set(blob, RECORD_HEADER_LEN);
      await emit(record);

      if (ecc) {
        const parity = new Uint8Array(parityLen);
        eccEncode(record, parity);
        await emit(parity);
      }
    } finally { release(); }

    onProgress?.({ bytesDone: end, bytesTotal: total, chunkIndex: i + 1, chunkCount });
  }

  return { bytesOut, chunkCount, container: true };
}

export interface UnpackOptions {
  budget: MemoryBudget;
  sink: PartSink;
  onProgress?: (p: ProgressInfo) => void;
  signal?: AbortSignal;
}

export interface UnpackResult {
  bytesOut: number;
  chunkCount: number;
  container: boolean;
  /** Bytes repaired by ECC across the file. */
  repaired: number;
  /** Chunks that failed integrity checks and could not be repaired. */
  damagedChunks: number[];
}

/** Unpack .obfus bytes back to the original, chunk by chunk. */
export async function unpackSource(
  src: ByteSource,
  opts: UnpackOptions,
): Promise<UnpackResult> {
  const { budget, sink, onProgress, signal } = opts;
  const total = src.size;

  const probe = await src.slice(0, Math.min(HEADER_LEN + HEADER_PARITY_LEN, total));
  const head = probe.subarray(0, Math.min(HEADER_LEN, probe.length));

  // Exact magic first, then a bare upstream blob, and only then a header that
  // needs its own parity to be readable. That order keeps a genuine bare blob
  // from ever being mistaken for a damaged container.
  let header: Uint8Array | null = isContainer(head) ? head : null;
  let headerCorrected = 0;
  if (!header && !(head.length >= MAGIC_LEN && looksLikeObfus(head))) {
    const fixed = repairHeader(head, probe.subarray(HEADER_LEN));
    if (fixed) {
      header = fixed.header;
      headerCorrected = fixed.corrected;
    }
  }

  if (!header) {
    // Bare upstream blob.
    throwIfAborted(signal);
    const { release } = budget.alloc(total * 2);
    try {
      const blob = await src.slice(0, total);
      const out = new Uint8Array(unpack(blob));
      await sink.write(out);
      onProgress?.({ bytesDone: total, bytesTotal: total, chunkIndex: 1, chunkCount: 1 });
      return {
        bytesOut: out.length, chunkCount: 1,
        container: false, repaired: 0, damagedChunks: [],
      };
    } finally { release(); }
  }

  const h = readHeader(header);
  let off = HEADER_LEN + (h.ecc ? HEADER_PARITY_LEN : 0);

  let bytesOut = 0;
  let repaired = headerCorrected;
  const damagedChunks: number[] = [];

  for (let i = 0; i < h.chunkCount; i++) {
    throwIfAborted(signal);

    const rh = await src.slice(off, off + RECORD_HEADER_LEN);
    const rdv = new DataView(rh.buffer, rh.byteOffset, rh.byteLength);
    let storedLen = rdv.getUint32(0, true);

    // Guard against a corrupted length driving a wild allocation: every chunk
    // but the last is exactly chunkSize + MAGIC_LEN.
    const expected = Math.min(h.chunkSize, h.originalSize - i * h.chunkSize) + MAGIC_LEN;
    if (storedLen !== expected) storedLen = expected;

    const dataLen = RECORD_HEADER_LEN + storedLen;
    const parityLen = h.ecc ? eccParityLen(dataLen, h.rsK, h.rsNsym) : 0;

    const { release } = budget.alloc(dataLen + parityLen + storedLen * 2);
    try {
      const record = new Uint8Array(await src.slice(off, off + dataLen));

      if (h.ecc) {
        const parity = await src.slice(off + dataLen, off + dataLen + parityLen);
        const res = eccRepair(record, parity, h.rsK, h.rsNsym);
        repaired += res.corrected;
      }

      // The CRC is not redundant with the ECC above it. Past its correction
      // radius a bounded-distance decoder can settle on a different valid
      // codeword — syndromes zero, data wrong — and no amount of RS can see
      // that. This check is the only thing standing between that case and a
      // silently corrupt output file.
      const blob = record.subarray(RECORD_HEADER_LEN);
      const wantCrc = new DataView(record.buffer).getUint32(4, true);
      const gotCrc = crc32(blob);

      if (gotCrc !== wantCrc || !looksLikeObfus(blob)) {
        damagedChunks.push(i);
        // Emit zeroes so downstream offsets stay right and the user gets a
        // file with a hole rather than a truncated one.
        await sink.write(new Uint8Array(storedLen - MAGIC_LEN));
        bytesOut += storedLen - MAGIC_LEN;
      } else {
        const plain = new Uint8Array(unpack(blob));
        await sink.write(plain);
        bytesOut += plain.length;
      }

      off += dataLen + parityLen;
    } finally { release(); }

    onProgress?.({
      bytesDone: Math.min(off, total), bytesTotal: total,
      chunkIndex: i + 1, chunkCount: h.chunkCount,
    });
  }

  return {
    bytesOut, chunkCount: h.chunkCount,
    container: true, repaired, damagedChunks,
  };
}

/**
 * Exact size `packSource` will produce, without doing the work.
 *
 * Used to decide whether ECC fits inside the configured overhead budget: the
 * RS rate is a flat 4.94%, but the container's fixed header cannot amortise on
 * a very small file, so the true overhead is only known per file.
 */
export function projectPackedSize(
  size: number,
  chunkSize: number,
  ecc: boolean,
): number {
  const chunkCount = Math.max(1, Math.ceil(size / chunkSize));
  if (!ecc && chunkCount === 1) return size + MAGIC_LEN;

  let total = HEADER_LEN + (ecc ? eccParityLen(HEADER_LEN) : 0);
  for (let i = 0; i < chunkCount; i++) {
    const plainLen = Math.min(chunkSize, size - i * chunkSize);
    const dataLen = RECORD_HEADER_LEN + plainLen + MAGIC_LEN;
    total += dataLen + (ecc ? eccParityLen(dataLen) : 0);
  }
  return total;
}

/** Fractional growth `packSource` will cause. Infinity for an empty input. */
export function projectOverhead(size: number, chunkSize: number, ecc: boolean): number {
  if (size <= 0) return Infinity;
  return (projectPackedSize(size, chunkSize, ecc) - size) / size;
}
