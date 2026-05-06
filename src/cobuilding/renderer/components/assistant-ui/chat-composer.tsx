/**
 * Single composer used by BOTH the desktop chat panel and the Word overlay.
 *
 * Until now the desktop (`thread.tsx`) and the overlay (`OverlayThread.tsx`)
 * each shipped their own composer subtree — same primitives, slightly
 * different toolbars. The overlay's was a deliberate strip-down: no model
 * picker, no attach button. Maintaining two composers turned out to be the
 * same hazard that bit us with the parallel DOI/Zotero rendering: bug fixes
 * and new features land in one place and silently miss the other. This
 * component is the single source of truth.
 *
 * Both surfaces drive the same assistant-ui Composer primitives, the same
 * setupStore, and the same composerAttachmentComponents — none of which
 * have an Electron dependency. ModelSelector is also transport-agnostic
 * (localStorage + useAssistantRuntime hook), so it imports cleanly into
 * the WKWebView overlay too.
 *
 * Model preference is intentionally per-surface: localStorage is per-origin,
 * so the desktop and overlay keep independent selections. Cross-surface
 * sync would mean adding an IPC channel + HTTP route + main-process file
 * (the doi-link.tsx pattern) — held off until someone actually wants it.
 */

import React, { type FC } from 'react';
import { ComposerPrimitive, AuiIf, useAuiState } from '@assistant-ui/react';
import { PaperclipIcon, SendIcon, SquareIcon } from 'lucide-react';

import { TooltipIconButton } from './tooltip-icon-button';
import { Button } from '../ui/button';
import { composerAttachmentComponents } from './composer-attachments';
import { ModelSelector } from '../ModelSelector';
import { useSetupState } from '../../setupStore';
import { OverlayFilePickerButton } from './overlay-file-picker';

// Pick the attach button at runtime: Chromium's native file picker handles
// `<input type="file">` in the desktop renderer, but the overlay's WKWebView
// silently ignores it (no WKUIDelegate file-picker callback wired up at the
// Rust webview layer). Same hasIPC sentinel doi-link.tsx uses.
const hasIPC = typeof window !== 'undefined' && typeof (window as any).electronAPI !== 'undefined';

export interface ChatComposerProps {
  /**
   * Optional content rendered inside `<ComposerPrimitive.Root>` above the
   * input shell. The Word overlay uses this to render its "selected text"
   * pill (the chip that shows what passage the user picked in Word). The
   * desktop chat passes nothing.
   */
  prefix?: React.ReactNode;
  /**
   * Override the input placeholder. Defaults to "Send a message...". The
   * overlay swaps this to "Reply" when the user has Word text selected.
   */
  placeholder?: string;
}

export const ChatComposer: FC<ChatComposerProps> = ({ prefix, placeholder = 'Send a message...' }) => {
  const setup = useSetupState();
  const isEmpty = useAuiState((s: any) => s.thread.isEmpty);

  // When the thread is empty, the centered welcome view handles the setup
  // indicator — don't duplicate it in the composer. For existing threads,
  // replace the input with the setup indicator so the user sees progress
  // instead of an unresponsive composer.
  if (setup.state === 'downloading' && !isEmpty) {
    return (
      <div className="composerRoot">
        <div className="composerSetupBlock">
          <span className="composerSetupText">{setup.message || 'Setting up environment...'}</span>
          <div className="composerSetupProgress">
            <div className="composerSetupProgressBar" style={{ width: `${setup.percent}%` }} />
          </div>
        </div>
      </div>
    );
  }

  // Empty thread + setup in progress — centered indicator handles it, hide
  // the composer entirely so the page isn't stacked.
  if (setup.state === 'downloading' && isEmpty) {
    return null;
  }

  return (
    <ComposerPrimitive.Root className="composerRoot">
      {prefix}
      <ComposerPrimitive.Attachments components={composerAttachmentComponents} />
      <div className="composerShell">
        <ComposerPrimitive.Input
          placeholder={placeholder}
          className="composerInput"
          rows={1}
          autoFocus
          aria-label="Message input"
        />
        <div className="composerToolbar">
          {hasIPC ? (
            <ComposerPrimitive.AddAttachment asChild>
              <TooltipIconButton
                tooltip="Attach file"
                side="bottom"
                type="button"
                variant="ghost"
                size="icon"
                className="composerAttach"
              >
                <PaperclipIcon className="composerAttachIcon" />
              </TooltipIconButton>
            </ComposerPrimitive.AddAttachment>
          ) : (
            <OverlayFilePickerButton />
          )}
          <ModelSelector />
          <ChatComposerAction />
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
};

const ChatComposerAction: FC = () => {
  return (
    <div className="composerActions">
      <AuiIf condition={(s: any) => !s.thread.isRunning}>
        <ComposerPrimitive.Send asChild>
          <TooltipIconButton
            tooltip="Send message"
            side="bottom"
            type="button"
            variant="default"
            size="icon"
            className="composerSend"
            aria-label="Send message"
          >
            <SendIcon className="composerSendIcon" />
          </TooltipIconButton>
        </ComposerPrimitive.Send>
      </AuiIf>
      <AuiIf condition={(s: any) => s.thread.isRunning}>
        <ComposerPrimitive.Cancel asChild>
          <Button
            type="button"
            variant="default"
            size="icon"
            className="composerCancel"
            aria-label="Stop generating"
          >
            <SquareIcon className="composerCancelIcon" />
          </Button>
        </ComposerPrimitive.Cancel>
      </AuiIf>
    </div>
  );
};
