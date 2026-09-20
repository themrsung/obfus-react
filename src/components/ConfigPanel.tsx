import type { AppConfig } from '../config';
import { formatBytes } from '../lib/format';
import { RS_K, RS_NSYM } from '../engine/ecc';

interface Props {
  config: AppConfig;
  chunkSize: number;
  warnings: string[];
}

export function ConfigPanel({ config, chunkSize, warnings }: Props) {
  const rows = [
    {
      label: 'Engine RAM ceiling',
      value: formatBytes(config.engine.maxMemoryBytes),
      hint: 'Pack/unpack working set only — not the whole app',
    },
    {
      label: 'Chunk size',
      value: formatBytes(chunkSize),
      hint: config.engine.chunkSize === 'auto' ? 'derived from the ceiling' : 'set in config.json',
    },
    {
      label: 'ECC code',
      value: `RS(${RS_K + RS_NSYM}, ${RS_K})`,
      hint: `corrects ${RS_NSYM >> 1} bad bytes per ${RS_K + RS_NSYM}-byte block`,
    },
    {
      label: 'Overhead cap',
      value: `${(config.ecc.maxOverheadRatio * 100).toFixed(0)}%`,
      hint: `actual ${((RS_NSYM / RS_K) * 100).toFixed(2)}%`,
    },
  ];

  return (
    <aside className="config">
      <h2 className="config__title">config.json</h2>
      <dl className="config__grid">
        {rows.map((r) => (
          <div key={r.label} className="config__row">
            <dt>{r.label}</dt>
            <dd>
              <span className="mono config__value">{r.value}</span>
              <span className="config__hint">{r.hint}</span>
            </dd>
          </div>
        ))}
      </dl>

      {warnings.map((w, i) => (
        <div key={i} className="notice notice--warn"><span>{w}</span></div>
      ))}
    </aside>
  );
}
