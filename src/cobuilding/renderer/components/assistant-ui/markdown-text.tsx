import React from 'react';
import '@assistant-ui/react-markdown/styles/dot.css';
import '../WritingAgentView.css';

import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from '@assistant-ui/react-markdown';
import { useAuiState } from '@assistant-ui/react';
import remarkGfm from 'remark-gfm';
import DOMPurify from 'dompurify';
import { type FC, memo, useEffect, useMemo, useState } from 'react';
import { BookmarkPlusIcon, CheckIcon, CopyIcon, Loader2Icon, XIcon } from 'lucide-react';

import { TooltipIconButton } from './tooltip-icon-button';
import { ApprovalParagraph, ApprovalList } from './approval-buttons';
import { IPC_CHANNELS } from '../../../../shared/types';

type ZoteroLocalStatus = 'running' | 'not-running' | 'not-installed';

/**
 * Tracks DOIs successfully added to local Zotero so the button can flip to
 * "Open in Zotero". Source of truth lives in the main process (shared across
 * the desktop chat and the Word overlay) — this is just a renderer-side cache
 * hydrated from IPC on first use.
 */
const addedDoiStore = (() => {
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
        const dois = await (window as any).electronAPI.invoke(IPC_CHANNELS.ZOTERO_LOCAL_LIST_ADDED_DOIS);
        if (Array.isArray(dois)) {
          let changed = false;
          for (const d of dois) {
            const n = norm(d);
            if (!set.has(n)) { set.add(n); changed = true; }
          }
          if (changed) listeners.forEach(fn => fn());
        }
      } catch { /* renderer started before handler registered — fine */ }
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

/**
 * Cross-message Zotero status singleton so every DOI button shares one poll cycle
 * instead of pinging the connector once per reference.
 */
const zoteroStatusStore = (() => {
  let status: ZoteroLocalStatus | null = null;
  const listeners = new Set<(s: ZoteroLocalStatus | null) => void>();
  let inflight: Promise<void> | null = null;
  let lastFetch = 0;
  const STALE_MS = 30_000;

  const refresh = (): Promise<void> => {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const r = await (window as any).electronAPI.invoke(IPC_CHANNELS.ZOTERO_LOCAL_GET_STATUS);
        status = r?.status ?? 'not-running';
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
    // When the desktop window regains focus, recheck so the button reflects whether
    // the user has just opened Zotero (instead of waiting for the staleness timer).
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
      return () => listeners.delete(fn);
    },
    refresh,
    get(): ZoteroLocalStatus | null { return status; },
  };
})();

