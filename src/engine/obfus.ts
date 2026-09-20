/**
 * Port of the .obfus core format from themrsung/file-obfuscation (CC0).
 *
 * A blob is XOR(MAGIC || plaintext, keystream(seed)) where seed is a random
 * 4-bit value that is never stored. unpack() recovers it by trying all 16.
 *
 * NOT ENCRYPTION. The key is 4 bits and is discarded at write time; anyone can
 * brute-force it, which is exactly what unpack() does. It obfuscates — the
 * bytes stop looking like their original format — and nothing more.
 *
 * The four format constants below must stay byte-exact or blobs will not
 * interoperate with anything else built from the reference file.
 */

import { sha256Short } from './sha256';

export const MAGIC = new Uint8Array([0x93, 0x51, 0x6f, 0x62, 0x66, 0x31]); // \x93Qobf1
export const KEYBITS = 4;
export const KEYSPACE = 1 << KEYBITS;
export const EXT = '.obfus';
export const MAGIC_LEN = MAGIC.length;

/** SHA-256 in counter mode: sha256(seed_byte || u32le(ctr)), truncated to n. */
export function keystream(seed: number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  const msg = new Uint8Array(5);
  msg[0] = seed;
  const tail = new Uint8Array(32);

  let ctr = 0;
  let off = 0;
  while (off < n) {
    msg[1] = ctr & 0xff;
    msg[2] = (ctr >>> 8) & 0xff;
    msg[3] = (ctr >>> 16) & 0xff;
    msg[4] = (ctr >>> 24) & 0xff;

    if (n - off >= 32) {
      sha256Short(msg, out, off);
      off += 32;
    } else {
      sha256Short(msg, tail, 0);
      out.set(tail.subarray(0, n - off), off);
      off = n;
    }
    ctr++;
  }
  return out;
}

/** XOR `data` with keystream(seed) in place. */
export function xorInPlace(data: Uint8Array, seed: number): void {
  const ks = keystream(seed, data.length);
  for (let i = 0; i < data.length; i++) data[i] ^= ks[i];
}

/** Draw a random 4-bit seed. Discarded immediately after use, never stored. */
export function randomSeed(): number {
  const b = new Uint8Array(1);
  crypto.getRandomValues(b);
  return b[0] & (KEYSPACE - 1);
}

/**
 * plaintext -> blob, 6 bytes longer.
 *
 * Not reproducible: draws a random seed, so the same input yields one of 16
 * possible outputs.
 */
export function pack(plaintext: Uint8Array, seed = randomSeed()): Uint8Array {
  const blob = new Uint8Array(MAGIC_LEN + plaintext.length);
  blob.set(MAGIC, 0);
  blob.set(plaintext, MAGIC_LEN);
  xorInPlace(blob, seed);
  return blob;
}

/** Identify the seed a blob was packed with, or -1 if none of the 16 fit. */
export function findSeed(blob: Uint8Array): number {
  if (blob.length < MAGIC_LEN) return -1;

  // Only the first 6 bytes decide the match, so test those before doing the
  // work of a full-length keystream.
  const probe = blob.subarray(0, MAGIC_LEN);
  for (let seed = 0; seed < KEYSPACE; seed++) {
    const ks = keystream(seed, MAGIC_LEN);
    let hit = true;
    for (let i = 0; i < MAGIC_LEN; i++) {
      if ((probe[i] ^ ks[i]) !== MAGIC[i]) { hit = false; break; }
    }
    if (hit) return seed;
  }
  return -1;
}

/** blob -> plaintext. Tries all 16 seeds; throws if none fit. */
export function unpack(blob: Uint8Array): Uint8Array {
  const seed = findSeed(blob);
  if (seed < 0) throw new Error('no key matched');

  const out = new Uint8Array(blob.length);
  out.set(blob);
  xorInPlace(out, seed);
  return out.subarray(MAGIC_LEN);
}

/** True if `blob` decodes under one of the 16 seeds — i.e. it is a real blob. */
export function looksLikeObfus(blob: Uint8Array): boolean {
  return findSeed(blob) >= 0;
}
