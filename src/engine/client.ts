/** Main-thread handle to the engine worker. */

import type {
  DoneMessage, ProgressMessage, WorkerRequest, WorkerResponse, JobMode,
} from './protocol';

export interface RunParams {
  file: File;
  mode: JobMode;
  chunkSize: number;
  ecc: boolean;
  maxMemoryBytes: number;
  flushThreshold: number;
  onProgress?: (p: ProgressMessage) => void;
}

interface Pending {
  resolve: (d: DoneMessage) => void;
  reject: (e: Error) => void;
  onProgress?: (p: ProgressMessage) => void;
}

export class EngineClient {
  private worker: Worker | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;

  private ensure(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.dispatch(ev.data);
      this.worker.onerror = (ev) => {
        const err = new Error(ev.message || 'engine worker crashed');
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        this.terminate();
      };
    }
    return this.worker;
  }

  private dispatch(msg: WorkerResponse): void {
    const entry = this.pending.get(msg.id);
    if (!entry) return;

    if (msg.type === 'progress') {
      entry.onProgress?.(msg);
    } else if (msg.type === 'done') {
      this.pending.delete(msg.id);
      entry.resolve(msg);
    } else {
      this.pending.delete(msg.id);
      const err = new Error(msg.message);
      err.name = msg.name;
      entry.reject(err);
    }
  }

  run(params: RunParams): { id: string; result: Promise<DoneMessage> } {
    const id = `job-${++this.seq}`;
    const worker = this.ensure();

    const result = new Promise<DoneMessage>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress: params.onProgress });
      const req: WorkerRequest = {
        type: 'run', id,
        mode: params.mode,
        file: params.file,
        chunkSize: params.chunkSize,
        ecc: params.ecc,
        maxMemoryBytes: params.maxMemoryBytes,
        flushThreshold: params.flushThreshold,
      };
      worker.postMessage(req);
    });

    return { id, result };
  }

  cancel(id: string): void {
    this.worker?.postMessage({ type: 'cancel', id } satisfies WorkerRequest);
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
