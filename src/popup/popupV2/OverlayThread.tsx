/**
 * Simplified Thread component for the Word overlay popup.
 *
 * Reuses the same message part renderers as the desktop app (MarkdownText,
 * Reasoning, ToolFallback, ToolGroup) for identical message rendering,
 * but has a simpler composer without ModelSelector or file attachments.
 */

import React, { createContext, useContext, memo, useState } from 'react';
import type { FC } from 'react';
import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from '@assistant-ui/react';
import {
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
  type CodeHeaderProps,
} from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import { TooltipProvider } from '../../cobuilding/renderer/components/ui/tooltip';
import { ToolFallback } from '../../cobuilding/renderer/components/assistant-ui/tool-fallback';
import { ToolGroup } from '../../cobuilding/renderer/components/assistant-ui/tool-group';
import { Reasoning } from '../../cobuilding/renderer/components/assistant-ui/thinking-indicator';
import { serverUrl, tokenParam } from './shared';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CopyIcon,
  LoaderIcon,
  RefreshCwIcon,
  SquareIcon,
} from 'lucide-react';

// ─── Overlay MarkdownText with word-ref: link support ──────────────

function scrollWordToText(text: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (tokenParam) headers['Authorization'] = `Bearer ${tokenParam}`;
  fetch(`${serverUrl}/api/cobuilding/word/scroll-to`, {
    method: 'POST', headers,
    body: JSON.stringify({ text }),
  }).catch(() => {});
}

const useCopyToClipboard = ({ copiedDuration = 3000 }: { copiedDuration?: number } = {}) => {
  const [isCopied, setIsCopied] = useState(false);
  const copyToClipboard = (value: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), copiedDuration);
    });
  };
  return { isCopied, copyToClipboard };
};

const OverlayCodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  return (
    <div className="codeHeaderRoot">
      <span className="codeHeaderLanguage">{language}</span>
      <button className="iconBtn" onClick={() => code && copyToClipboard(code)}>
        {isCopied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      </button>
    </div>
  );
};

const overlayComponents = memoizeMarkdownComponents({
  a: ({ href, children, ...props }) => {
    const isWordRef = href?.startsWith('word-ref:');
    return (
      <a
        {...props}
        href={href}
        style={isWordRef ? { color: '#0645b1', cursor: 'pointer', textDecoration: 'underline' } : undefined}
        onClick={(e) => {
          e.preventDefault();
          if (isWordRef) {
            scrollWordToText(href!.substring('word-ref:'.length));
          } else if (href) {
            window.open(href, '_blank');
          }
        }}
      >
        {children}
      </a>
    );
  },
  code: function Code({ className, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    return <code className={`${!isCodeBlock ? 'inlineCode' : ''}${className ? ` ${className}` : ''}`} {...props} />;
  },
  CodeHeader: OverlayCodeHeader,
});

const OverlayMarkdownText = memo(() => {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className="auiMd"
      components={overlayComponents}
    />
  );
});

interface OverlayContextPills {
  documentPath?: string | null;
  selectedText?: string | null;
  onDismissSelection?: () => void;
}

const PillsContext = createContext<OverlayContextPills>({});

export const OverlayThread: FC<OverlayContextPills> = ({ documentPath, selectedText, onDismissSelection }) => {
  return (
    <PillsContext.Provider value={{ documentPath, selectedText, onDismissSelection }}>
    <TooltipProvider>
      <ThreadPrimitive.Root className="threadRoot">
        <ThreadPrimitive.Viewport
          turnAnchor="top"
          scrollToBottomOnThreadSwitch
          scrollToBottomOnInitialize
          className="threadViewport"
        >
          <AuiIf condition={(s: any) => s.thread.isEmpty}>
            <div className="threadWelcome">
              <div className="threadWelcomeCenter">
                <div className="threadWelcomeMessage">
                  <p className="threadWelcomeSubtitle">Ask about your document</p>
                </div>
              </div>
            </div>
          </AuiIf>

          <ThreadPrimitive.Messages>
            {() => <OverlayThreadMessage />}
          </ThreadPrimitive.Messages>

          <ThreadPrimitive.ViewportFooter className="threadViewportFooter">
            <ThreadPrimitive.ScrollToBottom asChild>
              <button className="scrollToBottom" aria-label="Scroll to bottom">
                <ArrowDownIcon size={16} />
              </button>
            </ThreadPrimitive.ScrollToBottom>
            <OverlayComposer />
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </TooltipProvider>
    </PillsContext.Provider>
  );
};

