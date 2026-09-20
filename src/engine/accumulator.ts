/**
 * Streams output parts into a Blob, flushing periodically so the engine never
 * holds the whole result on the JS heap.
 *
 * Once bytes are inside a Blob the browser owns them (typically spilled to
 * disk past a few megabytes), which is why blob-resident bytes sit outside the
 * memory budget while pending parts sit inside it.
 */

import type { MemoryBudget } from './budget';
import type { PartSink } from './container';

export class BlobAccumulator implements PartSink {
  // Every buffer the engine produces is backed by a real ArrayBuffer, never a
  // SharedArrayBuffer, which is what BlobPart requires.
  private pending: Uint8Array<ArrayBuffer>[] = [];
  private pendingBytes = 0;
  private release: (() => void) | null = null;
  private blob: Blob = new Blob([]);
  private readonly budget: MemoryBudget;
  private readonly threshold: number;

  constructor(budget: MemoryBudget, threshold: number) {
    this.budget = budget;
    this.threshold = threshold;
  }

  write(part: Uint8Array): void {
    // Pending parts are live heap, so they are charged to the budget.
    const rel = this.budget.reserve(part.length);
    const prev = this.release;
    this.release = () => { prev?.(); rel(); };

    this.pending.push(part as Uint8Array<ArrayBuffer>);
    this.pendingBytes += part.length;

    if (this.pendingBytes >= this.threshold) this.flush();
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    this.blob = new Blob([this.blob, ...this.pending]);
    this.pending = [];
    this.pendingBytes = 0;
    this.release?.();
    this.release = null;
  }

  finish(type = 'application/octet-stream'): Blob {
    this.flush();
    return this.blob.slice(0, this.blob.size, type);
  }
}
