/**
 * HTTP-backed file picker for the Word overlay's WKWebView.
 *
 * `<input type="file">` (which assistant-ui's `ComposerPrimitive.AddAttachment`
 * uses under the hood) doesn't open a picker in our overlay's WKWebView —
 * the host app would need to implement WKUIDelegate's
 * `runOpenPanelWithParameters:initiatedByFrame:completionHandler:` for that,
 * which our Rust webview-manager doesn't. Until it does, this component
 * provides an in-overlay alternative that talks to the local HTTP server's
 * `/api/browse-files` + `/api/read-file` endpoints (already-built; see
 * `src/server/routes/fileDialog.ts` — restricted to the user's home dir
 * and `/Volumes`).
 *
 * Used only in the overlay (`hasIPC === false`); the desktop renderer keeps
 * `ComposerPrimitive.AddAttachment` because Chromium's file picker works
 * natively there.
 */

import React, { type FC, useCallback, useEffect, useState } from 'react';
import { useComposerRuntime } from '@assistant-ui/react';
import { PaperclipIcon } from 'lucide-react';

import { TooltipIconButton } from './tooltip-icon-button';

interface Entry {
  name: string;
  path: string;
  isDir: boolean;
}

interface BrowseResponse {
  path: string;
  parent: string | null;
  entries: Entry[];
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (typeof window === 'undefined') return headers;
  const token = new URLSearchParams(window.location.search).get('token');
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

export const OverlayFilePickerButton: FC = () => {
  const composer = useComposerRuntime();
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL(`${window.location.origin}/api/browse-files`);
      if (path) url.searchParams.set('dir', path);
      const r = await fetch(url.toString(), { headers: authHeaders() });
      if (!r.ok) throw new Error(`Browse failed: ${r.status}`);
      const json = (await r.json()) as BrowseResponse;
      setDir(json.path);
      setParent(json.parent);
      setEntries(json.entries);
    } catch (e: any) {
      setError(e?.message ?? 'Could not load directory');
    } finally {
      setLoading(false);
    }
  }, []);

  // Lazy-load directory contents the first time the modal opens.
  useEffect(() => {
    if (open && entries.length === 0 && !loading && !error) {
      void load();
    }
  }, [open, entries.length, loading, error, load]);

  const handlePick = useCallback(async (entry: Entry) => {
    if (entry.isDir) {
      void load(entry.path);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${window.location.origin}/api/read-file`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ path: entry.path }),
      });
      if (!r.ok) throw new Error(`Read failed: ${r.status}`);
      const { name, base64 } = (await r.json()) as { name: string; base64: string };
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const file = new File([bytes], name);
      await composer.addAttachment(file);
      setOpen(false);
    } catch (e: any) {
      setError(e?.message ?? 'Could not read file');
    } finally {
      setLoading(false);
    }
  }, [composer, load]);

  return (
    <>
      <TooltipIconButton
        tooltip="Attach file"
        side="bottom"
        type="button"
        variant="ghost"
        size="icon"
        className="composerAttach"
        onClick={() => setOpen(true)}
      >
        <PaperclipIcon className="composerAttachIcon" />
      </TooltipIconButton>
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.35)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: "'DM Sans', sans-serif",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(420px, 90vw)', maxHeight: '70vh',
              background: '#fff', borderRadius: 12,
              boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }}
          >
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '12px 16px', borderBottom: '1px solid #e5e7eb',
            }}>
              <div style={{
                fontSize: 13, color: '#6b7280',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                flex: 1, marginRight: 8,
              }} title={dir ?? ''}>
                {dir ?? 'Loading…'}
              </div>
              <button
                onClick={() => setOpen(false)}
                aria-label="Close"
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  fontSize: 18, lineHeight: 1, color: '#6b7280', padding: 4,
                }}
              >
                ×
              </button>
            </div>
            {error && (
              <div style={{
                padding: '8px 16px', background: 'rgba(220,38,38,0.08)',
                color: '#b91c1c', fontSize: 12,
              }}>{error}</div>
            )}
            <div style={{ overflow: 'auto', flex: 1 }}>
              {parent && (
                <button
                  onClick={() => load(parent)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: '10px 16px', border: 'none', background: 'none',
                    cursor: 'pointer', fontSize: 14, color: '#374151',
                    borderBottom: '1px solid #f3f4f6',
                  }}
                >
                  ↑ ..
                </button>
              )}
              {entries.map((e) => (
                <button
                  key={e.path}
                  onClick={() => handlePick(e)}
                  disabled={loading}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    width: '100%', textAlign: 'left',
                    padding: '10px 16px', border: 'none', background: 'none',
                    cursor: loading ? 'wait' : 'pointer', fontSize: 14,
                    color: '#374151', borderBottom: '1px solid #f3f4f6',
                  }}
                >
                  <span style={{ width: 16 }}>{e.isDir ? '📁' : '📄'}</span>
                  <span style={{
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{e.name}</span>
                </button>
              ))}
              {loading && entries.length === 0 && (
                <div style={{ padding: 16, color: '#9ca3af', fontSize: 13 }}>Loading…</div>
              )}
              {!loading && entries.length === 0 && !error && (
                <div style={{ padding: 16, color: '#9ca3af', fontSize: 13 }}>Empty</div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
