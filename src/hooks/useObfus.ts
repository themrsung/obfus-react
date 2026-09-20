/**
 * The app's only stateful piece.
 *
 * Everything here is per-session and in-memory: no storage APIs, no network
 * beyond the initial config.json fetch, nothing persisted between reloads.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EngineClient } from '../engine/client';
import { loadConfig, resolveChunkSize, resolveFlushThreshold, DEFAULT_CONFIG } from '../config';
import type { AppConfig } from '../config';
import { sniff } from '../lib/sniff';
import {
  deriveWarnings, isBlocked, outputName, resolveAction, planEcc,
} from '../lib/jobs';
import type { Job, Mode } from '../lib/jobs';

let counter = 0;
const nextId = () => `job-${Date.now().toString(36)}-${++counter}`;

export function useObfus() {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [configWarnings, setConfigWarnings] = useState<string[]>([]);
  const [configReady, setConfigReady] = useState(false);

  const [mode, setMode] = useState<Mode>('auto');
  const [ecc, setEcc] = useState(DEFAULT_CONFIG.ecc.enabled);
  const [jobs, setJobs] = useState<Job[]>([]);

  const engine = useRef<EngineClient | null>(null);
  const running = useRef(new Map<string, string>()); // jobId -> engine job id

  useEffect(() => {
    let alive = true;
    loadConfig().then(({ config: c, warnings }) => {
      if (!alive) return;
      setConfig(c);
      setConfigWarnings(warnings);
      setEcc(c.ecc.enabled);
      setConfigReady(true);
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    engine.current = new EngineClient();
    return () => { engine.current?.terminate(); engine.current = null; };
  }, []);

  const chunkSize = useMemo(() => resolveChunkSize(config.engine), [config.engine]);
  const flushThreshold = useMemo(() => resolveFlushThreshold(config.engine), [config.engine]);

  const patch = useCallback((id: string, up: Partial<Job> | ((j: Job) => Partial<Job>)) => {
    setJobs((prev) => prev.map((j) =>
      j.id === id ? { ...j, ...(typeof up === 'function' ? up(j) : up) } : j,
    ));
  }, []);

  const start = useCallback((job: Job) => {
    const client = engine.current;
    if (!client) return;

    patch(job.id, { status: 'running', progress: 0, error: undefined });

    const { id: engineId, result } = client.run({
      file: job.file,
      mode: job.action,
      chunkSize,
      ecc: planEcc(job.file, job.action, ecc, chunkSize, config.ecc.maxOverheadRatio).applied,
      maxMemoryBytes: config.engine.maxMemoryBytes,
      flushThreshold,
      onProgress: (p) => patch(job.id, {
        progress: p.bytesTotal ? p.bytesDone / p.bytesTotal : 0,
        chunkIndex: p.chunkIndex,
        chunkCount: p.chunkCount,
      }),
    });
    running.current.set(job.id, engineId);

    result.then(
      (d) => {
        running.current.delete(job.id);
        patch(job.id, {
          status: 'done',
          progress: 1,
          result: {
            blob: d.blob,
            filename: outputName(job.file, job.action),
            bytesIn: d.bytesIn,
            bytesOut: d.bytesOut,
            chunkCount: d.chunkCount,
            container: d.container,
            repaired: d.repaired,
            damagedChunks: d.damagedChunks,
            peakMemoryBytes: d.peakMemoryBytes,
            elapsedMs: d.elapsedMs,
          },
        });
      },
      (e: Error) => {
        running.current.delete(job.id);
        patch(job.id, {
          status: e.name === 'AbortError' ? 'cancelled' : 'error',
          error: e.name === 'AbortError' ? undefined : e.message,
        });
      },
    );
  }, [chunkSize, ecc, config.engine.maxMemoryBytes, config.ecc.maxOverheadRatio, flushThreshold, patch]);

  const addFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;

    const built = await Promise.all(files.map(async (file): Promise<Job> => {
      const s = await sniff(file);
      const action = resolveAction(mode, s);
      const plan = planEcc(file, action, ecc, chunkSize, config.ecc.maxOverheadRatio);
      const warnings = deriveWarnings(action, s, mode, { wanted: ecc, plan, cap: config.ecc.maxOverheadRatio });
      const job: Job = {
        id: nextId(), file, sniff: s, action,
        status: 'ready', warnings, acknowledged: false,
        progress: 0, chunkIndex: 0, chunkCount: 0,
      };
      job.status = isBlocked(job) ? 'blocked' : 'ready';
      return job;
    }));

    setJobs((prev) => [...built, ...prev]);
    // Anything without a blocking warning just goes.
    for (const j of built) if (j.status === 'ready') start(j);
  }, [mode, ecc, chunkSize, config.ecc.maxOverheadRatio, start]);

  /** Re-evaluate queued jobs when the mode changes; running ones are left be. */
  useEffect(() => {
    setJobs((prev) => prev.map((j) => {
      if (j.status !== 'ready' && j.status !== 'blocked') return j;
      const action = resolveAction(mode, j.sniff);
      const plan = planEcc(j.file, action, ecc, chunkSize, config.ecc.maxOverheadRatio);
      const warnings = deriveWarnings(action, j.sniff, mode, { wanted: ecc, plan, cap: config.ecc.maxOverheadRatio });
      const next: Job = { ...j, action, warnings, acknowledged: false };
      next.status = isBlocked(next) ? 'blocked' : 'ready';
      return next;
    }));
  }, [mode, ecc, chunkSize, config.ecc.maxOverheadRatio]);

  const confirm = useCallback((id: string) => {
    setJobs((prev) => {
      const j = prev.find((x) => x.id === id);
      if (j) queueMicrotask(() => start({ ...j, acknowledged: true }));
      return prev.map((x) => (x.id === id ? { ...x, acknowledged: true } : x));
    });
  }, [start]);

  const retry = useCallback((id: string) => {
    setJobs((prev) => {
      const j = prev.find((x) => x.id === id);
      if (j) queueMicrotask(() => start(j));
      return prev;
    });
  }, [start]);

  const cancel = useCallback((id: string) => {
    const engineId = running.current.get(id);
    if (engineId) engine.current?.cancel(engineId);
  }, []);

  const remove = useCallback((id: string) => {
    cancel(id);
    setJobs((prev) => prev.filter((j) => j.id !== id));
  }, [cancel]);

  const clearFinished = useCallback(() => {
    setJobs((prev) => prev.filter((j) => j.status === 'running' || j.status === 'blocked'));
  }, []);

  return {
    config, configWarnings, configReady, chunkSize,
    mode, setMode, ecc, setEcc,
    jobs, addFiles, confirm, retry, cancel, remove, clearFinished,
  };
}
