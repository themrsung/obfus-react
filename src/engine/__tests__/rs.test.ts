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

  it('reports uncorrectable rather than returning corrupt data', () => {
    let flagged = 0;
    for (let trial = 0; trial < 60; trial++) {
      const { block, data } = codeword(243);
      const positions = new Set<number>();
      while (positions.size < 20) positions.add(Math.floor(Math.random() * block.length));
      for (const p of positions) block[p] ^= (1 + Math.floor(Math.random() * 255));

      try {
        rsDecodeBlock(block, NSYM);
        // Silent success is only acceptable if the data really is intact.
        expect(block.subarray(0, 243)).toEqual(data);
      } catch (e) {
        expect(e).toBeInstanceOf(RsUncorrectableError);
        flagged++;
      }
    }
    expect(flagged).toBeGreaterThan(50);
  });

  it('handles a short final block', () => {
    const { block, data } = codeword(37);
    block[5] ^= 0xaa;
    block[30] ^= 0x11;
    expect(rsDecodeBlock(block, NSYM)).toBe(2);
    expect(block.subarray(0, 37)).toEqual(data);
  });
});
