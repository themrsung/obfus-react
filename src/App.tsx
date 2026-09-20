import { useMemo } from 'react';
import { useObfus } from './hooks/useObfus';
import { DropZone } from './components/DropZone';
import { ModeBar } from './components/ModeBar';
import { JobRow } from './components/JobRow';
import { ConfigPanel } from './components/ConfigPanel';
import { RS_K, RS_NSYM } from './engine/ecc';
import './app.css';

export default function App() {
  const {
    config, configWarnings, configReady, chunkSize,
    mode, setMode, ecc, setEcc,
    jobs, addFiles, confirm, retry, cancel, remove, clearFinished,
  } = useObfus();

  const eccOverhead = useMemo(() => `${((RS_NSYM / RS_K) * 100).toFixed(2)}%`, []);
  const finished = jobs.filter((j) => j.status !== 'running' && j.status !== 'blocked').length;

  return (
    <div className="shell">
      <header className="masthead">
        <div className="masthead__brand">
          <h1>obfus</h1>
          <p className="masthead__tag">
            Chunked <code>.obfus</code> packing with Reed–Solomon redundancy.
          </p>
        </div>
        <p className="masthead__note">
          Stateless — files are processed in this tab and never uploaded, stored,
          or remembered across reloads.
        </p>
      </header>

      <main className="layout">
        <section className="panel">
          <DropZone onFiles={addFiles} disabled={!configReady} />
          <ModeBar
            mode={mode}
            onMode={setMode}
            ecc={ecc}
            onEcc={setEcc}
            eccOverhead={eccOverhead}
            disabled={!configReady}
          />

          {jobs.length > 0 && (
            <div className="queue">
              <div className="queue__head">
                <h2>Queue</h2>
                {finished > 0 && (
                  <button className="btn--ghost" onClick={clearFinished}>Clear finished</button>
                )}
              </div>
              <ul className="queue__list">
                {jobs.map((j) => (
                  <JobRow
                    key={j.id}
                    job={j}
                    onConfirm={confirm}
                    onRetry={retry}
                    onCancel={cancel}
                    onRemove={remove}
                  />
                ))}
              </ul>
            </div>
          )}
        </section>

        <ConfigPanel config={config} chunkSize={chunkSize} warnings={configWarnings} />
      </main>

      <footer className="footnote">
        <p>
          <strong>Not encryption.</strong> The key is 4 bits and is discarded at
          write time; unpacking recovers it by trying all 16. This obfuscates —
          the bytes stop looking like their original format — and nothing more.
          For secrecy use age, libsodium, or AES-GCM with a real KDF.
        </p>
        <p className="footnote__links">
          <a href="https://github.com/themrsung/obfus-react">Source on GitHub</a>
          <span aria-hidden="true">·</span>
          <a href="https://github.com/themrsung/file-obfuscation">Upstream CLIs</a>
        </p>
      </footer>
    </div>
  );
}
