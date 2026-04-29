/**
 * Simplified Thread component for the Word overlay popup.
 *
 * Reuses the same message part renderers as the desktop app (MarkdownText,
 * Reasoning, ToolFallback, ToolGroup) for identical message rendering,
 * but has a simpler composer without ModelSelector or file attachments.
 */

import React, { createContext, useContext, memo, useEffect, useState } from 'react';
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
import DOMPurify from 'dompurify';
import '../../cobuilding/renderer/components/WritingAgentView.css';
import { TooltipProvider } from '../../cobuilding/renderer/components/ui/tooltip';
import { ToolFallback } from '../../cobuilding/renderer/components/assistant-ui/tool-fallback';
import { ToolGroup } from '../../cobuilding/renderer/components/assistant-ui/tool-group';
import { Reasoning } from '../../cobuilding/renderer/components/assistant-ui/thinking-indicator';
import { ApprovalParagraph, ApprovalList, APPROVAL_CHOICES } from '../../cobuilding/renderer/components/assistant-ui/approval-buttons';
import { navigateToPage, tokenParam } from './shared';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BookmarkPlusIcon,
  CheckIcon,
  CopyIcon,
  Loader2Icon,
  LoaderIcon,
  RefreshCwIcon,
  SquareIcon,
  XIcon,
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

function openOverlayUrl(url: string) {
  navigateToPage({ page: 'external', url }, tokenParam);
}

// ─── Zotero "Add ref" button (overlay path) ────────────────────────
// Mirrors src/cobuilding/renderer/components/assistant-ui/markdown-text.tsx but
// hits the local HTTP server (the overlay runs in WKWebView, has no preload).

type ZoteroLocalStatus = 'running' | 'not-running' | 'not-installed';

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (tokenParam) h['Authorization'] = `Bearer ${tokenParam}`;
  return h;
}

const overlayZoteroStatusStore = (() => {
  let status: ZoteroLocalStatus | null = null;
  let lastFetch = 0;
  let inflight: Promise<void> | null = null;
  const listeners = new Set<(s: ZoteroLocalStatus | null) => void>();
  const STALE_MS = 30_000;

  const refresh = (): Promise<void> => {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const r = await fetch(`${window.location.origin}/api/zotero/status`, {
          headers: authHeaders(),
        });
        const json = await r.json();
        status = json?.status ?? 'not-running';
      } catch {
        status = 'not-running';
      }
      lastFetch = Date.now();
      inflight = null;
      listeners.forEach(fn => fn(status));
    })();
    return inflight;
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => { refresh(); });
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refresh();
    });
  }

  return {
    subscribe(fn: (s: ZoteroLocalStatus | null) => void): () => void {
      listeners.add(fn);
      fn(status);
      if (status === null || Date.now() - lastFetch > STALE_MS) refresh();
      return () => { listeners.delete(fn); };
    },
    refresh,
    get(): ZoteroLocalStatus | null { return status; },
  };
})();

const overlayAddedDoiStore = (() => {
  const norm = (doi: string) => doi.trim().toLowerCase().replace(/[.,;:]+$/, '');
  const set = new Set<string>();
  let inflight: Promise<void> | null = null;
  let lastHydrated = 0;
  const HYDRATE_TTL_MS = 30_000;
  const listeners = new Set<() => void>();

  const hydrate = (force = false): Promise<void> => {
    if (inflight) return inflight;
    if (!force && lastHydrated > 0 && Date.now() - lastHydrated < HYDRATE_TTL_MS) {
      return Promise.resolve();
    }
    inflight = (async () => {
      try {
        const r = await fetch(`${window.location.origin}/api/zotero/added-dois`, { headers: authHeaders() });
        const json = await r.json();
        if (Array.isArray(json?.dois)) {
          let changed = false;
          for (const d of json.dois as string[]) {
            const n = norm(d);
            if (!set.has(n)) { set.add(n); changed = true; }
          }
          if (changed) listeners.forEach(fn => fn());
        }
      } catch { /* server may not be up yet */ }
      lastHydrated = Date.now();
      inflight = null;
    })();
    return inflight;
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => { hydrate(true); });
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') hydrate(true);
    });
  }

  return {
    has(doi: string): boolean { return set.has(norm(doi)); },
    add(doi: string): void { set.add(norm(doi)); listeners.forEach(fn => fn()); },
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      hydrate();
      return () => { listeners.delete(fn); };
    },
  };
})();

