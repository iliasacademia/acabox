import React, { useEffect } from 'react';
import { MarkdownText } from './markdown-text';
import { ToolFallback } from './tool-fallback';
import { ToolGroup } from './tool-group';
import { TodoWrite } from './todo-write';
import { EnterPlanMode } from './enter-plan-mode';
import { Reasoning } from './thinking-indicator';
import { ChatComposer } from './chat-composer';
import { useProcessingLabel } from '../../progressStore';
import { useSetupState } from '../../setupStore';
import { MSymbol } from '../command-desk/MSymbol';
import {
  AttachmentPrimitive,
  AuiIf,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from '@assistant-ui/react';
import type { FC } from 'react';

/**
 * The Command Desk chat thread (Phase B design). Two variants share the same
 * components: `full` (760px centered column, docked global composer lives
 * outside) and `panel` (the narrow side-panel thread with its own composer).
 */

interface ThreadProps {
  variant?: 'full' | 'panel';
  turnAnchor?: 'top' | 'bottom';
  autoScroll?: boolean;
  scrollToBottomOnRunStart?: boolean;
  scrollToBottomOnThreadSwitch?: boolean;
  scrollToBottomOnInitialize?: boolean;
  hideComposer?: boolean;
}

export const Thread: FC<ThreadProps> = ({
  variant = 'panel',
  // Bottom-anchor (Phase B spec): short threads sit just above the composer;
  // the jump pill only appears when the user scrolls up in a long thread.
  turnAnchor = 'bottom',
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
      className="cdThreadViewport"
    >
      <AuiIf condition={(s: any) => s.thread.isEmpty}>
        <ThreadEmpty variant={variant} />
      </AuiIf>

      <div className="cdThreadCol">
        <ThreadPrimitive.Messages>
          {() => <ThreadMessage />}
        </ThreadPrimitive.Messages>
      </div>

      <ThreadPrimitive.ViewportFooter className="cdThreadFooter">
        <div className="cdJumpWrap">
          <ThreadPrimitive.ScrollToBottom asChild>
            <button type="button" className="cdJumpPill">
              <MSymbol name="arrow_downward" size={14} />
              Jump to latest
            </button>
          </ThreadPrimitive.ScrollToBottom>
        </div>
        {!hideComposer && <ChatComposer />}
      </ThreadPrimitive.ViewportFooter>
    </ThreadPrimitive.Viewport>
  );

  return (
    <ThreadPrimitive.Root className={`cdThread${variant === 'panel' ? ' cdThread--narrow' : ''}`}>
      {hideComposer ? viewport : (
        <ComposerPrimitive.AttachmentDropzone className="cdThreadDropzone">
          {viewport}
        </ComposerPrimitive.AttachmentDropzone>
      )}
    </ThreadPrimitive.Root>
  );
};

/* ── Empty state ─────────────────────────────────────────────────── */

const EMPTY_CHIPS: { label: string; prompt: string }[] = [
  {
    label: 'Turn a script into an app',
    prompt: 'Turn one of my analysis scripts into a small app I can run here.',
  },
  {
    label: "What's in my folders?",
    prompt: 'Give me an overview of the research files in my shared folders.',
  },
  {
    label: 'Build a PDF → BibTeX tool',
    prompt: 'Build me a tool that turns paper PDFs into clean BibTeX entries.',
  },
];

const ThreadEmpty: FC<{ variant: 'full' | 'panel' }> = ({ variant }) => {
  const setup = useSetupState();

  // Design: the composer arrives focused on a brand-new chat.
  useEffect(() => {
    if (variant === 'full') {
      window.dispatchEvent(new CustomEvent('cd:focus-composer'));
    }
  }, [variant]);

  if (setup.state === 'downloading') {
    return (
      <div className="cdChatEmpty">
        <span className="cdChatEmpty__title">{setup.message || 'Setting up environment…'}</span>
        <div className="cdOnb__progressBar" style={{ width: 260, alignSelf: 'center' }}>
          <div className="cdOnb__progressFill" style={{ width: `${setup.percent}%` }} />
        </div>
        <span className="cdChatEmpty__sub">This may take a few minutes on first launch.</span>
      </div>
    );
  }

  if (variant === 'panel') {
    return (
      <div className="cdChatEmpty">
        <span className="cdChatEmpty__glyph">▸</span>
        <span className="cdChatEmpty__sub">Ask for the next change — it lands in this tool.</span>
      </div>
    );
  }

  return (
    <div className="cdChatEmpty">
      <span className="cdChatEmpty__glyph">▸</span>
      <span className="cdChatEmpty__title">Where to?</span>
      <span className="cdChatEmpty__sub">Describe a tool, paste a repo, or drop files — it takes it from there.</span>
      <div className="cdChatEmpty__chips">
        {EMPTY_CHIPS.map((chip) => (
          <button
            key={chip.label}
            type="button"
            className="cdChip"
            onClick={() => {
              window.dispatchEvent(new CustomEvent('cd:fill-composer', { detail: { text: chip.prompt } }));
            }}
          >
            {chip.label}
          </button>
        ))}
      </div>
    </div>
  );
};

/* ── Messages ────────────────────────────────────────────────────── */

const ThreadMessage: FC = () => {
  const role = useAuiState((s: any) => s.message.role);
  return (
    <>
      <DaySeparator />
      {role === 'user' ? <UserMessage /> : <AssistantMessage />}
    </>
  );
};

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "WED JUL 23" */
function formatDayLabel(d: Date): string {
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
  const month = d.toLocaleDateString('en-US', { month: 'short' });
  return `${weekday} ${month} ${d.getDate()}`.toUpperCase();
}

/** "14:02", prefixed with the weekday when not today: "TUE 14:02". */
function formatMsgTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay(d, new Date())) return `${hh}:${mm}`;
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
  return `${weekday} ${hh}:${mm}`;
}

