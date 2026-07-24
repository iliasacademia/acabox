import React, { useEffect, useRef } from 'react';
import {
  ThreadPrimitive,
  ComposerPrimitive,
  AuiIf,
  useAuiState,
  useComposerRuntime,
} from '@assistant-ui/react';
import { composerAttachmentComponents } from './assistant-ui/composer-attachments';
import { ModelSelector } from './ModelSelector';
import { MSymbol } from './command-desk/MSymbol';
import type { FC } from 'react';

/**
 * Universal composer docked at the bottom of the content column (Command Desk
 * spec), rendered on every page that isn't settings/debug/tool-detail.
 *
 * Navigation to chat detail on send is handled by the chatAdapter's `onSend`
 * callback (see `useElectronChatAdapter` in chatAdapter.ts), not here. That way
 * every send — regardless of where it was initiated — produces a deterministic,
 * synchronous navigation, instead of relying on a state-subscription watcher
 * that could miss the 0→1 message-count transition under remount or
 * suppressed-reset conditions.
 */
export const GlobalComposer: FC = () => {
  const dockRef = useRef<HTMLDivElement>(null);

  // The home screen's "Build a new tool" card focuses the composer via this
  // window event (design: "Click focuses the composer").
  useEffect(() => {
    const handler = () => dockRef.current?.querySelector('textarea')?.focus();
    window.addEventListener('cd:focus-composer', handler);
    return () => window.removeEventListener('cd:focus-composer', handler);
  }, []);

  return (
    <div className="cdComposerDock" ref={dockRef}>
      <ThreadPrimitive.Root>
        <ComposerBody />
      </ThreadPrimitive.Root>
    </div>
  );
};

const ComposerBody: FC = () => {
  const composerRuntime = useComposerRuntime();
  const isEmpty = useAuiState((s: any) => s.thread?.isEmpty ?? true) as boolean;

  // Empty-state suggestion chips fill the composer (design: "clicking fills
  // the composer") — they don't auto-send.
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent<{ text: string }>).detail?.text;
      if (!text) return;
      composerRuntime.setText(text);
      window.dispatchEvent(new CustomEvent('cd:focus-composer'));
    };
    window.addEventListener('cd:fill-composer', handler);
    return () => window.removeEventListener('cd:fill-composer', handler);
  }, [composerRuntime]);

  return (
    <ComposerPrimitive.Root className="cdComposerRoot">
      <ComposerPrimitive.Attachments components={composerAttachmentComponents} />
      <div className="cdComposerField">
        <span className="cdComposerGlyph">▸</span>
        <ComposerPrimitive.Input
          placeholder={
            isEmpty
              ? 'What are we building? — describe a tool, paste a repo, or ask'
              : 'Reply — or ask for the next change'
          }
          className="cdComposerInput"
          rows={1}
          autoFocus={false}
          aria-label="Message input"
        />
        <ComposerPrimitive.AddAttachment asChild>
          <button type="button" className="cdIconBtn" title="Attach file" aria-label="Attach file">
            <MSymbol name="attach_file" size={19} />
          </button>
        </ComposerPrimitive.AddAttachment>
        <ModelSelector />
        <AuiIf condition={(s: any) => !s.thread.isRunning}>
          <ComposerPrimitive.Send asChild>
            <button type="button" className="cdComposerSend" aria-label="Send message">
              <MSymbol name="arrow_upward" size={19} />
            </button>
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s: any) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel asChild>
            <button type="button" className="cdComposerSend" aria-label="Stop generating">
              <MSymbol name="stop" size={19} />
            </button>
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </div>
    </ComposerPrimitive.Root>
  );
};
