import { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}

/**
 * Drop target for files, plus a clipboard path.
 *
 * The paste listener sits on the document rather than the element so Ctrl/Cmd+V
 * works without the drop zone having to be focused, which is what people
 * actually expect.
 */
export function DropZone({ onFiles, disabled }: Props) {
  const [over, setOver] = useState(false);
  const [pasteFlash, setPasteFlash] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const depth = useRef(0);

  const emit = useCallback((files: File[]) => {
    if (!disabled && files.length) onFiles(files);
  }, [disabled, onFiles]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (disabled || !e.clipboardData) return;

      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;

      const files = Array.from(e.clipboardData.files);

      // Clipboard text is still a payload worth obfuscating; wrap it in a file
      // so it takes the same path as everything else.
      if (files.length === 0) {
        const text = e.clipboardData.getData('text/plain');
        if (!text) return;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        files.push(new File([text], `pasted-${stamp}.txt`, { type: 'text/plain' }));
      }

      e.preventDefault();
      setPasteFlash(true);
      window.setTimeout(() => setPasteFlash(false), 450);
      emit(files);
    };

    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [disabled, emit]);

  // Suppress the browser's "open this file" default across the whole window.
  useEffect(() => {
    const stop = (e: DragEvent) => { e.preventDefault(); };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);

  return (
    <div
      className={`dropzone${over ? ' is-over' : ''}${pasteFlash ? ' is-paste' : ''}`}
      data-disabled={disabled || undefined}
      onDragEnter={(e) => { e.preventDefault(); depth.current++; setOver(true); }}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
      onDragLeave={() => { if (--depth.current <= 0) { depth.current = 0; setOver(false); } }}
      onDrop={(e) => {
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        emit(Array.from(e.dataTransfer.files));
      }}
      onClick={() => !disabled && input.current?.click()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click(); }
      }}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label="Add files by dropping them here, pasting, or browsing"
      aria-disabled={disabled}
    >
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          emit(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />

      <svg className="dropzone__glyph" viewBox="0 0 48 48" aria-hidden="true">
        <path d="M24 31V9m0 0-8 8m8-8 8 8" fill="none" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round" />
        <path d="M8 30v6a3 3 0 0 0 3 3h26a3 3 0 0 0 3-3v-6" fill="none"
              strokeWidth="2.5" strokeLinecap="round" />
      </svg>

      <p className="dropzone__lead">Drop files here</p>
      <p className="dropzone__sub">
        or <kbd>{navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}</kbd>
        <kbd>V</kbd> to paste, or click to browse
      </p>
    </div>
  );
}
