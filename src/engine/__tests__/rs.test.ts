import { describe, it, expect } from 'vitest';
import { rsEncode, rsDecodeBlock, RsUncorrectableError } from '../rs';

const NSYM = 12; // RS(255,243) -> corrects 6 bytes

function codeword(dataLen: number): { block: Uint8Array; data: Uint8Array } {
  const data = new Uint8Array(dataLen);
  crypto.getRandomValues(data);
  const block = new Uint8Array(dataLen + NSYM);
  block.set(data, 0);
  block.set(rsEncode(data, NSYM), dataLen);
  return { block, data };
}

describe('reed-solomon RS(255,243)', () => {
  it('clean block has zero syndromes', () => {
    const { block } = codeword(243);
    expect(rsDecodeBlock(block, NSYM)).toBe(0);
  });

  it('corrects 1..6 corrupted bytes at random positions', () => {
    for (let nerr = 1; nerr <= 6; nerr++) {
      for (let trial = 0; trial < 40; trial++) {
        const { block, data } = codeword(243);
        const positions = new Set<number>();
        while (positions.size < nerr) positions.add(Math.floor(Math.random() * block.length));
        for (const p of positions) block[p] ^= (1 + Math.floor(Math.random() * 255));

        expect(rsDecodeBlock(block, NSYM)).toBe(nerr);
        expect(block.subarray(0, 243)).toEqual(data);
      }
    }
  });

  it('corrects errors in the parity section too', () => {
    const { block, data } = codeword(243);
    block[250] ^= 0xff;
    block[254] ^= 0x0f;
    rsDecodeBlock(block, NSYM);
    expect(block.subarray(0, 243)).toEqual(data);
  });

  /**
   * Past the correction radius the decoder has three possible fates, and the
   * third one is why the container does not rely on RS alone.
   *
   * RS(255,243) corrects 6 errors. Hand it 20 and it usually detects that it
   * is lost, but it can also land on a *different valid codeword* — syndromes
   * genuinely zero, data genuinely wrong. No bounded-distance decoder can
   * detect that case, which is what the per-chunk CRC-32 in the container is
   * there to catch.
   *
   * Asserted as a tally rather than per-trial: miscorrection is rare (order
   * 0.1% per trial here) but real, so a per-trial assertion would be flaky.
   */
  it('detects or miscorrects beyond the radius, and never half-fixes', () => {
    let flagged = 0;
    let miscorrected = 0;
    let recovered = 0;
    const wrongErrorTypes: unknown[] = [];

    for (let trial = 0; trial < 60; trial++) {
      const { block, data } = codeword(243);
      const positions = new Set<number>();
      while (positions.size < 20) positions.add(Math.floor(Math.random() * block.length));
      for (const p of positions) block[p] ^= (1 + Math.floor(Math.random() * 255));

      // Classify outside the assertion layer: an expect() inside this try
      // would have its AssertionError swallowed by the catch below.
      let thrown: unknown = null;
      try {
        rsDecodeBlock(block, NSYM);
      } catch (e) {
        thrown = e;
      }

      if (thrown !== null) {
        if (!(thrown instanceof RsUncorrectableError)) wrongErrorTypes.push(thrown);
        flagged++;
      } else if (block.subarray(0, 243).every((b, i) => b === data[i])) {
        recovered++;
      } else {
        miscorrected++;
      }
    }

    // Whatever it throws must be the documented error, never a TypeError or
    // a RangeError escaping the field arithmetic.
    expect(wrongErrorTypes).toEqual([]);
    expect(flagged + miscorrected + recovered).toBe(60);
    // Detection is the overwhelmingly common outcome.
    expect(flagged).toBeGreaterThan(40);
  });

  it('handles a short final block', () => {
    const { block, data } = codeword(37);
    block[5] ^= 0xaa;
    block[30] ^= 0x11;
    expect(rsDecodeBlock(block, NSYM)).toBe(2);
    expect(block.subarray(0, 37)).toEqual(data);
  });
});