const ZoteroAddRefButton: React.FC<{ doi: string }> = ({ doi }) => {
  const [status, setStatus] = useState<ZoteroLocalStatus | null>(overlayZoteroStatusStore.get());
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [added, setAdded] = useState<boolean>(overlayAddedDoiStore.has(doi));

  useEffect(() => overlayZoteroStatusStore.subscribe(setStatus), []);
  useEffect(() => overlayAddedDoiStore.subscribe(() => setAdded(overlayAddedDoiStore.has(doi))), [doi]);

  // Ask Zotero whether the DOI is already in the user's library so pre-existing
  // refs render as "Open in Zotero" without the user having to click Add first.
  useEffect(() => {
    if (status !== 'running' || overlayAddedDoiStore.has(doi)) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${window.location.origin}/api/zotero/check-doi?doi=${encodeURIComponent(doi)}`, {
          headers: authHeaders(),
        });
        const json = await r.json();
        if (!cancelled && json?.exists === true) overlayAddedDoiStore.add(doi);
      } catch { /* unknown — leave as Add */ }
    })();
    return () => { cancelled = true; };
  }, [doi, status]);

  const handleAdd = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setState('saving');
    setErrorMsg(null);
    try {
      const res = await fetch(`${window.location.origin}/api/zotero/add`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ doi }),
      });
      const json = await res.json();
      if (json?.success) {
        overlayAddedDoiStore.add(doi);
        setState('idle');
        overlayZoteroStatusStore.refresh();
      } else {
        setState('error');
        setErrorMsg(json?.error ?? 'Failed to add ref');
        setTimeout(() => setState('idle'), 5000);
      }
    } catch (err: any) {
      setState('error');
      setErrorMsg(err?.message ?? 'Unexpected error');
      setTimeout(() => setState('idle'), 5000);
    }
  };

  const handleOpen = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openOverlayUrl(`zotero://search?q=${encodeURIComponent(doi)}`);
  };

  if (added) {
    return (
      <button
        type="button"
        className="zoteroAddRefBtn zoteroAddRefBtn--added"
        onClick={handleOpen}
        title="Open ref in Zotero"
        aria-label="Open ref in Zotero"
      >
        <CheckIcon size={12} />
      </button>
    );
  }

  const disabled = status === 'not-installed' || state === 'saving';
  const tooltip =
    status === 'not-installed' ? 'Zotero not installed' :
    state === 'saving' ? 'Adding ref to Zotero…' :
    state === 'error' ? (errorMsg ?? 'Failed to add ref') :
    status === 'not-running' ? 'Open Zotero and add this ref' :
    'Add ref to Zotero';

  const Icon =
    state === 'saving' ? Loader2Icon :
    state === 'error' ? XIcon :
    BookmarkPlusIcon;

  return (
    <button
      type="button"
      className={`zoteroAddRefBtn zoteroAddRefBtn--${state}${disabled ? ' zoteroAddRefBtn--disabled' : ''}`}
      onClick={handleAdd}
      disabled={disabled}
      title={tooltip}
      aria-label={tooltip}
    >
      <Icon size={12} className={state === 'saving' ? 'zoteroAddRefBtn__spin' : ''} />
    </button>
  );
};

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
      <span key={`${keyPrefix}-ref-${i}`} className="docRefInline">
        <a
          href={url}
          onClick={(e) => { e.preventDefault(); openOverlayUrl(url); }}
        >
          {doi}
        </a>
        <ZoteroAddRefButton doi={doi} />
      </span>,
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
  a: ({ href, children, ...props }) => {
    const doiFromHref = (() => {
      if (!href) return null;
      const m = href.match(/^https?:\/\/(?:dx\.)?doi\.org\/(10\.\d{4,9}\/[^\s?#]+)/i);
      return m ? m[1] : null;
    })();
    const link = (
      <a
        {...props}
        href={href}
        onClick={(e) => {
          e.preventDefault();
          if (href) navigateToPage({ page: 'external', url: href }, tokenParam);
        }}
      >
        {children}
      </a>
    );
    if (!doiFromHref) return link;
    return (
      <span className="docRefInline">
        {link}
        <ZoteroAddRefButton doi={doiFromHref} />
      </span>
    );
  },
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

  if (text && looksLikeHtml(text)) {
    return (
      <div
        className="writingAgentHtml"
        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(text) }}
      />
    );
  }

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

const OverlaySendButton = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  (props, ref) => (
    <button
      ref={ref}
      {...props}
      aria-label="Send message"
      style={{
        width: '28px', height: '28px', borderRadius: '50%',
        background: props.disabled ? '#d1d5db' : '#141413',
        border: 'none', cursor: props.disabled ? 'default' : 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#fff', padding: 0,
        transition: 'background 0.15s',
      }}
    >
      <ArrowUpIcon size={14} />
    </button>
  ),
);


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
          <div style={{ flex: 1 }} />
          <div className="composerActions">
            <AuiIf condition={(s: any) => !s.thread.isRunning}>
              <ComposerPrimitive.Send asChild>
                <OverlaySendButton />
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
