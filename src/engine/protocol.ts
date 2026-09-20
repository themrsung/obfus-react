/** Message types shared between the main thread and the engine worker. */

export type JobMode = 'pack' | 'unpack';

export interface RunRequest {
  type: 'run';
  id: string;
  mode: JobMode;
  file: File;
  chunkSize: number;
  ecc: boolean;
  maxMemoryBytes: number;
  flushThreshold: number;
}

export interface CancelRequest {
  type: 'cancel';
  id: string;
}

export type WorkerRequest = RunRequest | CancelRequest;

export interface ProgressMessage {
  type: 'progress';
  id: string;
  bytesDone: number;
  bytesTotal: number;
  chunkIndex: number;
  chunkCount: number;
}

export interface DoneMessage {
  type: 'done';
  id: string;
  blob: Blob;
  bytesIn: number;
  bytesOut: number;
  chunkCount: number;
  container: boolean;
  repaired: number;
  damagedChunks: number[];
  peakMemoryBytes: number;
  elapsedMs: number;
}

export interface ErrorMessage {
  type: 'error';
  id: string;
  name: string;
  message: string;
}

export type WorkerResponse = ProgressMessage | DoneMessage | ErrorMessage;
