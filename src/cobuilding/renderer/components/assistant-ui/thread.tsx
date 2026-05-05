import React, { useEffect, useState } from 'react';
import { MarkdownText } from './markdown-text';
import { ToolFallback } from './tool-fallback';
import { ToolGroup } from './tool-group';
import { TodoWrite } from './todo-write';
import { EnterPlanMode } from './enter-plan-mode';
import { Reasoning } from './thinking-indicator';
import { composerAttachmentComponents } from './composer-attachments';
import { ModelSelector } from '../ModelSelector';
import { useProcessingLabel } from '../../progressStore';
import { useSetupState } from '../../setupStore';
import { TooltipIconButton } from './tooltip-icon-button';
import { Button } from '../ui/button';
import {
  ActionBarPrimitive,
  AttachmentPrimitive,
  AuiIf,
  BranchPickerPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from '@assistant-ui/react';
import {
  ArrowDownIcon,
  SendIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  FileTextIcon,
  LoaderIcon,
  PaperclipIcon,
  PencilIcon,
  RefreshCwIcon,
  SquareIcon,
} from 'lucide-react';
import type { FC } from 'react';

interface ThreadProps {
  turnAnchor?: 'top' | 'bottom';
  autoScroll?: boolean;
  scrollToBottomOnRunStart?: boolean;
  scrollToBottomOnThreadSwitch?: boolean;
  scrollToBottomOnInitialize?: boolean;
  hideComposer?: boolean;
}

export const Thread: FC<ThreadProps> = ({
  turnAnchor = 'top',
  autoScroll,
  scrollToBottomOnRunStart,
  scrollToBottomOnThreadSwitch = true,
  scrollToBottomOnInitialize = true,
  hideComposer,
}) => {
  const viewport = (
    <ThreadPrimitive.Viewport
      turnAnchor={turnAnchor}
      autoScroll={autoScroll}
      scrollToBottomOnRunStart={scrollToBottomOnRunStart}
      scrollToBottomOnThreadSwitch={scrollToBottomOnThreadSwitch}
      scrollToBottomOnInitialize={scrollToBottomOnInitialize}
      className="threadViewport"
    >
      <div className={`threadContent${hideComposer ? ' threadContent--withGlobalComposer' : ''}`}>
        <AuiIf condition={(s: any) => s.thread.isEmpty}>
          <ThreadWelcome />
        </AuiIf>

        <ThreadPrimitive.Messages>
          {() => <ThreadMessage />}
        </ThreadPrimitive.Messages>
      </div>

      {!hideComposer && (
        <ThreadPrimitive.ViewportFooter className="threadViewportFooter">
          <ThreadScrollToBottom />
          <Composer />
        </ThreadPrimitive.ViewportFooter>
      )}
    </ThreadPrimitive.Viewport>
  );

  return (
    <ThreadPrimitive.Root className="threadRoot">
      <ThreadDocumentHeader />
      {hideComposer ? viewport : (
        <ComposerPrimitive.AttachmentDropzone className="threadDropzone">
          {viewport}
        </ComposerPrimitive.AttachmentDropzone>
      )}
    </ThreadPrimitive.Root>
  );
};

const ThreadDocumentHeader: FC = () => {
  const remoteId = useAuiState((s: any) => s.threadListItem?.remoteId) as string | undefined;
  const [documentPath, setDocumentPath] = useState<string | null>(null);

  useEffect(() => {
    if (!remoteId) { setDocumentPath(null); return; }
    let cancelled = false;
    window.sessionsAPI.get(remoteId).then((session) => {
      if (cancelled) return;
      setDocumentPath(session?.document_path ?? null);
    }).catch(() => { if (!cancelled) setDocumentPath(null); });
    return () => { cancelled = true; };
  }, [remoteId]);

  if (!documentPath) return null;
  const filename = documentPath.split('/').pop() || documentPath;

  return (
    <div className="threadDocumentHeader" title={documentPath}>
      <FileTextIcon className="threadDocumentHeaderIcon" />
      <span className="threadDocumentHeaderName">{filename}</span>
    </div>
  );
};

const ThreadMessage: FC = () => {
  const role = useAuiState((s: any) => s.message.role);
  const isEditing = useAuiState((s: any) => s.message.composer.isEditing);
  if (isEditing) return <EditComposer />;
  if (role === 'user') return <UserMessage />;
  return <AssistantMessage />;
};

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        variant="outline"
        className="scrollToBottom"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const ThreadWelcome: FC = () => {
  const setup = useSetupState();

  if (setup.state === 'downloading') {
    return (
      <div className="threadWelcome">
        <div className="threadWelcomeCenter">
          <div className="setupCenterBlock">
            <h1 className="setupCenterTitle">{setup.message || 'Setting up environment...'}</h1>
            <div className="setupCenterProgress">
              <div className="setupCenterProgressBar" style={{ width: `${setup.percent}%` }} />
            </div>
            <p className="setupCenterSubtitle">This may take a few minutes on first launch.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="threadWelcome">
      <div className="threadWelcomeCenter">
        <div className="threadWelcomeMessage">
          <h1 className="threadWelcomeTitle">Hello there!</h1>
          <p className="threadWelcomeSubtitle">
            How can I help you today?
          </p>
        </div>
      </div>
    </div>
  );
};


const Composer: FC = () => {
  const setup = useSetupState();
  const isEmpty = useAuiState((s: any) => s.thread.isEmpty);

  // When the thread is empty, the centered ThreadWelcome handles the setup
  // indicator — don't duplicate it in the composer. For existing threads,
  // replace the input with the setup indicator.
  if ((setup.state === 'downloading') && !isEmpty) {
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

  // Empty thread + setup in progress — centered indicator handles it, hide composer entirely
  if ((setup.state === 'downloading') && isEmpty) {
    return null;
  }

  return (
    <ComposerPrimitive.Root className="composerRoot">
      <ComposerPrimitive.Attachments components={composerAttachmentComponents} />
      <div className="composerShell">
        <ComposerPrimitive.Input
          placeholder="Send a message..."
          className="composerInput"
          rows={1}
          autoFocus
          aria-label="Message input"
        />
        <div className="composerToolbar">
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
          <ModelSelector />
          <ComposerAction />
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC = () => {
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

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="messageError">
        <ErrorPrimitive.Message className="messageErrorText" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

/** Shows "Processing" only in the gap when the agent is working but nothing else
 *  is visually in progress (no active thinking block, no running tool call). */
const ProcessingIndicator: FC = () => {
  const show = useAuiState((s: any) => {
    if (!s.message.isLast || s.message.status?.type !== 'running') return false;
    const parts = s.message.parts;
    if (!parts || parts.length === 0) return true;
    // If the last part is still actively streaming/executing, another indicator is visible
    return parts[parts.length - 1].status?.type !== 'running';
  });
  const customLabel = useProcessingLabel();
  if (!show) return null;
  return (
    <div className="processingIndicator">
      <LoaderIcon className="processingIndicatorIcon" />
      <span className="processingIndicatorLabel">{customLabel || 'Processing'}</span>
    </div>
  );
};

const AssistantMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      className="assistantMessage"
      data-role="assistant"
    >
      <div className="assistantMessageContent">
        <MessagePrimitive.Parts
          components={{
            Text: MarkdownText,
            Reasoning,
            tools: { Fallback: ToolFallback, TodoWrite, EnterPlanMode },
            ToolGroup,
          }}
        />
        <ProcessingIndicator />
        <MessageError />
      </div>

      <div className="assistantMessageFooter">
        <BranchPicker />
        <AssistantActionBar />
      </div>
    </MessagePrimitive.Root>
  );
};

const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="assistantActionBar"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy">
          <AuiIf condition={(s: any) => s.message.isCopied}>
            <CheckIcon />
          </AuiIf>
          <AuiIf condition={(s: any) => !s.message.isCopied}>
            <CopyIcon />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip="Regenerate response">
          <RefreshCwIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
    </ActionBarPrimitive.Root>
  );
};

const UserImageAttachment: FC = () => {
  const attachment = useAuiState((s: any) => s.attachment);
  const imageSrc = attachment?.content?.find((p: any) => p.type === 'image')?.image;
  if (!imageSrc) {
    return (
      <AttachmentPrimitive.Root className="userAttachmentItem">
        <span className="userAttachmentName"><AttachmentPrimitive.Name /></span>
      </AttachmentPrimitive.Root>
    );
  }
  return (
    <AttachmentPrimitive.Root className="userImageAttachment">
      <img src={imageSrc} alt={attachment?.name} className="userImagePreview" />
    </AttachmentPrimitive.Root>
  );
};

const UserDocumentAttachment: FC = () => {
  return (
    <AttachmentPrimitive.Root className="userAttachmentItem">
      <AttachmentPrimitive.unstable_Thumb className="userAttachmentThumb" />
      <span className="userAttachmentName"><AttachmentPrimitive.Name /></span>
    </AttachmentPrimitive.Root>
  );
};

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      className="userMessage"
      data-role="user"
    >
      <div className="userMessageContentWrapper">
        <div className="userMessageBubble">
          <MessagePrimitive.Attachments
            components={{
              Image: UserImageAttachment,
              Document: UserDocumentAttachment,
              File: UserDocumentAttachment,
              Attachment: UserDocumentAttachment,
            }}
          />
          <MessagePrimitive.Parts />
        </div>
        <div className="userActionBarWrapper">
          <UserActionBar />
        </div>
      </div>

      <BranchPicker className="userBranchPicker" />
    </MessagePrimitive.Root>
  );
};

const UserActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="userActionBar"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip="Edit" className="userActionEdit">
          <PencilIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
};

const EditComposer: FC = () => {
  return (
    <MessagePrimitive.Root className="editComposerWrapper">
      <ComposerPrimitive.Root className="editComposerRoot">
        <ComposerPrimitive.Input
          className="editComposerInput"
          autoFocus
        />
        <div className="editComposerFooter">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm">
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm">Update</Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

const BranchPicker: FC<BranchPickerPrimitive.Root.Props> = ({
  className,
  ...rest
}) => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={`branchPicker${className ? ` ${className}` : ''}`}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="Previous">
          <ChevronLeftIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="branchPickerState">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="Next">
          <ChevronRightIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};
