import type { Mode } from '../lib/jobs';

interface Props {
  mode: Mode;
  onMode: (m: Mode) => void;
  ecc: boolean;
  onEcc: (v: boolean) => void;
  eccOverhead: string;
  disabled?: boolean;
}

const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Decide per file from its contents' },
  { value: 'pack', label: 'Pack', hint: 'Always obfuscate' },
  { value: 'unpack', label: 'Unpack', hint: 'Always recover' },
];

export function ModeBar({ mode, onMode, ecc, onEcc, eccOverhead, disabled }: Props) {
  return (
    <div className="modebar">
      <div className="segmented" role="radiogroup" aria-label="Mode">
        {MODES.map((m) => (
          <button
            key={m.value}
            role="radio"
            aria-checked={mode === m.value}
            className={`segmented__item${mode === m.value ? ' is-active' : ''}`}
            onClick={() => onMode(m.value)}
            title={m.hint}
            disabled={disabled}
          >
            {m.label}
          </button>
        ))}
      </div>

      <label className={`toggle${mode === 'unpack' ? ' is-muted' : ''}`}>
        <input
          type="checkbox"
          checked={ecc}
          onChange={(e) => onEcc(e.target.checked)}
          disabled={disabled}
        />
        <span className="toggle__track" aria-hidden="true"><span className="toggle__thumb" /></span>
        <span className="toggle__label">
          ECC redundancy
          <span className="toggle__meta mono">+{eccOverhead}</span>
        </span>
      </label>
    </div>
  );
}