/** Hairline day separator rendered above the first message of each new day. */
const DaySeparator: FC = () => {
  const label = useAuiState((s: any) => {
    const createdAt = s.message?.createdAt as Date | undefined;
    if (!createdAt) return null;
    const msgs = s.thread?.messages as any[] | undefined;
    if (!msgs) return null;
    const idx = msgs.findIndex((m) => m.id === s.message.id);
    if (idx <= 0) return null;
    const prev = msgs[idx - 1]?.createdAt as Date | undefined;
    if (!prev) return null;
    return sameDay(new Date(prev), new Date(createdAt)) ? null : formatDayLabel(new Date(createdAt));
  }) as string | null;

  if (!label) return null;
  return (
    <div className="cdDaySep">
      <span className="cdDaySep__label">{label}</span>
    </div>
  );
};

/* ── User message ────────────────────────────────────────────────── */

function attachmentIcon(contentType: string | undefined, name: string): string {
  const ct = contentType ?? '';
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ct.includes('pdf') || ext === 'pdf') return 'picture_as_pdf';
  if (ct.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['csv', 'tsv', 'xlsx', 'xls'].includes(ext)) return 'table_chart';
  if (['py', 'r', 'js', 'ts', 'sh', 'ipynb'].includes(ext)) return 'code';
  return 'draft';
}

