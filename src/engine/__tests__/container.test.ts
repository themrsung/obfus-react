import { describe, it, expect } from 'vitest';
import { packSource, unpackSource, bytesSource, isContainer, arraySink, projectPackedSize } from '../container';
import { MemoryBudget, MemoryBudgetError } from '../budget';
import { unpack as bareUnpack } from '../obfus';

const join = (parts: Uint8Array[]) => {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const rand = (n: number) => {
  const u = new Uint8Array(n);
  for (let o = 0; o < n; o += 65536) crypto.getRandomValues(u.subarray(o, Math.min(o + 65536, n)));
  return u;
};
const budget = () => new MemoryBudget(256 * 1024 * 1024);

async function roundtrip(data: Uint8Array, chunkSize: number, ecc: boolean) {
  const ps = arraySink();
  const packed = await packSource(bytesSource(data), { chunkSize, ecc, budget: budget(), sink: ps });
  const blob = join(ps.parts);
  const us = arraySink();
  const res = await unpackSource(bytesSource(blob), { budget: budget(), sink: us });
  return { blob, out: join(us.parts), res, packed };
}

async function unpackTo(blob: Uint8Array) {
  const sink = arraySink();
  const res = await unpackSource(bytesSource(blob), { budget: budget(), sink });
  return { res, out: join(sink.parts) };
}

describe('container roundtrip', () => {
  const sizes = [0, 1, 5, 255, 4096, 100_000];

  for (const ecc of [false, true]) {
    for (const size of sizes) {
      it(`ecc=${ecc} size=${size} single chunk`, async () => {
        const data = rand(size);
        const { out } = await roundtrip(data, 1 << 20, ecc);
        expect(out).toEqual(data);
      });
    }

    it(`ecc=${ecc} multi-chunk splits and rejoins`, async () => {
      const data = rand(50_000);
      const { out, packed } = await roundtrip(data, 4096, ecc);
      expect(packed.chunkCount).toBe(Math.ceil(50_000 / 4096));
      expect(out).toEqual(data);
    });
  }

  it('stays upstream-compatible with no ecc and one chunk', async () => {
    const data = rand(1000);
    const { blob } = await roundtrip(data, 1 << 20, false);
    expect(isContainer(blob)).toBe(false);
    expect(blob.length).toBe(data.length + 6);
    expect(bareUnpack(blob)).toEqual(data);   // plain obfus.py blob
  });

  it('uses a container when ecc is on', async () => {
    const { blob } = await roundtrip(rand(1000), 1 << 20, true);
    expect(isContainer(blob)).toBe(true);
  });
});

describe('overhead budget', () => {
  it('stays at or under 5% for realistic files', async () => {
    for (const size of [1 << 20, 5 << 20]) {
      const { blob } = await roundtrip(rand(size), 1 << 20, true);
      const overhead = (blob.length - size) / size;
      expect(overhead).toBeLessThanOrEqual(0.05);
    }
  });
});

describe('ecc actually repairs', () => {
  it('recovers a file with scattered byte corruption', async () => {
    const CHUNK = 16_384, SIZE = 60_000;
    const data = rand(SIZE);
    const { blob } = await roundtrip(data, CHUNK, true);

    // Walk the real layout and put exactly 6 bad bytes (the correction radius
    // of RS(255,243)) into every data block. Parity lives out-of-line, so
    // blocks are not aligned to absolute 255-byte file offsets.
    const corrupt = new Uint8Array(blob);
    const hit = (from: number, len: number, n: number) => {
      const picked = new Set<number>();
      while (picked.size < Math.min(n, len)) picked.add(from + Math.floor(Math.random() * len));
      for (const p of picked) corrupt[p] ^= 1 + Math.floor(Math.random() * 255);
    };

    let off = 32 + Math.ceil(32 / 243) * 12;           // header + header parity
    const chunks = Math.ceil(SIZE / CHUNK);
    for (let i = 0; i < chunks; i++) {
      const storedLen = Math.min(CHUNK, SIZE - i * CHUNK) + 6;
      const dataLen = 8 + storedLen;
      const parityLen = Math.ceil(dataLen / 243) * 12;
      for (let b = 0; b * 243 < dataLen; b++) {
        const start = off + b * 243;
        hit(start, Math.min(243, dataLen - b * 243), 6);
      }
      off += dataLen + parityLen;
    }

    const { res, out } = await unpackTo(corrupt);
    expect(res.repaired).toBeGreaterThan(0);
    expect(res.damagedChunks).toEqual([]);
    expect(out).toEqual(data);
  });

  it('flags damage it cannot repair instead of emitting silent garbage', async () => {
    const data = rand(40_000);
    const { blob } = await roundtrip(data, 16_384, true);

    const corrupt = new Uint8Array(blob);
    // Obliterate a stretch far past the correction radius.
    for (let p = 2000; p < 6000; p++) corrupt[p] ^= 0xff;

    const { res, out } = await unpackTo(corrupt);
    expect(res.damagedChunks.length).toBeGreaterThan(0);
    expect(out.length).toBe(data.length);
  });

  it('without ecc, corruption is detected but not repaired', async () => {
    const data = rand(40_000);
    const { blob } = await roundtrip(data, 16_384, false);
    const corrupt = new Uint8Array(blob);
    for (let p = 2000; p < 2100; p++) corrupt[p] ^= 0xff;

    const { res } = await unpackTo(corrupt);
    expect(res.damagedChunks.length).toBeGreaterThan(0);
  });
});

describe('memory budget', () => {
  it('refuses work that would exceed the ceiling', async () => {
    const tiny = new MemoryBudget(64 * 1024);
    await expect(
      packSource(bytesSource(rand(2 << 20)), { chunkSize: 1 << 20, ecc: true, budget: tiny, sink: arraySink() }),
    ).rejects.toBeInstanceOf(MemoryBudgetError);
  });

  it('releases reservations between chunks', async () => {
    const b = new MemoryBudget(8 * 1024 * 1024);
    await packSource(bytesSource(rand(4 << 20)), { chunkSize: 256 * 1024, ecc: true, budget: b, sink: arraySink() });
    expect(b.used).toBe(0);
    expect(b.peakUsed).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});

describe('size projection', () => {
  it('predicts the packed size exactly', async () => {
    for (const size of [1, 5, 255, 4096, 50_000, 300_000]) {
      for (const ecc of [false, true]) {
        for (const chunkSize of [1 << 20, 4096]) {
          const data = rand(size);
          const ps = arraySink();
          await packSource(bytesSource(data), { chunkSize, ecc, budget: budget(), sink: ps });
          const actual = join(ps.parts).length;
          expect(
            projectPackedSize(size, chunkSize, ecc),
            `size=${size} ecc=${ecc} chunk=${chunkSize}`,
          ).toBe(actual);
        }
      }
    }
  });
});

describe('damaged container header', () => {
  const smash = (b: Uint8Array, n: number) => {
    const c = new Uint8Array(b);
    for (let i = 0; i < n; i++) c[i] ^= 0xff;
    return c;
  };

  it('recovers when corruption destroys the container magic', async () => {
    const data = rand(50_000);
    const { blob } = await roundtrip(data, 16_384, true);
    // Six bad bytes at offset 0 wipes the magic; RS(255,243) covers exactly six.
    const { res, out } = await unpackTo(smash(blob, 6));
    expect(res.container).toBe(true);
    expect(res.repaired).toBeGreaterThan(0);
    expect(out).toEqual(data);
  });

  it('does not mistake a bare upstream blob for a damaged header', async () => {
    const data = rand(2000);
    const ps = arraySink();
    await packSource(bytesSource(data), { chunkSize: 1 << 20, ecc: false, budget: budget(), sink: ps });
    const bare = join(ps.parts);
    const { res, out } = await unpackTo(bare);
    expect(res.container).toBe(false);
    expect(out).toEqual(data);
  });

  it('still rejects bytes that are neither', async () => {
    await expect(unpackTo(rand(5000))).rejects.toThrow(/no key matched/);
  });
});
