/**
 * Thread component for the Word overlay popup.
 *
 * Reuses the same message part renderers AND the same composer as the
 * desktop chat — see `ChatComposer` (`assistant-ui/chat-composer.tsx`).
 * The overlay used to ship its own stripped-down composer (no model
 * picker, no attach button), but maintaining two parallel composers was
 * the same hazard that bit us with the parallel DOI rendering: features
 * and fixes drift. Now both surfaces use one component, and the only
 * overlay-specific thing — the "selected text" pill that shows what
 * passage the user picked in Word — is passed in as the composer's
 * `prefix` slot.
 */

import React, { createContext, useContext, memo, useState, useEffect, useRef } from 'react';
import type { FC } from 'react';
import {
  ActionBarPrimitive,
  AuiIf,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useComposerRuntime,
} from '@assistant-ui/react';
import {
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
  type CodeHeaderProps,
} from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import '../../cobuilding/renderer/components/WritingAgentView.css';
import { TooltipProvider } from '../../cobuilding/renderer/components/ui/tooltip';
import { ToolFallback } from '../../cobuilding/renderer/components/assistant-ui/tool-fallback';
import { ToolGroup } from '../../cobuilding/renderer/components/assistant-ui/tool-group';
import { Reasoning } from '../../cobuilding/renderer/components/assistant-ui/thinking-indicator';
import { ApprovalParagraph, ApprovalList, APPROVAL_CHOICES } from '../../cobuilding/renderer/components/assistant-ui/approval-buttons';
import { AnchorWithDoi, parseAgentHtml } from '../../cobuilding/renderer/components/assistant-ui/doi-link';
import { ChatComposer } from '../../cobuilding/renderer/components/assistant-ui/chat-composer';
import {
  ArrowDownIcon,
  CheckIcon,
  CopyIcon,
  LoaderIcon,
  RefreshCwIcon,
} from 'lucide-react';

// ─── Overlay MarkdownText ───────────────────────────────────────────

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


const DOI_RE = /\b10\.\d{4,9}\/[^\s\]<>"'(),]+/g;

// ─── DOI / Zotero rendering: shared with the desktop renderer ──────
//
// The stores, ZoteroAddRefButton, AnchorWithDoi, and parseAgentHtml live
// in doi-link.tsx and detect IPC vs HTTP at runtime so the same module
// works in both the Electron renderer and this WKWebView overlay. Until
// PR #434 there were two parallel copies, and the HTML-branch fix only
// landed in one — fix surface is now a single file.