const ZoteroAddRefButton: FC<{ doi: string }> = ({ doi }) => {
  const [status, setStatus] = useState<ZoteroLocalStatus | null>(zoteroStatusStore.get());
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [alreadyAdded, setAlreadyAdded] = useState<boolean>(addedDoiStore.has(doi));

  useEffect(() => zoteroStatusStore.subscribe(setStatus), []);
  useEffect(() => addedDoiStore.subscribe(() => setAlreadyAdded(addedDoiStore.has(doi))), [doi]);

  // When Zotero is running and we don't already know the DOI is added, ask Zotero
  // whether it's in the user's library. Lets pre-existing items show "Open in
  // Zotero" without the user having to click Add first.
  useEffect(() => {
    if (status !== 'running' || addedDoiStore.has(doi)) return;
    let cancelled = false;
    (async () => {
      try {
        const exists = await (window as any).electronAPI.invoke(IPC_CHANNELS.ZOTERO_LOCAL_CHECK_DOI, doi);
        if (!cancelled && exists === true) addedDoiStore.add(doi);
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
      const r = await (window as any).electronAPI.invoke(IPC_CHANNELS.ZOTERO_LOCAL_ADD_DOI, doi);
      if (r?.success) {
        addedDoiStore.add(doi);
        setState('idle');
        zoteroStatusStore.refresh();
      } else {
        setState('error');
        setErrorMsg(r?.error ?? 'Failed to add ref to Zotero');
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
    (window as any).electronAPI.invoke(IPC_CHANNELS.ZOTERO_OPEN_DOI, doi);
  };

  if (alreadyAdded) {
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

/** Detect if content is HTML (starts with a tag like <article>, <div>, <p>, etc.) */
function looksLikeHtml(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('<') && /<\/?[a-z][\s\S]*>/i.test(trimmed);
}

/** Auto-link bare DOIs that the agent emits as plain text (e.g. "DOI: 10.x/y"). */
const DOI_RE = /\b10\.\d{4,9}\/[^\s\]<>"'(),]+/g;

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
          onClick={(e) => {
            e.preventDefault();
            (window as any).electronAPI.invoke(IPC_CHANNELS.OPEN_EXTERNAL_URL, url);
          }}
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
    // any element carrying an href so we don't autolink the DOI inside its label
    // and end up with two buttons stacked next to a single link.
    if (props && typeof props.href === 'string') return node;
    if (props && props.children !== undefined) {
      return React.cloneElement(
        node as any,
        undefined,
        autolinkChildren(props.children, `${keyPrefix}-c`),
      );
    }
  }
  return node;
}

declare global {
  interface WindowEventMap {
    'open-file-tab': CustomEvent<{ filePath: string; lineNumber?: number }>;
  }
}

/** Matches backtick text that looks like a file path (with or without directory). */
const FILE_EXT_RE = /^(\.{0,2}\/?(?:[\w.@-]+\/)*[\w.@-]+\.(?:png|jpg|jpeg|gif|svg|webp|bmp|pdf|csv|tsv|json|jsonl|md|txt|py|r|sh|js|ts|tsx|jsx|css|html|yaml|yml|toml|sql|ipynb|xlsx|xlsm|tex|latex|log|xml|env|cfg|ini|bib|fcs|h5ad|h5|hdf5|parquet|feather|rds|rda))(?::(\d+))?$/i;

/**
 * Module-level cache: candidate text → resolved relative path.
 * Only positive results are cached. Negative results (null) are NOT cached so
 * that files the agent just created can be discovered on the next render.
 */
const resolvedPathCache = new Map<string, string>();

function useResolvedFilePath(candidate: string | null, hintDirs: string[]): string | null {
  const [resolved, setResolved] = useState<string | null>(
    () => (candidate ? (resolvedPathCache.get(candidate) ?? null) : null),
  );
  useEffect(() => {
    if (!candidate) { setResolved(null); return; }
    const cached = resolvedPathCache.get(candidate);
    if (cached !== undefined) { setResolved(cached); return; }
    let cancelled = false;
    const resolve = async () => {
      let result: string | null = null;
      if (candidate.includes('/')) {
        const exists = await (window as any).filesAPI.fileExists(candidate);
        result = exists ? candidate : null;
      } else {
        result = await (window as any).filesAPI.findByName(candidate, hintDirs);
      }
      if (result !== null) {
        resolvedPathCache.set(candidate, result);
      }
      if (!cancelled) setResolved(result);
    };
    resolve();
    return () => { cancelled = true; };
  }, [candidate]); // hintDirs intentionally excluded — first resolution wins
  return resolved;
}

const MarkdownTextImpl = () => {
  const text = useAuiState((s: any) => {
    const parts = s.message?.parts;
    if (!parts) return null;
    // Find the current text part's content
    const textParts = parts.filter((p: any) => p.type === 'text');
    return textParts.length > 0 ? textParts[textParts.length - 1]?.text : null;
  });

  // If the text content is HTML from Writing Agent, render it as sanitized HTML
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
      components={defaultComponents}
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);

const CodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const onCopy = () => {
    if (!code || isCopied) return;
    copyToClipboard(code);
  };

  return (
    <div className="codeHeaderRoot">
      <span className="codeHeaderLanguage">{language}</span>
      <TooltipIconButton tooltip="Copy" onClick={onCopy}>
        {!isCopied && <CopyIcon />}
        {isCopied && <CheckIcon />}
      </TooltipIconButton>
    </div>
  );
};

const useCopyToClipboard = ({
  copiedDuration = 3000,
}: { copiedDuration?: number } = {}) => {
  const [isCopied, setIsCopied] = useState<boolean>(false);

  const copyToClipboard = (value: string) => {
    if (!value) return;
    navigator.clipboard.writeText(value).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), copiedDuration);
    });
  };

  return { isCopied, copyToClipboard };
};

const ParagraphWithDoiLinks = (props: any) => {
  const children = autolinkChildren(props.children, 'p');
  return <ApprovalParagraph {...props}>{children}</ApprovalParagraph>;
};

const ListItemWithDoiLinks = (props: any) => (
  <li {...props}>{autolinkChildren(props.children, 'li')}</li>
);

const TableCellWithDoiLinks = (props: any) => (
  <td {...props}>{autolinkChildren(props.children, 'td')}</td>
);

const defaultComponents = memoizeMarkdownComponents({
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
          if (href) {
            (window as any).electronAPI.invoke(IPC_CHANNELS.OPEN_EXTERNAL_URL, href);
          }
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
  code: function Code({ className, children, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    const text = typeof children === 'string' ? children : '';
    const match = !isCodeBlock ? text.match(FILE_EXT_RE) : null;
    const candidate = match?.[1] ?? null;
    const lineNumber = match?.[2] ? parseInt(match[2], 10) : undefined;

    // Extract directory hints from message context (for bare filenames)
    const messageText = useAuiState((s: any) => {
      if (!candidate || candidate.includes('/')) return '';
      const parts = s.message?.parts;
      if (!parts) return '';
      return parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
    });

    const hintDirs = useMemo(() => {
      if (!messageText) return [];
      const dirs = new Set<string>();
      const re = /(?:[\w.@-]+\/)+/g;
      let m;
      while ((m = re.exec(messageText)) !== null) {
        dirs.add(m[0].replace(/\/$/, ''));
      }
      return Array.from(dirs);
    }, [messageText]);

    const resolvedPath = useResolvedFilePath(candidate, hintDirs);

    if (isCodeBlock) {
      return <code className={className ?? ''} {...props}>{children}</code>;
    }

    if (resolvedPath) {
      return (
        <code
          className={`inlineCode inlineCode--filePath${className ? ` ${className}` : ''}`}
          onClick={() => {
            window.dispatchEvent(new CustomEvent('open-file-tab', {
              detail: { filePath: resolvedPath, lineNumber },
            }));
          }}
          title={`Open ${resolvedPath}${lineNumber ? ` at line ${lineNumber}` : ''}`}
          {...props}
        >
          {children}
        </code>
      );
    }

    return (
      <code
        className={`inlineCode${className ? ` ${className}` : ''}`}
        {...props}
      >
        {children}
      </code>
    );
  },
  CodeHeader,
});
