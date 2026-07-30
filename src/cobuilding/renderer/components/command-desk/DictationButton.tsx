import React, { useEffect, useRef, useState, type FC } from 'react';
import { ComposerPrimitive, AuiIf } from '@assistant-ui/react';
import { MSymbol } from './MSymbol';

/**
 * Mic button for the chat composers. Renders inside a `ComposerPrimitive.Root`,
 * so both the docked GlobalComposer and the narrow side-panel ChatComposer get
 * identical behaviour from one component.
 *
 * Start/stop go through `ComposerPrimitive.Dictate` / `.StopDictation` rather
 * than calling the host directly — the runtime owns the transcript, including
 * preserving whatever the user had already typed, and driving it from the side
 * would fight it.
 *
 * The button is absent, not disabled, when the host reports no dictation
 * support. A disabled mic on a machine that will never have one is a permanent
 * dead control; the capability check is prompt-free precisely so this decision
 * can be made before the user touches anything.
 */

/** Capability probe, run once per mount. Never raises a permission prompt. */
function useDictationAvailable(): boolean {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.dictationAPI
      .probe()
      .then((caps) => {
        if (!cancelled) setAvailable(caps.available);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return available;
}

/**
 * Mic level and out-of-band notices (errors, first-run model download).
 * These ride the host event stream rather than the composer runtime, because
 * the runtime's dictation state models the transcript only.
 */
function useDictationSignals(): { level: number; notice: string | null } {
  const [level, setLevel] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const decayTimer = useRef<number | null>(null);

  useEffect(() => {
    const unsubscribe = window.dictationAPI.onEvent((event) => {
      switch (event.type) {
        case 'level':
          setLevel(event.rms);
          // The level stream stops dead when dictation ends; without a decay
          // the ring would freeze at whatever the last frame happened to be.
          if (decayTimer.current) window.clearTimeout(decayTimer.current);
          decayTimer.current = window.setTimeout(() => setLevel(0), 400);
          break;
        case 'installing':
          setNotice(`Downloading the ${event.locale} speech model…`);
          break;
        case 'installed':
        case 'listening':
          setNotice(null);
          break;
        case 'error':
          setNotice(event.message);
          break;
        case 'stopped':
          setLevel(0);
          break;
        default:
          break;
      }
    });

    return () => {
      unsubscribe();
      if (decayTimer.current) window.clearTimeout(decayTimer.current);
    };
  }, []);

  // An error is worth reading after dictation ends, so it is cleared on the
  // next start rather than on a timer.
  return { level, notice };
}

export const DictationButton: FC<{ size?: number }> = ({ size = 19 }) => {
  const available = useDictationAvailable();
  const { level, notice } = useDictationSignals();

  if (!available) return null;

  return (
    <>
      <AuiIf condition={(s: any) => !s.composer?.dictation}>
        <ComposerPrimitive.Dictate asChild>
          <button
            type="button"
            className="cdIconBtn cdMicBtn"
            title="Dictate (on-device)"
            aria-label="Start dictation"
          >
            <MSymbol name="mic" size={size} />
          </button>
        </ComposerPrimitive.Dictate>
      </AuiIf>

      <AuiIf condition={(s: any) => !!s.composer?.dictation}>
        <ComposerPrimitive.StopDictation asChild>
          <button
            type="button"
            className="cdIconBtn cdMicBtn cdMicBtn--live"
            title="Stop dictation"
            aria-label="Stop dictation"
            // Drives the level ring. A CSS variable keeps this off React's
            // render path — the level updates ~12x/second and re-rendering the
            // composer subtree that often would be wasteful.
            style={{ ['--cdMicLevel' as string]: level.toFixed(2) }}
          >
            <span className="cdMicBtn__ring" aria-hidden="true" />
            <MSymbol name="mic" size={size} />
          </button>
        </ComposerPrimitive.StopDictation>
      </AuiIf>

      {notice && <span className="cdMicNotice" role="status">{notice}</span>}
    </>
  );
};
