/**
 * DOI link rendering shared by the desktop chat panel (Electron renderer)
 * and the Word overlay (WKWebView served over the local HTTP server).
 *
 * The two contexts can't reach Zotero / Electron the same way:
 *   - Desktop renderer has `window.electronAPI` from the preload bridge and
 *     dispatches via IPC channels (`ZOTERO_LOCAL_*`, `OPEN_EXTERNAL_URL`).
 *   - Overlay has no preload — it talks to the local HTTP server over
 *     `/api/zotero/*` and `/api/navigate`, with the auth token carried as
 *     a URL query param.
 *
 * We pick the transport at runtime (`hasIPC`) so both renderer entry points
 * can import the same module. Previously, `OverlayThread.tsx` and
 * `markdown-text.tsx` each shipped a parallel copy of the stores, the
 * Zotero "+" button, the DOI-aware anchor, and the writing-agent HTML
 * branch — which is how PR #434's `dangerouslySetInnerHTML` regression
 * landed in two places at once and got fixed in only one. One module, one
 * fix surface.
 *
 * Public API:
 *   - `extractDoiFromHref` — pull a DOI out of a doi.org URL.
 *   - `AnchorWithDoi` — `<a>` replacement that decorates DOI links with
 *     the Zotero "+" / "Open in Zotero" button.
 *   - `parseAgentHtml` — DOMPurify-sanitize an HTML response and parse it
 *     into React elements via `html-react-parser`, replacing `<a>` nodes
 *     with `AnchorWithDoi`. Required so the writing-agent's
 *     `<details class="skill-trace">` HTML responses still get the button.
 */

import React, { type FC, useEffect, useState } from 'react';
import { BookmarkPlusIcon, CheckIcon, Loader2Icon, XIcon } from 'lucide-react';
import DOMPurify from 'dompurify';
import parse, { domToReact, type DOMNode, type HTMLReactParserOptions } from 'html-react-parser';
import { IPC_CHANNELS } from '../../../../shared/types';

type ZoteroLocalStatus = 'running' | 'not-running' | 'not-installed';

// ─── Transport selection ────────────────────────────────────────────
//
// `hasIPC` is the single source of truth for "are we running inside an
// Electron renderer with the preload bridge?". The overlay's WKWebView has
// no preload, so window.electronAPI is undefined there and we fall back to
// HTTP. We snapshot this once at module load — neither environment switches
// transports mid-session.
const hasIPC = typeof window !== 'undefined' && typeof (window as any).electronAPI !== 'undefined';

function overlayAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (typeof window === 'undefined') return headers;
  const token = new URLSearchParams(window.location.search).get('token');
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function rpcGetZoteroStatus(): Promise<ZoteroLocalStatus> {
  if (hasIPC) {
    try {
      const r = await (window as any).electronAPI.invoke(IPC_CHANNELS.ZOTERO_LOCAL_GET_STATUS);
      return (r?.status ?? 'not-running') as ZoteroLocalStatus;
    } catch { return 'not-running'; }
  }
  try {
    const r = await fetch(`${window.location.origin}/api/zotero/status`, { headers: overlayAuthHeaders() });
    const json = await r.json();
    return (json?.status ?? 'not-running') as ZoteroLocalStatus;
  } catch { return 'not-running'; }
}

async function rpcListAddedDois(): Promise<string[] | null> {
  if (hasIPC) {
    try {
      const dois = await (window as any).electronAPI.invoke(IPC_CHANNELS.ZOTERO_LOCAL_LIST_ADDED_DOIS);
      return Array.isArray(dois) ? dois : null;
    } catch { return null; }
  }
  try {
    const r = await fetch(`${window.location.origin}/api/zotero/added-dois`, { headers: overlayAuthHeaders() });
    const json = await r.json();
    return Array.isArray(json?.dois) ? json.dois : null;
  } catch { return null; }
}

async function rpcCheckDoi(doi: string): Promise<boolean> {
  if (hasIPC) {
    try {
      const exists = await (window as any).electronAPI.invoke(IPC_CHANNELS.ZOTERO_LOCAL_CHECK_DOI, doi);
      return exists === true;
    } catch { return false; }
  }
  try {
    const r = await fetch(
      `${window.location.origin}/api/zotero/check-doi?doi=${encodeURIComponent(doi)}`,
      { headers: overlayAuthHeaders() },
    );
    const json = await r.json();
    return json?.exists === true;
  } catch { return false; }
}

async function rpcAddDoi(doi: string): Promise<{ success: boolean; error?: string }> {
  if (hasIPC) {
    return (window as any).electronAPI.invoke(IPC_CHANNELS.ZOTERO_LOCAL_ADD_DOI, doi);
  }
  const r = await fetch(`${window.location.origin}/api/zotero/add`, {
    method: 'POST',
    headers: overlayAuthHeaders(),
    body: JSON.stringify({ doi }),
  });
  return r.json();
}

function rpcOpenDoi(doi: string): void {
  if (hasIPC) {
    (window as any).electronAPI.invoke(IPC_CHANNELS.ZOTERO_OPEN_DOI, doi);
    return;
  }
  fetch(
    `${window.location.origin}/api/zotero/open?doi=${encodeURIComponent(doi)}`,
    { headers: overlayAuthHeaders() },
  ).catch(() => { /* best-effort */ });
}

function rpcOpenExternalUrl(url: string): void {
  if (hasIPC) {
    (window as any).electronAPI.invoke(IPC_CHANNELS.OPEN_EXTERNAL_URL, url);
    return;
  }
  // Overlay path: route through /api/navigate, the same endpoint
  // popupV2/shared.ts#navigateToPage uses for `page: 'external'`.
  fetch(`${window.location.origin}/api/navigate`, {
    method: 'POST',
    headers: overlayAuthHeaders(),
    body: JSON.stringify({ page: 'external', url }),
  }).catch(() => { /* best-effort */ });
}

