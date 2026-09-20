/**
 * Allocation accountant for the pack/unpack engine.
 *
 * config.json sets a ceiling on what the *engine* may hold at once, not what
 * the whole app uses, so it is meant to be set conservatively. Every large
 * buffer the engine allocates is reserved here first, which turns the ceiling
 * into something enforced rather than advisory.
 *
 * Note this bounds the engine's own working set. File bytes parked in a Blob
 * live in the browser's blob store (usually disk-backed), not the JS heap, and
 * are deliberately outside the budget.
 */

export class MemoryBudgetError extends Error {
  readonly requested: number;
  readonly inUse: number;
  readonly ceiling: number;

  constructor(requested: number, inUse: number, ceiling: number) {
    super(
      `engine memory ceiling exceeded: needed ${requested} B with ${inUse} B ` +
      `already held, ceiling is ${ceiling} B. Raise engine.maxMemoryBytes in ` +
      `config.json or use a smaller chunk size.`,
    );
    this.name = 'MemoryBudgetError';
    this.requested = requested;
    this.inUse = inUse;
    this.ceiling = ceiling;
  }
}

export class MemoryBudget {
  readonly ceiling: number;
  private inUse = 0;
  private peak = 0;

  constructor(ceiling: number) {
    if (!Number.isFinite(ceiling) || ceiling <= 0) {
      throw new RangeError('MemoryBudget: ceiling must be a positive number');
    }
    this.ceiling = ceiling;
  }

  /** Reserve `bytes`, returning a release function. Throws past the ceiling. */
  reserve(bytes: number): () => void {
    if (this.inUse + bytes > this.ceiling) {
      throw new MemoryBudgetError(bytes, this.inUse, this.ceiling);
    }
    this.inUse += bytes;
    if (this.inUse > this.peak) this.peak = this.inUse;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inUse -= bytes;
    };
  }

  /** Allocate a budgeted Uint8Array; release it when done with it. */
  alloc(bytes: number): { buf: Uint8Array; release: () => void } {
    const release = this.reserve(bytes);
    try {
      return { buf: new Uint8Array(bytes), release };
    } catch (e) {
      release();
      throw e;
    }
  }

  /** Would a reservation of this size fit right now? */
  fits(bytes: number): boolean {
    return this.inUse + bytes <= this.ceiling;
  }

  get used(): number { return this.inUse; }
  get peakUsed(): number { return this.peak; }
  get available(): number { return this.ceiling - this.inUse; }
}