function autolinkDoiText(text: string, keyPrefix: string): React.ReactNode {
  if (!text.includes('10.') || !text.includes('/')) return text;
  DOI_RE.lastIndex = 0;
  const matches = [...text.matchAll(DOI_RE)];
  if (matches.length === 0) return text;
  const out: React.ReactNode[] = [];
  let last = 0;
  matches.forEach((m, i) => {
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const doi = m[0].replace(/[.,;:]+$/, '');
    const url = `https://doi.org/${doi}`;
    out.push(
      <AnchorWithDoi key={`${keyPrefix}-ref-${i}`} href={url}>
        {doi}
      </AnchorWithDoi>,
    );
    last = start + doi.length;
  });
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function autolinkChildren(node: React.ReactNode, keyPrefix: string): React.ReactNode {
  if (typeof node === 'string') return autolinkDoiText(node, keyPrefix);
  if (Array.isArray(node)) return node.map((c, i) => autolinkChildren(c, `${keyPrefix}-${i}`));
  if (React.isValidElement(node)) {
    if (node.type === 'a' || node.type === 'code' || node.type === 'pre') return node;
    const props: any = node.props;
    // react-markdown maps anchor AST nodes to our `a:` override function, so the
    // element's `type` is the override (a function), not the string 'a'. Bail on
    // any element carrying an href so the autolinker doesn't add a second button
    // for the DOI string sitting inside the link's label.
    if (props && typeof props.href === 'string') return node;
    if (props && props.children !== undefined) {
      return React.cloneElement(node as any, undefined, autolinkChildren(props.children, `${keyPrefix}-c`));
    }
  }
  return node;
}

const ParagraphWithDoiLinks = (props: any) => (
  <ApprovalParagraph {...props}>{autolinkChildren(props.children, 'p')}</ApprovalParagraph>
);

const ListItemWithDoiLinks = (props: any) => (
  <li {...props}>{autolinkChildren(props.children, 'li')}</li>
);

const TableCellWithDoiLinks = (props: any) => (
  <td {...props}>{autolinkChildren(props.children, 'td')}</td>
);

const overlayComponents = memoizeMarkdownComponents({
  p: ParagraphWithDoiLinks as any,
  ul: ApprovalList as any,
  li: ListItemWithDoiLinks as any,
  td: TableCellWithDoiLinks as any,
  a: ({ href, children, ...props }) => (
    <AnchorWithDoi href={href} {...props}>{children}</AnchorWithDoi>
  ),
  code: function Code({ className, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    return <code className={`${!isCodeBlock ? 'inlineCode' : ''}${className ? ` ${className}` : ''}`} {...props} />;
  },
  CodeHeader: OverlayCodeHeader,
});

function looksLikeHtml(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('<') && /<\/?[a-z][\s\S]*>/i.test(trimmed);
}

const OverlayMarkdownText = memo(() => {
  const text = useAuiState((s: any) => {
    const parts = s.message?.parts;
    if (!parts) return null;
    const textParts = parts.filter((p: any) => p.type === 'text');
    return textParts.length > 0 ? textParts[textParts.length - 1]?.text : null;
  });

  // Same fix as markdown-text.tsx: writing-agent HTML responses go through
  // the shared parseAgentHtml, which sanitizes via DOMPurify and replaces
  // <a> nodes with AnchorWithDoi so the Zotero "+" button shows up here too.
  if (text && looksLikeHtml(text)) {
    return <div className="writingAgentHtml">{parseAgentHtml(text)}</div>;
  }

  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className="auiMd"
      components={overlayComponents}
    />
  );
});

/**
 * Programmatically dispatches a one-shot user message into the thread's
 * composer when `prompt` becomes non-empty. Exported so it can be mounted
 * directly under the AssistantRuntimeProvider (avoiding the rendering
 * subtree of ThreadPrimitive.Viewport, which has its own lifecycle).
 */
export const InitialPromptAutoSend: FC<{ prompt?: string; onSent?: () => void }> = ({ prompt, onSent }) => {
  const composer = useComposerRuntime();
  const firedRef = useRef(false);
  useEffect(() => {
    if (!prompt || firedRef.current) return;
    firedRef.current = true;
    console.log('[OverlayThread] InitialPromptAutoSend firing prompt:', prompt.slice(0, 80));
    let attempt = 0;
    const maxAttempts = 5;
    const tryAutoSend = () => {
      attempt++;
      try {
        composer.setText(prompt);
        composer.send();
        console.log('[OverlayThread] InitialPromptAutoSend send() succeeded on attempt', attempt);
        onSent?.();
      } catch (err) {
        console.warn('[OverlayThread] InitialPromptAutoSend attempt', attempt, 'failed:', err);
        if (attempt < maxAttempts) {
          setTimeout(tryAutoSend, 500);
        } else {
          console.error('[OverlayThread] InitialPromptAutoSend gave up after', maxAttempts, 'attempts');
          onSent?.();
        }
      }
    };
    const id = setTimeout(tryAutoSend, 500);
    return () => clearTimeout(id);
  }, [prompt]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
};

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
              <OverlayScrollToBottom />
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
  // Detect approval response messages and render them compactly
  const text = useAuiState((s: any) => {
    const parts = s.message?.parts;
    if (!parts || parts.length !== 1 || parts[0].type !== 'text') return null;
    return parts[0].text;
  });

  const isApprovalResponse = text && APPROVAL_CHOICES.includes(text as any);

  if (isApprovalResponse) {
    // Render as compact inline status, not a full user bubble
    return (
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        padding: '4px 10px', margin: '4px 0',
        fontSize: '13px', fontFamily: "'DM Sans', sans-serif",
        color: text === 'Deny' ? '#9ca3af' : '#16a34a',
      }}>
        <CheckIcon size={14} />
        <span>{text}</span>
      </div>
    );
  }

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

const OverlayScrollToBottom = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  (props, ref) => (
    <button
      ref={ref}
      {...props}
      aria-label="Scroll to bottom"
      style={{
        position: 'absolute', top: '-36px', zIndex: 10,
        alignSelf: 'center', borderRadius: '50%',
        width: '28px', height: '28px', padding: 0,
        display: props.disabled ? 'none' : 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: '#fff', border: '1px solid #e5e7eb',
        boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
        cursor: 'pointer', color: '#6b7280',
      }}
    >
      <ArrowDownIcon size={14} />
    </button>
  ),
);

/**
 * Selection-aware wrapper around the shared `ChatComposer`. Reads the
 * overlay's `PillsContext` to render the "selected text" chip as the
 * composer's `prefix` and swap the placeholder when the user has Word
 * text selected. All actual composer markup (input, attach button, model
 * picker, send/cancel) lives in the shared component.
 */
const OverlayComposer: FC = () => {
  const { selectedText, onDismissSelection } = useContext(PillsContext);

  const prefix = selectedText ? (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '8px',
      padding: '8px 14px',
      marginBottom: '4px',
      background: '#f5f5f3',
      borderRadius: '16px',
      fontFamily: "'DM Sans', sans-serif", fontSize: '13px', color: '#374151',
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
          padding: '2px', fontSize: '14px', lineHeight: '1',
          color: '#9ca3af', flexShrink: 0,
        }}
        aria-label="Clear selection"
      >
        ✕
      </button>
    </div>
  ) : null;

  return (
    <ChatComposer
      prefix={prefix}
      placeholder={selectedText ? 'Reply' : 'Send a message...'}
    />
  );
};
