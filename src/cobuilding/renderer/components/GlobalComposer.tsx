import React, { useEffect, useRef } from 'react';
import {
  ThreadPrimitive,
  ComposerPrimitive,
  AuiIf,
  useThreadRuntime,
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

interface GlobalComposerProps {
  isInChatDetail: boolean;
  onNavigateToChat: () => void;
}

export const GlobalComposer: FC<GlobalComposerProps> = ({
  isInChatDetail,
  onNavigateToChat,
}) => {
  return (
    <div className="globalComposer">
      <div className="globalComposerInner">
        <ThreadPrimitive.Root>
          <NavigateOnSend isInChatDetail={isInChatDetail} onNavigateToChat={onNavigateToChat} />
          <ComposerBody />
        </ThreadPrimitive.Root>
      </div>
    </div>
  );
};

/**
 * Subscribes to thread message count changes. When a message appears on a
 * previously-empty thread while not in chat detail, navigates to the chat view.
 */
function NavigateOnSend({ isInChatDetail, onNavigateToChat }: GlobalComposerProps) {
  const threadRuntime = useThreadRuntime();
  const isInChatDetailRef = useRef(isInChatDetail);
  isInChatDetailRef.current = isInChatDetail;
  const onNavigateRef = useRef(onNavigateToChat);
  onNavigateRef.current = onNavigateToChat;

  useEffect(() => {
    let prevEmpty = threadRuntime.getState().messages.length === 0;
    return threadRuntime.subscribe(() => {
      const nowEmpty = threadRuntime.getState().messages.length === 0;
      if (prevEmpty && !nowEmpty && !isInChatDetailRef.current) {
        onNavigateRef.current();
      }
      prevEmpty = nowEmpty;
    });
  }, [threadRuntime]);

  return null;
}

const ComposerBody: FC = () => {
  return (
    <ComposerPrimitive.Root className="composerRoot">
      <ComposerPrimitive.Attachments components={composerAttachmentComponents} />
      <div className="composerShell">
        <ComposerPrimitive.Input
          placeholder="Ask, draft, analyze, or just say what you're working on..."
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