/** File sizes the way the design shows them: "3.1M". */
function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)}K`;
  const mb = kb / 1024;
  if (mb < 1024) return mb < 10 ? `${mb.toFixed(1)}M` : `${Math.round(mb)}M`;
  return `${(mb / 1024).toFixed(1)}G`;
}

const UserAttachment: FC = () => {
  const attachment = useAuiState((s: any) => s.attachment);
  const name: string = attachment?.name ?? 'file';
  const size: number | undefined = attachment?.file?.size;
  return (
    <AttachmentPrimitive.Root className="cdUser__file">
      <MSymbol name={attachmentIcon(attachment?.contentType, name)} size={14} />
      <span className="cdUser__fileName">{name}</span>
      {typeof size === 'number' && size > 0 && (
        <span className="cdUser__fileMeta">{formatAttachmentSize(size)}</span>
      )}
    </AttachmentPrimitive.Root>
  );
};

const userAttachmentComponents = {
  Image: UserAttachment,
  Document: UserAttachment,
  File: UserAttachment,
  Attachment: UserAttachment,
};

const UserMessage: FC = () => {
  const createdAt = useAuiState((s: any) => s.message.createdAt) as Date | undefined;
  const hasAttachments = useAuiState((s: any) => (s.message.attachments?.length ?? 0) > 0);
  return (
    <MessagePrimitive.Root className="cdUser" data-role="user">
      <div className="cdUser__bubble">
        <MessagePrimitive.Parts />
        {hasAttachments && (
          <div className="cdUser__files">
            <MessagePrimitive.Attachments components={userAttachmentComponents} />
          </div>
        )}
      </div>
      {createdAt && <span className="cdUser__time">{formatMsgTime(new Date(createdAt))}</span>}
    </MessagePrimitive.Root>
  );
};

/* ── Assistant message ───────────────────────────────────────────── */

/**
 * The working indicator: turn started but nothing else is visually in
 * progress (no streaming text, no running tool card, no active thinking).
 * `THINKING…` by default; upgraded to the live action when main reports one.
 */
const WorkingIndicator: FC = () => {
  const show = useAuiState((s: any) => {
    if (!s.message.isLast || s.message.status?.type !== 'running') return false;
    const parts = s.message.parts;
    if (!parts || parts.length === 0) return true;
    return parts[parts.length - 1].status?.type !== 'running';
  });
  const customLabel = useProcessingLabel();
  if (!show) return null;
  return (
    <div className="cdWorking">
      <span className="cdDot cdDot--busy cdDot--pulse" />
      <span className="cdWorking__label">
        {customLabel ? `WORKING — ${customLabel}` : 'THINKING…'}
      </span>
    </div>
  );
};

const MessageError: FC = () => {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="cdMsgError">
        <ErrorPrimitive.Message />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
};

/** Mono meta line closing a completed assistant message: `3 TOOL CALLS · 09:14`. */
const AssistantMeta: FC = () => {
  const meta = useAuiState((s: any) => {
    if (s.message.status?.type === 'running') return null;
    const parts = s.message.parts ?? [];
    const toolCalls = parts.filter((p: any) => p.type === 'tool-call').length;
    const createdAt = s.message.createdAt as Date | undefined;
    const segments: string[] = [];
    if (toolCalls > 0) segments.push(`${toolCalls} TOOL CALL${toolCalls === 1 ? '' : 'S'}`);
    if (createdAt) segments.push(formatMsgTime(new Date(createdAt)));
    return segments.length > 0 ? segments.join(' · ') : null;
  }) as string | null;

  if (!meta) return null;
  return <span className="cdAsst__meta">{meta}</span>;
};

const AssistantMessage: FC = () => {
  // While the last part is actively streaming text, a 7px pulsing dot trails
  // the last token (CSS ::after on the last markdown block).
  const streamingText = useAuiState((s: any) => {
    if (s.message.status?.type !== 'running') return false;
    const parts = s.message.parts;
    if (!parts || parts.length === 0) return false;
    const last = parts[parts.length - 1];
    return last.type === 'text' && last.status?.type === 'running';
  });

  return (
    <MessagePrimitive.Root
      className={`cdAsst${streamingText ? ' cdAsst--streaming' : ''}`}
      data-role="assistant"
    >
      <div className="cdAsst__parts">
        <MessagePrimitive.Parts
          components={{
            Text: MarkdownText,
            Reasoning,
            tools: { Fallback: ToolFallback, TodoWrite, EnterPlanMode },
            ToolGroup,
          }}
        />
        <WorkingIndicator />
        <MessageError />
      </div>
      <AssistantMeta />
    </MessagePrimitive.Root>
  );
};