// ─── Stores ─────────────────────────────────────────────────────────
//
// Module-level singletons so every DOI button on the page shares one poll
// cycle and one "added-DOIs" cache instead of pinging Zotero per reference.

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
      const dois = await rpcListAddedDois();
      if (dois) {
        let changed = false;
        for (const d of dois) {
          const n = norm(d);
          if (!set.has(n)) { set.add(n); changed = true; }
        }
        if (changed) listeners.forEach(fn => fn());
      }
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
    // In overlay context the agent's MCP search may add DOIs to Zotero
    // mid-conversation. Re-hydrate periodically so those flip to "Open in
    // Zotero" without waiting for a focus change.
    if (!hasIPC) {
      setInterval(() => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') {
          hydrate(true);
        }
      }, 5000);
    }
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

const zoteroStatusStore = (() => {
  let status: ZoteroLocalStatus | null = null;
  const listeners = new Set<(s: ZoteroLocalStatus | null) => void>();
  let inflight: Promise<void> | null = null;
  let lastFetch = 0;
  const STALE_MS = 30_000;

  const refresh = (): Promise<void> => {
    if (inflight) return inflight;
    inflight = (async () => {
      status = await rpcGetZoteroStatus();
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
      return () => listeners.delete(fn);
    },
    refresh,
    get(): ZoteroLocalStatus | null { return status; },
  };
})();

// ─── ZoteroAddRefButton ─────────────────────────────────────────────

const ZoteroAddRefButton: FC<{ doi: string }> = ({ doi }) => {
  const [status, setStatus] = useState<ZoteroLocalStatus | null>(zoteroStatusStore.get());
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [alreadyAdded, setAlreadyAdded] = useState<boolean>(addedDoiStore.has(doi));

  useEffect(() => zoteroStatusStore.subscribe(setStatus), []);
  useEffect(() => addedDoiStore.subscribe(() => setAlreadyAdded(addedDoiStore.has(doi))), [doi]);

  // When Zotero is running and we don't already know the DOI is added, ask
  // Zotero whether it's in the user's library. Lets pre-existing items show
  // "Open in Zotero" without the user having to click Add first.
  useEffect(() => {
    if (status !== 'running' || addedDoiStore.has(doi)) return;
    let cancelled = false;
    (async () => {
      const exists = await rpcCheckDoi(doi);
      if (!cancelled && exists) addedDoiStore.add(doi);
    })();
    return () => { cancelled = true; };
  }, [doi, status]);

  const handleAdd = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setState('saving');
    setErrorMsg(null);
    try {
      const r = await rpcAddDoi(doi);
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
    rpcOpenDoi(doi);
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

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Pull a DOI from an `https://doi.org/…` (or dx.doi.org) URL. Returns the
 * bare DOI on match, null otherwise.
 */
export const extractDoiFromHref = (href: string | undefined): string | null => {
  if (!href) return null;
  const m = href.match(/^https?:\/\/(?:dx\.)?doi\.org\/(10\.\d{4,9}\/[^\s?#]+)/i);
  return m ? m[1] : null;
};

/**
 * Anchor renderer shared by the Markdown path (`a:` component override) and
 * the HTML path (html-react-parser replacer). Routes external clicks via
 * the active transport (Electron IPC in the desktop renderer, /api/navigate
 * in the overlay), and decorates DOI URLs with the Zotero add/open button.
 */
export const AnchorWithDoi: FC<{ href?: string; children?: React.ReactNode } & Record<string, any>> = ({
  href,
  children,
  ...props
}) => {
  const doi = extractDoiFromHref(href);
  const link = (
    <a
      {...props}
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) rpcOpenExternalUrl(href);
      }}
    >
      {children}
    </a>
  );
  if (!doi) return link;
  return (
    <span className="docRefInline">
      {link}
      <ZoteroAddRefButton doi={doi} />
    </span>
  );
};

/**
 * Parse a Writing Agent HTML response into React elements so component-level
 * overrides (e.g. the DOI anchor → Zotero button decoration) apply to it the
 * same way they apply to Markdown responses. Sanitizes via DOMPurify first,
 * preserving the security boundary that `dangerouslySetInnerHTML` provided.
 *
 * `<details>` and `<summary>` are explicitly allowed because the writing-agent
 * skill wraps every response in a `<details class="skill-trace">` block and
 * older DOMPurify default profiles strip them.
 *
 * Note on the `node.type === 'tag'` duck-type check: html-react-parser bundles
 * its own copy of `domhandler` under `node_modules/html-react-parser/node_modules`,
 * so `node instanceof Element` is unreliable when module resolution gives the
 * exported `Element` and the runtime nodes' constructor different identities
 * (most notably ts-jest under jsdom). The shape check works regardless.
 */
export function parseAgentHtml(html: string): React.ReactNode {
  const sanitized = DOMPurify.sanitize(html, { ADD_TAGS: ['details', 'summary'] });
  const options: HTMLReactParserOptions = {
    replace: (node: DOMNode) => {
      const el = node as { type?: string; name?: string; attribs?: Record<string, string>; children?: DOMNode[] };
      if (el.type === 'tag' && el.name === 'a') {
        const { href, ...rest } = el.attribs ?? {};
        return (
          <AnchorWithDoi href={href} {...rest}>
            {domToReact((el.children ?? []) as DOMNode[], options)}
          </AnchorWithDoi>
        );
      }
      return undefined;
    },
  };
  return parse(sanitized, options);
}
