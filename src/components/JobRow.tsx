import type { Job } from '../lib/jobs';
import { formatBytes, formatDelta, formatDuration, formatRate } from '../lib/format';

interface Props {
  job: Job;
  onConfirm: (id: string) => void;
  onRetry: (id: string) => void;
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
}

const VERB: Record<Job['action'], string> = { pack: 'Pack', unpack: 'Unpack' };

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke late so the download has definitely started.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function JobRow({ job, onConfirm, onRetry, onCancel, onRemove }: Props) {
  const { status, result } = job;
  const pct = Math.round(job.progress * 100);
  const damaged = (result?.damagedChunks.length ?? 0) > 0;

  return (
    <li className={`job job--${status}${damaged ? ' job--damaged' : ''}`}>
      <div className="job__main">
        <div className="job__id">
          <span className="job__name" title={job.file.name}>{job.file.name}</span>
          <span className="job__facts mono">
            <span className={`tag tag--${job.action}`}>{VERB[job.action]}</span>
            <span>{formatBytes(job.file.size)}</span>
            {result && <><span className="job__arrow">→</span><span>{formatBytes(result.bytesOut)}</span></>}
            {result && job.action === 'pack' && (
              <span className="job__delta">{formatDelta(result.bytesIn, result.bytesOut)}</span>
            )}
          </span>
        </div>

        <div className="job__actions">
          {status === 'blocked' && (
            <button className="btn--warn" onClick={() => onConfirm(job.id)}>
              {VERB[job.action]} anyway
            </button>
          )}
          {status === 'running' && (
            <button onClick={() => onCancel(job.id)}>Cancel</button>
          )}
          {status === 'done' && result && (
            <button className="btn--primary" onClick={() => download(result.blob, result.filename)}>
              Save
            </button>
          )}
          {(status === 'error' || status === 'cancelled') && (
            <button onClick={() => onRetry(job.id)}>Retry</button>
          )}
          <button
            className="btn--ghost"
            onClick={() => onRemove(job.id)}
            aria-label={`Remove ${job.file.name}`}
            title="Remove"
          >
            ✕
          </button>
        </div>
      </div>

      {status === 'running' && (
        <div className="job__progress">
          <div className="bar"><div className="bar__fill" style={{ width: `${pct}%` }} /></div>
          <span className="job__progress-text mono">
            {pct}%{job.chunkCount > 1 && ` · chunk ${job.chunkIndex}/${job.chunkCount}`}
          </span>
        </div>
      )}

      {job.warnings.map((w) => (
        <div key={w.id} className={`notice notice--${w.level === 'block' ? 'warn' : 'info'}`}>
          <strong>{w.title}</strong>
          <span>{w.detail}</span>
        </div>
      ))}

      {status === 'error' && (
        <div className="notice notice--warn">
          <strong>Failed</strong>
          <span>{job.error}</span>
        </div>
      )}

      {status === 'cancelled' && (
        <div className="notice notice--info"><strong>Cancelled</strong><span>No output written.</span></div>
      )}

      {status === 'done' && result && (
        <>
          {result.repaired > 0 && (
            <div className="notice notice--info">
              <strong>Repaired {result.repaired} byte{result.repaired === 1 ? '' : 's'}</strong>
              <span>ECC corrected corruption during recovery. Output is intact.</span>
            </div>
          )}
          {damaged && (
            <div className="notice notice--warn">
              <strong>
                {result.damagedChunks.length} chunk
                {result.damagedChunks.length === 1 ? '' : 's'} beyond repair
              </strong>
              <span>
                Those regions were written as zeroes so offsets stay correct.
                The rest of the file recovered normally.
              </span>
            </div>
          )}
          <div className="job__stats mono">
            <span>{formatDuration(result.elapsedMs)}</span>
            <span>{formatRate(result.bytesIn, result.elapsedMs)}</span>
            <span>{result.chunkCount} chunk{result.chunkCount === 1 ? '' : 's'}</span>
            <span>peak {formatBytes(result.peakMemoryBytes)}</span>
            <span>{result.container ? 'container' : 'bare blob'}</span>
          </div>
        </>
      )}
    </li>
  );
}
