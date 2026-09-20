/// <reference lib="webworker" />
/**
 * Engine worker.
 *
 * The keystream costs one SHA-256 per 32 bytes, so this has to stay off the
 * main thread or the UI locks up on anything larger than a toy file.
 */

import { packSource, unpackSource, blobSource } from './container';
import { MemoryBudget } from './budget';
import { BlobAccumulator } from './accumulator';
import type { WorkerRequest, WorkerResponse } from './protocol';

const controllers = new Map<string, AbortController>();

const post = (msg: WorkerResponse) => (self as DedicatedWorkerGlobalScope).postMessage(msg);

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;

  if (msg.type === 'cancel') {
    controllers.get(msg.id)?.abort();
    return;
  }
  if (msg.type !== 'run') return;

  const { id, mode, file, chunkSize, ecc, maxMemoryBytes, flushThreshold } = msg;
  const controller = new AbortController();
  controllers.set(id, controller);

  const started = performance.now();
  const budget = new MemoryBudget(maxMemoryBytes);
  const sink = new BlobAccumulator(budget, flushThreshold);

  // Coalesce progress so a fast job does not flood the main thread.
  let lastPost = 0;
  const onProgress = (p: {
    bytesDone: number; bytesTotal: number; chunkIndex: number; chunkCount: number;
  }) => {
    const now = performance.now();
    if (now - lastPost < 50 && p.bytesDone < p.bytesTotal) return;
    lastPost = now;
    post({ type: 'progress', id, ...p });
  };

  try {
    const src = blobSource(file);
    const common = { budget, sink, onProgress, signal: controller.signal };

    if (mode === 'pack') {
      const r = await packSource(src, { ...common, chunkSize, ecc });
      post({
        type: 'done', id, blob: sink.finish(),
        bytesIn: file.size, bytesOut: r.bytesOut, chunkCount: r.chunkCount,
        container: r.container, repaired: 0, damagedChunks: [],
        peakMemoryBytes: budget.peakUsed, elapsedMs: performance.now() - started,
      });
    } else {
      const r = await unpackSource(src, common);
      post({
        type: 'done', id, blob: sink.finish(),
        bytesIn: file.size, bytesOut: r.bytesOut, chunkCount: r.chunkCount,
        container: r.container, repaired: r.repaired, damagedChunks: r.damagedChunks,
        peakMemoryBytes: budget.peakUsed, elapsedMs: performance.now() - started,
      });
    }
  } catch (err) {
    const e = err as Error;
    post({ type: 'error', id, name: e?.name ?? 'Error', message: e?.message ?? String(err) });
  } finally {
    controllers.delete(id);
  }
};
