import React from 'react';
import {
  ThreadPrimitive,
  ComposerPrimitive,
  AuiIf,
} from '@assistant-ui/react';
import {
  SendIcon,
  PaperclipIcon,
  SquareIcon,
} from 'lucide-react';
import { composerAttachmentComponents } from './assistant-ui/composer-attachments';
import { TooltipIconButton } from './assistant-ui/tooltip-icon-button';
import { Button } from './ui/button';
import { ModelSelector } from './ModelSelector';
import type { FC } from 'react';

/**
 * Universal composer rendered on every page that isn't settings/debug/tool-detail.
 *
 * Navigation to chat detail on send is handled by the chatAdapter's `onSend`
 * callback (see `useElectronChatAdapter` in chatAdapter.ts), not here. That way
 * every send — regardless of where it was initiated — produces a deterministic,
 * synchronous navigation, instead of relying on a state-subscription watcher
 * that could miss the 0→1 message-count transition under remount or
 * suppressed-reset conditions.
 */
export const GlobalComposer: FC = () => {
  return (
    <div className="globalComposer">
      <div className="globalComposerInner">
        <ThreadPrimitive.Root>
          <ComposerBody />
        </ThreadPrimitive.Root>
      </div>
    </div>
  );
};

const ComposerBody: FC = () => {
  return (
    <ComposerPrimitive.Root className="composerRoot">
      <ComposerPrimitive.Attachments components={composerAttachmentComponents} />
      <div className="composerShell">
        <ComposerPrimitive.Input
          placeholder="What can I do for you?"
          className="composerInput"
          rows={1}
          autoFocus={false}
          aria-label="Message input"
        />
        <div className="composerToolbar">
          <ComposerPrimitive.AddAttachment asChild>
            <TooltipIconButton
              tooltip="Attach file"
              side="top"
              type="button"
              variant="ghost"
              size="icon"
              className="composerAttach"
            >
              <PaperclipIcon className="composerAttachIcon" />
            </TooltipIconButton>
          </ComposerPrimitive.AddAttachment>
          <ModelSelector />
          <div className="composerActions">
            <AuiIf condition={(s: any) => !s.thread.isRunning}>
              <ComposerPrimitive.Send asChild>
                <TooltipIconButton
                  tooltip="Send message"
                  side="top"
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
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
};
