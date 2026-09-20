/**
 * Region-level ECC: slice a byte region into RS blocks and collect the parity
 * into one contiguous trailer.
 *
 * Keeping parity out-of-line means the data section stays byte-contiguous, so
 * a container can still be read by ignoring the parity entirely.
 */

import { rsEncode, rsDecodeBlock, RsUncorrectableError } from './rs';

/** Data bytes per RS block. 243 + 12 parity = RS(255,243), 4.94% overhead. */
export const RS_K = 243;
/** Parity bytes per RS block. Corrects floor(12/2) = 6 bad bytes per block. */
export const RS_NSYM = 12;

export const rsBlockCount = (dataLen: number, k = RS_K): number =>
  Math.ceil(dataLen / k);

export const eccParityLen = (dataLen: number, k = RS_K, nsym = RS_NSYM): number =>
  rsBlockCount(dataLen, k) * nsym;

/** Parity trailer for `data`. */
export function eccEncode(
  data: Uint8Array,
  out: Uint8Array,
  k = RS_K,
  nsym = RS_NSYM,
): void {
  const blocks = rsBlockCount(data.length, k);
  for (let i = 0; i < blocks; i++) {
    const start = i * k;
    const block = data.subarray(start, Math.min(start + k, data.length));
    out.set(rsEncode(block, nsym), i * nsym);
  }
}

export interface EccRepairResult {
  /** Bytes corrected across all blocks. */
  corrected: number;
  /** Blocks that were past the correction radius. */
  failedBlocks: number[];
}

/**
 * Verify `data` against `parity`, repairing in place where possible.
 *
 * Blocks beyond the correction radius are reported rather than thrown on, so
 * a caller can decide whether a partially-recovered file is still useful.
 */
export function eccRepair(
  data: Uint8Array,
  parity: Uint8Array,
  k = RS_K,
  nsym = RS_NSYM,
): EccRepairResult {
  const blocks = rsBlockCount(data.length, k);
  const scratch = new Uint8Array(k + nsym);
  let corrected = 0;
  const failedBlocks: number[] = [];

  for (let i = 0; i < blocks; i++) {
    const start = i * k;
    const end = Math.min(start + k, data.length);
    const dLen = end - start;
    const block = scratch.subarray(0, dLen + nsym);

    block.set(data.subarray(start, end), 0);
    block.set(parity.subarray(i * nsym, i * nsym + nsym), dLen);

    try {
      const n = rsDecodeBlock(block, nsym);
      if (n > 0) {
        corrected += n;
        data.set(block.subarray(0, dLen), start);
      }
    } catch (e) {
      if (e instanceof RsUncorrectableError) failedBlocks.push(i);
      else throw e;
    }
  }

  return { corrected, failedBlocks };
}
