import React from 'react';
import { MarkdownText } from './markdown-text';
import { ToolFallback } from './tool-fallback';
import { ToolGroup } from './tool-group';
import { TodoWrite } from './todo-write';
import { Reasoning } from './thinking-indicator';
import { ModelSelector } from '../ModelSelector';
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
  ArrowUpIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  PaperclipIcon,
  PencilIcon,
  RefreshCwIcon,
  SquareIcon,
  XIcon,
} from 'lucide-react';
import type { FC } from 'react';

export const Thread: FC = () => {
  return (
    <ThreadPrimitive.Root className="threadRoot">
      <ComposerPrimitive.AttachmentDropzone className="threadDropzone">
        <ThreadPrimitive.Viewport
          turnAnchor="top"
          className="threadViewport"
        >
          <AuiIf condition={(s: any) => s.thread.isEmpty}>
            <ThreadWelcome />
          </AuiIf>

          <ThreadPrimitive.Messages>
            {() => <ThreadMessage />}
          </ThreadPrimitive.Messages>

          <ThreadPrimitive.ViewportFooter className="threadViewportFooter">
            <ThreadScrollToBottom />
            <Composer />
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </ComposerPrimitive.AttachmentDropzone>
    </ThreadPrimitive.Root>
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

const ComposerImageAttachment: FC = () => {
  const attachment = useAuiState((s: any) => s.attachment);
  const imageSrc = attachment?.content?.find((p: any) => p.type === 'image')?.image
    ?? (attachment?.file ? URL.createObjectURL(attachment.file) : undefined);
  return (
    <AttachmentPrimitive.Root className="composerImageAttachment">
      {imageSrc && <img src={imageSrc} alt={attachment?.name} className="composerImagePreview" />}
      <AttachmentPrimitive.Remove asChild>
        <TooltipIconButton
          tooltip="Remove"
          variant="ghost"
          size="icon"
          className="composerImageRemove"
        >
          <XIcon />
        </TooltipIconButton>
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
};

const ComposerDocumentAttachment: FC = () => {
  return (
    <AttachmentPrimitive.Root className="composerAttachmentItem">
      <AttachmentPrimitive.unstable_Thumb className="composerAttachmentThumb" />
      <span className="composerAttachmentName"><AttachmentPrimitive.Name /></span>
      <AttachmentPrimitive.Remove asChild>
        <TooltipIconButton
          tooltip="Remove"
          variant="ghost"
          size="icon"
          className="composerAttachmentRemove"
        >
          <XIcon />
        </TooltipIconButton>
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
};

const Composer: FC = () => {
  return (
    <ComposerPrimitive.Root className="composerRoot">
      <ComposerPrimitive.Attachments
        components={{
          Image: ComposerImageAttachment,
          Document: ComposerDocumentAttachment,
          File: ComposerDocumentAttachment,
          Attachment: ComposerDocumentAttachment,
        }}
      />
      <div className="composerShell">
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
        <ComposerPrimitive.Input
          placeholder="Send a message..."
          className="composerInput"
          rows={1}
          autoFocus
          aria-label="Message input"
        />
        <ModelSelector />
        <ComposerAction />
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
            <ArrowUpIcon className="composerSendIcon" />
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
            tools: { Fallback: ToolFallback, TodoWrite },
            ToolGroup,
          }}
        />
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
