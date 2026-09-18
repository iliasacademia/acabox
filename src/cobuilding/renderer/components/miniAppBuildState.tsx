/**
 * Pure classification of a `window.miniAppsAPI.build()` result, plus the
 * "not written yet" view, shared by `MiniAppViewer.tsx` (renders the right
 * screen) and its tests.
 *
 * Why this exists (2026-09-18 incident): a tool card appears the moment
 * Claude runs the scaffold script, but `src/App.tsx` is written by a LATER
 * tool call — sometimes minutes later for a large file. A viewer opened in
 * that window found no `dist/bundle.js`, triggered a build, and esbuild
 * failed with `Could not resolve "./App"` — a real compiler-looking error
 * for a tool that was simply never written yet. Main now detects that
 * specific situation (`reason: 'source-missing'`) and refuses to run esbuild
 * at all rather than recording a build failure. This module is what lets the
 * renderer tell "genuinely broken" apart from "not written yet" and choose
 * between the BUILD FAILED screen and a much gentler waiting screen.
 *
 * `AwaitingSourceView` lives HERE rather than in `MiniAppViewer.tsx` itself,
 * even though the rest of that ticket's UI work is there: `MiniAppViewer.tsx`
 * imports `useComposerRuntime` from `@assistant-ui/react`, which pulls in the
 * ESM-only `assistant-stream` package — not in jest's
 * `transformIgnorePatterns` whitelist, so importing anything from that file
 * (even an unrelated leaf component) fails a test with
 * `SyntaxError: Unexpected token 'export'`. This module has no such imports,
 * so it can be rendered directly in a test.
 */

import React, { type FC } from 'react';
import { MSymbol } from './command-desk/MSymbol';

export type BuildOutcome =
  | { kind: 'ok' }
  | { kind: 'awaiting-source' }
  | { kind: 'error'; message: string };

export function classifyBuildResult(result: {
  ok: boolean;
  error?: string;
  exitCode: number;
  reason?: 'source-missing';
}): BuildOutcome {
  if (result.ok) return { kind: 'ok' };
  if (result.reason === 'source-missing') return { kind: 'awaiting-source' };
  // buildMiniApp always supplies `error` (spawn failures included), so this
  // fallback should be unreachable — keep it honest rather than re-inventing
  // the old "esbuild exited with code N" phrasing, which reads as a compiler
  // error even when esbuild never ran.
  const message = (result.error || `Build failed (exit ${result.exitCode}) with no output.`).trim();
  return { kind: 'error', message };
}

/** Relative to an app's directory. The file whose absence means "not written yet". */
export const APP_SOURCE_RELATIVE_PATH = 'src/App.tsx';

/** How often the awaiting-source screen checks whether the source has landed. */
export const AWAITING_SOURCE_POLL_MS = 2000;

/**
 * "Not written yet" state — replaces the iframe content the same way the
 * build-failed screen does, but is deliberately NOT styled as a failure:
 * this is the expected shape of the window between the scaffold script
 * running and Claude's `src/App.tsx` write landing, not something gone
 * wrong. Reuses the `cdBuildErr` layout classes from `phaseB.css` with the
 * error-tinted eyebrow overridden via `cdBuildErr__eyebrow--waiting`.
 */
export const AwaitingSourceView: FC<{
  since: number;
  onRebuild: () => void;
  onOpenChat?: () => void;
}> = ({ since, onRebuild, onOpenChat }) => {
  const time = new Date(since);
  const hh = String(time.getHours()).padStart(2, '0');
  const mm = String(time.getMinutes()).padStart(2, '0');
  return (
    <div className="cdBuildErr">
      <div className="cdBuildErr__col">
        <span className="cdBuildErr__eyebrow cdBuildErr__eyebrow--waiting">BEING WRITTEN · {hh}:{mm}</span>
        <span className="cdBuildErr__title">Claude is still writing this tool.</span>
        <span className="cdBuildErr__sub">
          It appeared here as soon as it was scaffolded, but its source has not been saved yet. This
          view will build it on its own the moment the file lands.
        </span>
        <div className="cdBuildErr__actions">
          <button type="button" className="cdBtnPrimary cdBtnPrimary--36" onClick={onRebuild}>
            <MSymbol name="refresh" size={16} />
            Check again
          </button>
          {onOpenChat && (
            <button type="button" className="cdBtnXs cdBtnXs--sm" onClick={onOpenChat}>
              <MSymbol name="forum" size={15} />
              Open the chat
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
