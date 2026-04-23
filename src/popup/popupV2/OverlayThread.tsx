/**
 * Simplified Thread component for the Word overlay popup.
 *
 * Reuses the same message part renderers as the desktop app (MarkdownText,
 * Reasoning, ToolFallback, ToolGroup) for identical message rendering,
 * but has a simpler composer without ModelSelector or file attachments.
 */

import React, { createContext, useContext, memo, useState, useRef, useEffect } from 'react';
import type { FC } from 'react';
import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useAssistantRuntime,
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
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CopyIcon,
  LoaderIcon,
  PlayIcon,
  RefreshCwIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SquareIcon,
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

const APPROVAL_CHOICES = ['Allow once', 'Always allow', 'Deny'] as const;

/** Detects "Choose: **Allow once** / **Always allow** / **Deny**" and renders clickable buttons.
 *  After clicking, buttons are replaced with a compact status showing the choice made. */
const ApprovalButtons: FC<{ children: React.ReactNode }> = ({ children }) => {
  const runtime = useAssistantRuntime();
  const [chosen, setChosen] = useState<string | null>(null);

  const textContent = React.Children.toArray(children)
    .map((child: any) => {
      if (typeof child === 'string') return child;
      if (child?.props?.children) {
        const inner = child.props.children;
        return typeof inner === 'string' ? inner : '';
      }
      return '';
    })
    .join('');

  const isApprovalPrompt = /allow once.*always allow.*deny/i.test(textContent);

  if (!isApprovalPrompt) {
    return <p>{children}</p>;
  }

  if (chosen) {
    return (
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        padding: '4px 10px', marginTop: '6px',
        fontSize: '13px', fontFamily: "'DM Sans', sans-serif",
        color: chosen === 'Deny' ? '#9ca3af' : '#16a34a',
      }}>
        <CheckIcon size={14} />
        <span>{chosen}</span>
      </div>
    );
  }

  const handleChoice = (choice: string) => {
    setChosen(choice);
    runtime.thread.append({
      role: 'user',
      content: [{ type: 'text', text: choice }],
    });
  };

  const btnBase: React.CSSProperties = {
    padding: '6px 16px', borderRadius: '8px', fontSize: '13px',
    fontFamily: "'DM Sans', sans-serif", fontWeight: 500, cursor: 'pointer',
  };

  return (
    <div style={{ display: 'flex', gap: '8px', marginTop: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
      <button
        onClick={() => handleChoice('Allow once')}
        style={{ ...btnBase, border: '1px solid #e5e7eb', background: '#fff', color: '#374151' }}
        onMouseEnter={e => (e.currentTarget.style.background = '#f5f5f3')}
        onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
      >Allow once</button>
      <button
        onClick={() => handleChoice('Always allow')}
        style={{ ...btnBase, border: '1px solid #3b82f6', background: '#3b82f6', color: '#fff' }}
        onMouseEnter={e => (e.currentTarget.style.background = '#2563eb')}
        onMouseLeave={e => (e.currentTarget.style.background = '#3b82f6')}
      >Always allow</button>
      <button
        onClick={() => handleChoice('Deny')}
        style={{ ...btnBase, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280' }}
        onMouseEnter={e => (e.currentTarget.style.background = '#f5f5f3')}
        onMouseLeave={e => (e.currentTarget.style.background = '#fff')}
      >Deny</button>
    </div>
  );
};

const overlayComponents = memoizeMarkdownComponents({
  p: ApprovalButtons as any,
  a: ({ href, children, ...props }) => (
    <a
      {...props}
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) window.open(href, '_blank');
      }}
    >
      {children}
    </a>
  ),
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

export type EditMode = 'ask' | 'accept';

interface OverlayContextPills {
  documentPath?: string | null;
  selectedText?: string | null;
  onDismissSelection?: () => void;
  editMode?: EditMode;
  onEditModeChange?: (mode: EditMode) => void;
}

const PillsContext = createContext<OverlayContextPills>({});

export const OverlayThread: FC<OverlayContextPills> = ({ documentPath, selectedText, onDismissSelection, editMode, onEditModeChange }) => {
  return (
    <PillsContext.Provider value={{ documentPath, selectedText, onDismissSelection, editMode, onEditModeChange }}>
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
              <button
                aria-label="Scroll to bottom"
                style={{
                  position: 'absolute', top: '-36px', zIndex: 10,
                  alignSelf: 'center', borderRadius: '50%',
                  width: '28px', height: '28px', padding: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: '#fff', border: '1px solid #e5e7eb',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
                  cursor: 'pointer', color: '#6b7280',
                }}
              >
                <ArrowDownIcon size={14} />
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

const EditModeMenu: FC = () => {
  const { editMode, onEditModeChange } = useContext(PillsContext);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={menuRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        onClick={() => setOpen(!open)}
        aria-label="Edit mode"
        title={editMode === 'ask' ? 'Ask before edits' : 'Accept all edits'}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          padding: '4px', borderRadius: '6px', display: 'flex',
          alignItems: 'center', justifyContent: 'center',
          color: '#6b7280',
        }}
      >
        <SettingsIcon size={16} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', bottom: 'calc(100% + 4px)', left: 0,
          background: '#fff', borderRadius: '12px',
          border: '1px solid #e5e7eb', boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          padding: '4px', width: '200px', zIndex: 50,
          fontFamily: "'DM Sans', sans-serif", fontSize: '13px',
        }}>
          <button
            onClick={() => { onEditModeChange?.('ask'); setOpen(false); }}
            style={{
              display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
              padding: '8px 10px', border: 'none', background: 'none',
              cursor: 'pointer', borderRadius: '8px', textAlign: 'left',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = '#f5f5f3')}
            onMouseLeave={e => (e.currentTarget.style.background = 'none')}
          >
            <ShieldCheckIcon size={15} color="#6b7280" />
            <span style={{ flex: 1, color: '#374151' }}>Ask before edits</span>
            {editMode === 'ask' && <CheckIcon size={15} color="#3b82f6" />}
          </button>
          <button
            onClick={() => { onEditModeChange?.('accept'); setOpen(false); }}
            style={{
              display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
              padding: '8px 10px', border: 'none', background: 'none',
              cursor: 'pointer', borderRadius: '8px', textAlign: 'left',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = '#f5f5f3')}
            onMouseLeave={e => (e.currentTarget.style.background = 'none')}
          >
            <PlayIcon size={15} color="#6b7280" />
            <span style={{ flex: 1, color: '#374151' }}>Accept all edits</span>
            {editMode === 'accept' && <CheckIcon size={15} color="#3b82f6" />}
          </button>
        </div>
      )}
    </div>
  );
};

