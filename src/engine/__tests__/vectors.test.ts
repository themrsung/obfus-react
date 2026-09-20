/**
 * Upstream conformance vectors.
 *
 * Taken from the README of themrsung/file-obfuscation, which publishes them so
 * a port to another language can prove it produces the same bytes. If these
 * fail, blobs written here will not open with `obfus.py` and vice versa.
 */

import { describe, it, expect } from 'vitest';
import { keystream, pack, unpack, MAGIC } from '../obfus';

const hex = (u: Uint8Array) =>
  Array.from(u).map((b) => b.toString(16).padStart(2, '0')).join('');

const enc = (s: string) => new TextEncoder().encode(s);

describe('upstream test vectors', () => {
  it('keystream(seed=0, 8 bytes)', () => {
    expect(hex(keystream(0, 8))).toBe('8855508aade16ec5');
  });

  it('keystream(seed=7, 8 bytes)', () => {
    expect(hex(keystream(7, 8))).toBe('e16ab60aa1eeb707');
  });

  it('MAGIC', () => {
    // b'\x93Qobf1'. Note the upstream README prints this as 9351*63*626631,
    // which is a typo for the 'o' (0x6f) in its own source. The two blob
    // vectors below are derived from MAGIC and agree with 0x6f, which settles
    // it: a wrong MAGIC here would break both of them.
    expect(hex(MAGIC)).toBe('93516f626631');
  });

  it('blob(seed=0, "hello")', () => {
    expect(hex(pack(enc('hello'), 0))).toBe('1b043fe8cbd006a01fbe71');
  });

  it('blob(seed=5, "hello")', () => {
    expect(hex(pack(enc('hello'), 5))).toBe('dab98c4b1374a93fdacbfb');
  });

  it('both published blobs unpack to hello', () => {
    for (const seed of [0, 5]) {
      expect(new TextDecoder().decode(unpack(pack(enc('hello'), seed)))).toBe('hello');
    }
  });

  it('round-trips random data at all 16 seeds', () => {
    const data = new Uint8Array(5000);
    crypto.getRandomValues(data);
    for (let s = 0; s < 16; s++) {
      expect(unpack(pack(data, s))).toEqual(data);
    }
  });
});
