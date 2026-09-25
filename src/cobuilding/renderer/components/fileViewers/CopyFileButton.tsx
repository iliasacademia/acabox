import React, { useEffect, useRef, useState, type FC } from 'react';
import { MSymbol } from '../command-desk/MSymbol';

type FileContent = Awaited<ReturnType<typeof window.filesAPI.readFile>>;

/**
 * The text a Copy button puts on the clipboard: the file exactly as it is on
 * disk. For markdown that is the source even while the Rendered view is on
 * screen — pasting into a chat or an editor wants the markup, not whatever a
 * browser makes of rendered HTML. Null for files with no text to give
 * (images, PDFs, spreadsheets, too-large files), so no dead button is drawn.
 */
export function copyableText(content: FileContent | null | undefined): string | null {
  if (!content || 'error' in content) return null;
  return 'content' in content && typeof content.content === 'string' ? content.content : null;
}

type CopyState = 'idle' | 'copied' | 'failed';

/** Copies a whole file's text. Renders nothing when there is no text. */
export const CopyFileButton: FC<{ text: string | null }> = ({ text }) => {
  const [state, setState] = useState<CopyState>('idle');
  const resetRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(resetRef.current), []);
  // A different file starts fresh, not showing the last one's "Copied".
  useEffect(() => {
    clearTimeout(resetRef.current);
    setState('idle');
  }, [text]);

  if (text == null) return null;

  const show = (next: CopyState) => {
    setState(next);
    clearTimeout(resetRef.current);
    resetRef.current = setTimeout(() => setState('idle'), 1500);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => show('copied'), () => show('failed'));
  };

  return (
    <button
      type="button"
      className="fileDetailCopyBtn"
      onClick={handleCopy}
      title="Copy the whole file as text"
    >
      <MSymbol name={state === 'copied' ? 'check' : 'content_copy'} size={16} />
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Couldn’t copy' : 'Copy'}
    </button>
  );
};
