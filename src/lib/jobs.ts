/** Job model: what the queue holds and how warnings are derived. */

import type { Sniffed } from './sniff';
import { isObfus } from './sniff';
import { EXT } from '../engine/obfus';
import { projectOverhead } from '../engine/container';

export type Mode = 'auto' | 'pack' | 'unpack';
export type Action = 'pack' | 'unpack';
export type JobStatus = 'blocked' | 'ready' | 'running' | 'done' | 'error' | 'cancelled';

export interface Warning {
  id: string;
  /** `block` needs an explicit confirmation; `note` is informational. */
  level: 'block' | 'note';
  title: string;
  detail: string;
}

export interface Job {
  id: string;
  file: File;
  sniff: Sniffed;
  action: Action;
  status: JobStatus;
  warnings: Warning[];
  acknowledged: boolean;
  progress: number;
  chunkIndex: number;
  chunkCount: number;
  result?: {
    blob: Blob;
    filename: string;
    bytesIn: number;
    bytesOut: number;
    chunkCount: number;
    container: boolean;
    repaired: number;
    damagedChunks: number[];
    peakMemoryBytes: number;
    elapsedMs: number;
  };
  error?: string;
}

/** In auto mode the content decides; otherwise the user's choice wins. */
export function resolveAction(mode: Mode, s: Sniffed): Action {
  if (mode === 'auto') return isObfus(s) ? 'unpack' : 'pack';
  return mode;
}

export interface EccPlan {
  /** Whether ECC will actually be applied to this file. */
  applied: boolean;
  /** Growth this file will see, as a fraction of its original size. */
  overhead: number;
}

/**
 * Decide ECC per file. The configured `maxOverheadRatio` is a hard budget, so a
 * file too small to amortise the container header is packed without redundancy
 * rather than silently blowing past the cap the user set.
 */
export function planEcc(
  file: File,
  action: Action,
  eccWanted: boolean,
  chunkSize: number,
  cap: number,
): EccPlan {
  if (action !== 'pack' || !eccWanted) {
    return { applied: false, overhead: projectOverhead(file.size, chunkSize, false) };
  }
  const withEcc = projectOverhead(file.size, chunkSize, true);
  if (withEcc <= cap) return { applied: true, overhead: withEcc };
  return { applied: false, overhead: projectOverhead(file.size, chunkSize, false) };
}

export function deriveWarnings(
  action: Action,
  s: Sniffed,
  mode: Mode,
  ecc?: { wanted: boolean; plan: EccPlan; cap: number },
): Warning[] {
  const out: Warning[] = [];

  if (ecc && ecc.wanted && !ecc.plan.applied && action === 'pack') {
    out.push({
      id: 'ecc-over-budget',
      level: 'note',
      title: 'Packed without redundancy',
      detail:
        `This file is too small to carry error correction inside the ` +
        `${(ecc.cap * 100).toFixed(0)}% overhead cap in config.json — the fixed ` +
        `container header alone would exceed it. Packed as a plain blob instead. ` +
        `Raise ecc.maxOverheadRatio to force redundancy on small files.`,
    });
  }

  if (action === 'pack' && isObfus(s)) {
    out.push({
      id: 'double-pack',
      level: 'block',
      title: 'This file is already obfuscated',
      detail:
        `Packing it again produces a ${EXT}${EXT} blob that needs two unpack ` +
        `passes to recover. Auto mode would unpack this instead.`,
    });
  }

  if (action === 'unpack' && !isObfus(s)) {
    out.push({
      id: 'unpack-plain',
      level: 'block',
      title: 'This does not look like an obfus file',
      detail: s.namedObfus
        ? `It is named ${EXT} but no key matches its first bytes, so it is not ` +
          `an obfus blob. Unpacking will fail.`
        : 'No obfus magic under any of the 16 keys. Unpacking will fail.',
    });
  }

  // Only worth mentioning when the name would have misled a name-based tool.
  if (s.mismatch && mode === 'auto') {
    out.push({
      id: 'name-mismatch',
      level: 'note',
      title: s.namedObfus ? 'Named .obfus but is not one' : 'Obfus blob without the .obfus name',
      detail: 'Going by content, not by filename.',
    });
  }

  return out;
}

export function outputName(file: File, action: Action): string {
  if (action === 'pack') return file.name + EXT;
  const lower = file.name.toLowerCase();
  if (lower.endsWith(EXT)) return file.name.slice(0, -EXT.length);
  return file.name + '.unpacked';
}

export const isBlocked = (j: Job): boolean =>
  !j.acknowledged && j.warnings.some((w) => w.level === 'block');
