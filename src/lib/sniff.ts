/**
 * Decide what a file actually is, by content rather than by name.
 *
 * Reading the extension alone would miss the two cases the warnings exist for:
 * a .obfus that is really a JPEG, and an obfus blob someone renamed.
 */

import { isContainer, repairHeader, HEADER_LEN, HEADER_PARITY_LEN } from '../engine/container';
import { looksLikeObfus, MAGIC_LEN, EXT } from '../engine/obfus';

export type Detected = 'container' | 'bare' | 'plain';

export interface Sniffed {
  detected: Detected;
  /** True if the name ends in .obfus, regardless of content. */
  namedObfus: boolean;
  /** Name and content disagree. */
  mismatch: boolean;
}

export async function sniff(file: File): Promise<Sniffed> {
  const namedObfus = file.name.toLowerCase().endsWith(EXT);
  const probe = new Uint8Array(
    await file.slice(0, Math.max(HEADER_LEN + HEADER_PARITY_LEN, MAGIC_LEN)).arrayBuffer(),
  );
  const head = probe.subarray(0, Math.max(HEADER_LEN, MAGIC_LEN));

  let detected: Detected = 'plain';
  if (isContainer(head)) detected = 'container';
  // A 6-byte probe across 16 seeds; a false positive is about 1 in 2^44.
  else if (head.length >= MAGIC_LEN && looksLikeObfus(head)) detected = 'bare';
  // A header damaged badly enough to lose its magic is still recoverable from
  // its parity; without this the file would look plain and get re-packed.
  else if (repairHeader(head, probe.subarray(HEADER_LEN))) detected = 'container';

  return {
    detected,
    namedObfus,
    mismatch: namedObfus !== (detected !== 'plain'),
  };
}

export const isObfus = (s: Sniffed): boolean => s.detected !== 'plain';