const OverlayComposer: FC = () => {
  const { selectedText, onDismissSelection } = useContext(PillsContext);

  return (
    <ComposerPrimitive.Root className="composerRoot">
      {/* Selected text bar — above the composer shell, matching Claude for Word */}
      {selectedText && (
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
          <EditModeMenu />
          <div style={{ flex: 1 }} />
          <div className="composerActions">
            <AuiIf condition={(s: any) => !s.thread.isRunning}>
              <ComposerPrimitive.Send asChild>
                <button
                  aria-label="Send message"
                  style={{
                    width: '28px', height: '28px', borderRadius: '50%',
                    background: '#141413', border: 'none', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#fff', padding: 0,
                  }}
                >
                  <ArrowUpIcon size={14} />
                </button>
              </ComposerPrimitive.Send>
            </AuiIf>
            <AuiIf condition={(s: any) => s.thread.isRunning}>
              <ComposerPrimitive.Cancel asChild>
                <button
                  aria-label="Stop generating"
                  style={{
                    width: '28px', height: '28px', borderRadius: '50%',
                    background: '#dc2626', border: 'none', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#fff', padding: 0,
                  }}
                >
                  <SquareIcon size={12} />
                </button>
              </ComposerPrimitive.Cancel>
            </AuiIf>
          </div>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
};