const OverlayThreadMessage: FC = () => {
  const role = useAuiState((s: any) => s.message.role);
  if (role === 'user') return <OverlayUserMessage />;
  return <OverlayAssistantMessage />;
};

const ProcessingIndicator: FC = () => {
  const show = useAuiState((s: any) => {
    if (!s.message.isLast || s.message.status?.type !== 'running') return false;
    const parts = s.message.parts;
    if (!parts || parts.length === 0) return true;
    return parts[parts.length - 1].status?.type !== 'running';
  });
  if (!show) return null;
  return (
    <div className="processingIndicator">
      <LoaderIcon className="processingIndicatorIcon" />
      <span className="processingIndicatorLabel">Processing</span>
    </div>
  );
};

const OverlayAssistantMessage: FC = () => {
  return (
    <MessagePrimitive.Root className="assistantMessage" data-role="assistant">
      <div className="assistantMessageContent">
        <MessagePrimitive.Parts
          components={{
            Text: OverlayMarkdownText,
            Reasoning,
            tools: { Fallback: ToolFallback },
            ToolGroup,
          }}
        />
        <ProcessingIndicator />
        <MessagePrimitive.Error>
          <ErrorPrimitive.Root className="messageError">
            <ErrorPrimitive.Message className="messageErrorText" />
          </ErrorPrimitive.Root>
        </MessagePrimitive.Error>
      </div>
      <div className="assistantMessageFooter">
        <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="assistantActionBar">
          <ActionBarPrimitive.Copy asChild>
            <button className="iconBtn" aria-label="Copy">
              <AuiIf condition={(s: any) => s.message.isCopied}><CheckIcon size={14} /></AuiIf>
              <AuiIf condition={(s: any) => !s.message.isCopied}><CopyIcon size={14} /></AuiIf>
            </button>
          </ActionBarPrimitive.Copy>
          <ActionBarPrimitive.Reload asChild>
            <button className="iconBtn" aria-label="Regenerate">
              <RefreshCwIcon size={14} />
            </button>
          </ActionBarPrimitive.Reload>
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
};

const OverlayUserMessage: FC = () => {
  return (
    <MessagePrimitive.Root className="userMessage" data-role="user">
      <div className="userMessageContentWrapper">
        <div className="userMessageBubble">
          <MessagePrimitive.Parts />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
};

const OverlayComposer: FC = () => {
  const { selectedText, onDismissSelection } = useContext(PillsContext);

  return (
    <ComposerPrimitive.Root className="composerRoot">
      {/* Selected text bar — matches Claude for Word style */}
      {selectedText && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          padding: '8px 12px',
          borderBottom: '1px solid #e5e7eb',
          fontFamily: "'DM Sans', sans-serif", fontSize: '14px', color: '#374151',
        }}>
          <span style={{
            flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            "{selectedText.length > 50 ? selectedText.substring(0, 50) + '...' : selectedText}" selected
          </span>
          <button
            onClick={onDismissSelection}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '2px', fontSize: '16px', lineHeight: '1',
              color: '#6b7280', flexShrink: 0,
            }}
            aria-label="Clear selection"
          >
            ✕
          </button>
        </div>
      )}
      <div className="composerShell">
        <ComposerPrimitive.Input
          placeholder={selectedText ? 'Reply' : 'Send a message...'}
          className="composerInput"
          rows={1}
          autoFocus
          aria-label="Message input"
        />
        <div className="composerToolbar">
          <div className="composerActions">
            <AuiIf condition={(s: any) => !s.thread.isRunning}>
              <ComposerPrimitive.Send asChild>
                <button className="composerSend" aria-label="Send message">
                  <ArrowUpIcon className="composerSendIcon" />
                </button>
              </ComposerPrimitive.Send>
            </AuiIf>
            <AuiIf condition={(s: any) => s.thread.isRunning}>
              <ComposerPrimitive.Cancel asChild>
                <button className="composerCancel" aria-label="Stop generating">
                  <SquareIcon className="composerCancelIcon" />
                </button>
              </ComposerPrimitive.Cancel>
            </AuiIf>
          </div>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
};
