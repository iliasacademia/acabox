import React, { useEffect, useRef, useState, type FC } from 'react';
import { useComposerRuntime } from '@assistant-ui/react';
import { MSymbol } from './MSymbol';
import { screenshotFileName } from '../../../shared/screenshot';

/**
 * Composer button: click, then click or drag anywhere on screen. Inside
 * Acabox the capture is instant; outside it the macOS picker asks which screen
 * or window (the flow and its reasons live in `shared/screenshot.ts`). The
 * image lands in the composer as an ordinary attachment — nothing is sent
 * until the user sends.
 */

let lastSecond = '';
let sameSecond = 0;

function nextFileName(): string {
  const now = new Date();
  const key = now.toISOString().slice(0, 19);
  sameSecond = key === lastSecond ? sameSecond + 1 : 0;
  lastSecond = key;
  return screenshotFileName(now, sameSecond);
}

function base64ToFile(base64: string, name: string): File {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: 'image/png' });
}

export const ScreenshotButton: FC<{ size?: number }> = ({ size = 19 }) => {
  const composer = useComposerRuntime();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => () => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
  }, []);

  // No bridge (jest, a window without the preload): no button, not a dead one.
  if (!window.screenshotAPI) return null;

  const showNotice = (text: string) => {
    setNotice(text);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 6000);
  };

  const onClick = async (e: React.MouseEvent) => {
    if (busy || !window.screenshotAPI) return;
    // A mouse click (detail > 0) tells main where Acabox really is on screen;
    // a keyboard press has no position, and main falls back to the window frame.
    const press = e.detail > 0 ? { x: e.clientX, y: e.clientY } : undefined;
    setBusy(true);
    setNotice(null);
    try {
      const result = await window.screenshotAPI.capture(press);
      if (result.ok) {
        await composer.addAttachment(base64ToFile(result.base64, nextFileName()));
        buttonRef.current?.closest('form, .cdComposerRoot, .cdPanelComposer')?.querySelector('textarea')?.focus();
      } else if (result.reason !== 'cancelled') {
        showNotice(result.message ?? (result.reason === 'busy' ? 'A screenshot is already in progress.' : 'Screenshot failed.'));
      }
    } catch (err) {
      showNotice(err instanceof Error ? err.message : 'Screenshot failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="cdIconBtn"
        title="Screenshot — drag an area or click a window"
        aria-label="Take a screenshot"
        onClick={onClick}
        disabled={busy}
      >
        <MSymbol name="screenshot_region" size={size} />
      </button>
      {notice && <span className="cdMicNotice" role="status">{notice}</span>}
    </>
  );
};
