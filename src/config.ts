/**
 * Runtime configuration, loaded from /config.json at startup.
 *
 * It lives in `public/` rather than being bundled so it can be edited after a
 * build without recompiling — which is the point of having it be a file.
 */

export interface EngineConfig {
  /**
   * Ceiling on what the pack/unpack engine may hold at once.
   *
   * This bounds the *engine*, not the whole app: the browser, React, and any
   * blob-resident file bytes sit outside it. Set it conservatively — a tab
   * gets far less headroom than the machine has RAM.
   */
  maxMemoryBytes: number;
  /** Plaintext bytes per chunk, or "auto" to derive from the ceiling. */
  chunkSize: number | 'auto';
  minChunkSize: number;
  maxChunkSize: number;
  /** Peak engine working set is ~4x the chunk size; this leaves slack. */
  memorySafetyFactor: number;
}

export interface EccConfig {
  enabled: boolean;
  /** Refuse an ECC setting whose overhead would exceed this share. */
  maxOverheadRatio: number;
}

export interface AppConfig {
  engine: EngineConfig;
  ecc: EccConfig;
}

export const DEFAULT_CONFIG: AppConfig = {
  engine: {
    maxMemoryBytes: 256 * 1024 * 1024,
    chunkSize: 'auto',
    minChunkSize: 64 * 1024,
    maxChunkSize: 8 * 1024 * 1024,
    memorySafetyFactor: 6,
  },
  ecc: {
    enabled: true,
    maxOverheadRatio: 0.05,
  },
};

export interface LoadedConfig {
  config: AppConfig;
  /** Problems found while loading; surfaced in the UI rather than swallowed. */
  warnings: string[];
}

const num = (v: unknown, fallback: number, name: string, warnings: string[]): number => {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    warnings.push(`config.json: ${name} must be a positive number, using ${fallback}`);
    return fallback;
  }
  return v;
};

function normalise(raw: unknown, warnings: string[]): AppConfig {
  const d = DEFAULT_CONFIG;
  const root = (raw ?? {}) as Record<string, unknown>;
  const e = (root.engine ?? {}) as Record<string, unknown>;
  const c = (root.ecc ?? {}) as Record<string, unknown>;

  let chunkSize: number | 'auto' = d.engine.chunkSize;
  if (e.chunkSize !== undefined && e.chunkSize !== 'auto') {
    chunkSize = num(e.chunkSize, d.engine.maxChunkSize, 'engine.chunkSize', warnings);
  }

  const engine: EngineConfig = {
    maxMemoryBytes: num(e.maxMemoryBytes, d.engine.maxMemoryBytes, 'engine.maxMemoryBytes', warnings),
    chunkSize,
    minChunkSize: num(e.minChunkSize, d.engine.minChunkSize, 'engine.minChunkSize', warnings),
    maxChunkSize: num(e.maxChunkSize, d.engine.maxChunkSize, 'engine.maxChunkSize', warnings),
    memorySafetyFactor: num(e.memorySafetyFactor, d.engine.memorySafetyFactor, 'engine.memorySafetyFactor', warnings),
  };

  if (engine.minChunkSize > engine.maxChunkSize) {
    warnings.push('config.json: engine.minChunkSize exceeds maxChunkSize, swapping them');
    [engine.minChunkSize, engine.maxChunkSize] = [engine.maxChunkSize, engine.minChunkSize];
  }

  const ecc: EccConfig = {
    enabled: typeof c.enabled === 'boolean' ? c.enabled : d.ecc.enabled,
    maxOverheadRatio: num(c.maxOverheadRatio, d.ecc.maxOverheadRatio, 'ecc.maxOverheadRatio', warnings),
  };

  return { engine, ecc };
}

/**
 * Chunk size the engine will actually use.
 *
 * Peak working set per chunk is roughly 4x the chunk (plaintext, packed blob,
 * keystream, parity), so the safety factor keeps that comfortably inside the
 * ceiling with room for the accumulator.
 */
export function resolveChunkSize(engine: EngineConfig): number {
  const auto = Math.floor(engine.maxMemoryBytes / engine.memorySafetyFactor);
  const wanted = engine.chunkSize === 'auto' ? auto : engine.chunkSize;
  const clamped = Math.min(Math.max(wanted, engine.minChunkSize), engine.maxChunkSize);

  // Never hand back a chunk the ceiling cannot actually service.
  const affordable = Math.floor(engine.maxMemoryBytes / 4.5);
  return Math.max(4096, Math.min(clamped, affordable));
}

/** Bytes the accumulator may hold before flushing to the Blob store. */
export function resolveFlushThreshold(engine: EngineConfig): number {
  return Math.max(1 << 20, Math.floor(engine.maxMemoryBytes / 8));
}

export async function loadConfig(url = 'config.json'): Promise<LoadedConfig> {
  const warnings: string[] = [];
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    return { config: normalise(raw, warnings), warnings };
  } catch (err) {
    warnings.push(
      `Could not load ${url} (${err instanceof Error ? err.message : String(err)}). ` +
      `Falling back to built-in defaults.`,
    );
    return { config: DEFAULT_CONFIG, warnings };
  }
}
