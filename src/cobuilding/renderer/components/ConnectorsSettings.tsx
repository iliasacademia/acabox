import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CONNECTOR_ID_RULE,
  connectorDisplayName,
  connectorTarget,
  describeStatus,
  validateConnector,
  type CatalogEntry,
  type ConnectorConfig,
  type ConnectorStatus,
  type ConnectorStatusReport,
  type ConnectorTransport,
} from '../../shared/connectors';
import './ConnectorsSettings.css';

/**
 * Settings → Connectors. Manages the user's MCP servers: a catalog of known
 * services for one-click add, plus a custom form for anything else.
 *
 * Everything shown here is observed state. A connector with no status report
 * renders "Unknown", never an invented "Connected" — per the no-mocks rule.
 */

type Draft = {
  id: string;
  label: string;
  transport: ConnectorTransport;
  url: string;
  command: string;
  args: string;
  headerRows: Array<{ key: string; value: string }>;
  alwaysLoad: boolean;
  catalogId?: string;
};

const EMPTY_DRAFT: Draft = {
  id: '',
  label: '',
  transport: 'http',
  url: '',
  command: '',
  args: '',
  headerRows: [{ key: '', value: '' }],
  alwaysLoad: false,
};

function draftFromCatalog(entry: CatalogEntry): Draft {
  return {
    ...EMPTY_DRAFT,
    id: entry.id,
    label: entry.label,
    transport: entry.transport,
    url: entry.url ?? '',
    command: entry.command ?? '',
    args: (entry.args ?? []).join(' '),
    headerRows: entry.auth === 'header' && entry.headerName
      ? [{ key: entry.headerName, value: '' }]
      : [{ key: '', value: '' }],
    catalogId: entry.catalogId,
  };
}

/**
 * Header values arrive blank — main masks them so secrets never cross IPC.
 * A blank value on an existing key means "keep the saved one" (the store
 * re-attaches it on save), so the row is rendered empty with a placeholder
 * saying as much rather than pretending to show the token.
 */
function draftFromConnector(c: ConnectorConfig): Draft {
  const rows = Object.entries(c.headers ?? {}).map(([key, value]) => ({ key, value }));
  return {
    id: c.id,
    label: c.label,
    transport: c.transport,
    url: c.url ?? '',
    command: c.command ?? '',
    args: (c.args ?? []).join(' '),
    headerRows: rows.length ? rows : [{ key: '', value: '' }],
    alwaysLoad: !!c.alwaysLoad,
    catalogId: c.catalogId,
  };
}

function draftToConnector(d: Draft, enabled: boolean): ConnectorConfig {
  const headers: Record<string, string> = {};
  for (const row of d.headerRows) {
    if (row.key.trim()) headers[row.key.trim()] = row.value;
  }
  return {
    id: d.id.trim(),
    label: d.label.trim() || d.id.trim(),
    transport: d.transport,
    ...(d.transport === 'stdio'
      ? {
        command: d.command.trim(),
        args: d.args.trim() ? d.args.trim().split(/\s+/) : undefined,
      }
      : { url: d.url.trim() }),
    ...(Object.keys(headers).length ? { headers } : {}),
    enabled,
    ...(d.catalogId ? { catalogId: d.catalogId } : {}),
    ...(d.alwaysLoad ? { alwaysLoad: true } : {}),
  };
}

const STATUS_CLASS: Record<ConnectorStatus, string> = {
  connected: 'connectorDot--ok',
  'needs-auth': 'connectorDot--warn',
  failed: 'connectorDot--error',
  pending: 'connectorDot--pending',
  disabled: 'connectorDot--idle',
  unknown: 'connectorDot--idle',
};

export const ConnectorsSettings: React.FC = () => {
  const [connectors, setConnectors] = useState<ConnectorConfig[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [unmanaged, setUnmanaged] = useState<{ path: string; serverNames: string[] } | null>(null);
  const [statusReports, setStatusReports] = useState<ConnectorStatusReport[]>([]);
  const [statusLive, setStatusLive] = useState(false);
  const [observedAt, setObservedAt] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const data = await window.connectorsAPI.list();
    setConnectors(data.connectors);
    setCatalog(data.catalog);
    setUnmanaged(data.unmanaged);
    setLoaded(true);
  }, []);

  const refreshStatus = useCallback(async () => {
    const s = await window.connectorsAPI.getStatus();
    setStatusReports(s.reports);
    setStatusLive(s.live);
    setObservedAt(s.observedAt);
  }, []);

  useEffect(() => { void load(); void refreshStatus(); }, [load, refreshStatus]);

  const statusFor = useMemo(() => {
    const map = new Map<string, ConnectorStatusReport>();
    for (const r of statusReports) map.set(r.name, r);
    return map;
  }, [statusReports]);

  const applyResult = (result: { success: boolean; error?: string; connectors: ConnectorConfig[]; pushed: boolean }) => {
    if (!result.success) { setError(result.error ?? 'Something went wrong.'); return false; }
    setConnectors(result.connectors);
    setError(null);
    setNotice(result.pushed
      ? 'Saved and applied to open chats.'
      : 'Saved. It will apply when the agent next starts.');
    void refreshStatus();
    return true;
  };

  const handleSave = async () => {
    if (!draft) return;
    const candidate = draftToConnector(draft, true);
    const others = connectors.filter((c) => c.id !== editingId).map((c) => c.id);
    const validation = validateConnector(candidate, others);
    if (!validation.ok) { setError(validation.error ?? 'Invalid connector.'); return; }

    setBusy(true);
    try {
      const result = await window.connectorsAPI.save(candidate, editingId ?? undefined);
      if (applyResult(result)) { setDraft(null); setEditingId(null); setPicking(false); }
    } finally { setBusy(false); }
  };

  const handleRemove = async (id: string) => {
    setBusy(true);
    try { applyResult(await window.connectorsAPI.remove(id)); }
    finally { setBusy(false); }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    setBusy(true);
    try { applyResult(await window.connectorsAPI.setEnabled(id, enabled)); }
    finally { setBusy(false); }
  };

  const handleRemoveUnmanaged = async () => {
    const res = await window.connectorsAPI.removeUnmanaged();
    if (!res.success) { setError(res.error ?? 'Could not remove the file.'); return; }
    setError(null);
    setNotice('Removed. It stops loading from the next chat.');
    void load();
  };

  if (!loaded) return null;

  const catalogTaken = new Set(connectors.map((c) => c.catalogId).filter(Boolean));

  return (
    <div className="connectors">
      <p className="wsSettings__hint">
        Connect Acabox to external services over MCP. Anything you connect becomes
        a set of tools the agent can call in chat. Changes apply to open chats
        straight away.
      </p>

      {connectors.length > 0 && (
        <div className="connectorList">
          {connectors.map((c) => {
            const report = statusFor.get(c.id);
            const status: ConnectorStatus = !c.enabled
              ? 'disabled'
              : (report?.status ?? 'unknown');
            return (
              <div key={c.id} className={`connectorRow${c.enabled ? '' : ' connectorRow--off'}`}>
                <span className={`connectorDot ${STATUS_CLASS[status]}`} aria-hidden="true" />
                <div className="connectorRow__main">
                  <div className="connectorRow__name">
                    {connectorDisplayName(c)}
                    <span className="connectorRow__chip">{c.transport.toUpperCase()}</span>
                  </div>
                  <div className="connectorRow__target" title={connectorTarget(c)}>
                    {connectorTarget(c)}
                  </div>
                  <div className="connectorRow__status">
                    {describeStatus(status)}
                    {report?.toolCount !== undefined && status === 'connected'
                      && ` · ${report.toolCount} tool${report.toolCount === 1 ? '' : 's'}`}
                    {report?.error && ` · ${report.error}`}
                    {status === 'needs-auth' && (
                      <> · ask in chat: <em>&ldquo;authenticate the {c.id} connector&rdquo;</em></>
                    )}
                  </div>
                </div>
                <div className="connectorRow__actions">
                  <button
                    type="button"
                    className="connectorBtn"
                    disabled={busy}
                    onClick={() => handleToggle(c.id, !c.enabled)}
                  >
                    {c.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    type="button"
                    className="connectorBtn"
                    disabled={busy}
                    onClick={() => {
                      setDraft(draftFromConnector(c));
                      setEditingId(c.id);
                      setPicking(false);
                      setError(null);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="connectorBtn connectorBtn--danger"
                    disabled={busy}
                    onClick={() => handleRemove(c.id)}
                  >
                    Remove
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {connectors.length === 0 && (
        <p className="wsSettings__hint" style={{ margin: '0 0 12px' }}>
          No connectors yet.
        </p>
      )}

      <div className="connectorStatusMeta">
        {statusLive
          ? 'Status read live from the running agent.'
          : observedAt
            ? `Status from the last chat session (${new Date(observedAt).toLocaleTimeString()}). Start a chat for live state.`
            : 'No chat session has run yet, so no status has been observed.'}
        <button type="button" className="connectorLink" onClick={() => void refreshStatus()}>
          Refresh
        </button>
      </div>

      {error && <p className="wsSettings__dirError">{error}</p>}
      {notice && !error && <p className="connectorNotice">{notice}</p>}

      {/* ── Add flow: catalog picker, then the form ── */}

      {!draft && !picking && (
        <button
          type="button"
          className="wsSettings__dirAddBtn"
          onClick={() => { setPicking(true); setError(null); setNotice(null); }}
        >
          + Add connector
        </button>
      )}

      {picking && !draft && (
        <div className="connectorPicker">
          <div className="connectorPicker__label">Choose a service</div>
          <div className="connectorPicker__grid">
            {catalog.map((entry) => {
              const already = catalogTaken.has(entry.catalogId);
              return (
                <button
                  key={entry.catalogId}
                  type="button"
                  className="connectorCard"
                  disabled={already}
                  onClick={() => { setDraft(draftFromCatalog(entry)); setEditingId(null); }}
                >
                  <div className="connectorCard__name">
                    {entry.label}
                    {already && <span className="connectorCard__added">added</span>}
                  </div>
                  <div className="connectorCard__desc">{entry.description}</div>
                  <div className="connectorCard__auth">
                    {entry.auth === 'oauth' ? 'Sign in from chat' : entry.auth === 'header' ? 'Needs a token' : 'No auth'}
                  </div>
                </button>
              );
            })}
            <button
              type="button"
              className="connectorCard connectorCard--custom"
              onClick={() => { setDraft({ ...EMPTY_DRAFT }); setEditingId(null); }}
            >
              <div className="connectorCard__name">Custom…</div>
              <div className="connectorCard__desc">
                Any MCP server: a remote HTTP/SSE endpoint or a local command.
              </div>
            </button>
          </div>
          <button type="button" className="connectorLink" onClick={() => setPicking(false)}>
            Cancel
          </button>
        </div>
      )}

      {draft && (
        <ConnectorForm
          draft={draft}
          setDraft={setDraft}
          editing={!!editingId}
          busy={busy}
          catalogEntry={catalog.find((e) => e.catalogId === draft.catalogId) ?? null}
          savedHeaderKeys={new Set(Object.keys(
            connectors.find((c) => c.id === editingId)?.headers ?? {},
          ))}
          onSave={handleSave}
          onCancel={() => { setDraft(null); setEditingId(null); setPicking(false); setError(null); }}
        />
      )}

      {/* ── Unmanaged .mcp.json ── */}

      {unmanaged && (
        <div className="connectorWarn">
          <div className="connectorWarn__title">Unmanaged servers in the workspace</div>
          <div className="connectorWarn__body">
            <code>{unmanaged.path}</code> declares{' '}
            {unmanaged.serverNames.map((n) => <code key={n}>{n}</code>).reduce<React.ReactNode[]>(
              (acc, el, i) => (i === 0 ? [el] : [...acc, ', ', el]), [],
            )}
            . Acabox loads it, but it isn't managed here — and the agent can write
            that file itself. Remove it unless you put it there deliberately.
          </div>
          <button type="button" className="connectorBtn connectorBtn--danger" onClick={handleRemoveUnmanaged}>
            Remove file
          </button>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------

const ConnectorForm: React.FC<{
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft | null>>;
  editing: boolean;
  busy: boolean;
  catalogEntry: CatalogEntry | null;
  /** Header keys that already have a stored (unshown) secret. */
  savedHeaderKeys: Set<string>;
  onSave: () => void;
  onCancel: () => void;
}> = ({ draft, setDraft, editing, busy, catalogEntry, savedHeaderKeys, onSave, onCancel }) => {
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  const setHeaderRow = (i: number, patch: Partial<{ key: string; value: string }>) =>
    setDraft((d) => d && ({
      ...d,
      headerRows: d.headerRows.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    }));

  return (
    <div className="connectorForm">
      <div className="connectorForm__title">
        {editing ? `Edit ${draft.id}` : catalogEntry ? `Add ${catalogEntry.label}` : 'Add a connector'}
      </div>

      {catalogEntry?.note && <div className="connectorForm__note">{catalogEntry.note}</div>}

      <label className="connectorField">
        <span className="connectorField__label">Name</span>
        <input
          className="connectorField__input connectorField__input--mono"
          value={draft.id}
          onChange={(e) => set('id', e.target.value)}
          placeholder="hex"
        />
        <span className="connectorField__help">
          The agent calls its tools as <code>mcp__{draft.id || 'name'}__…</code>. {CONNECTOR_ID_RULE}
        </span>
      </label>

      <label className="connectorField">
        <span className="connectorField__label">Transport</span>
        <select
          className="connectorField__input"
          value={draft.transport}
          onChange={(e) => set('transport', e.target.value as ConnectorTransport)}
        >
          <option value="http">HTTP (remote)</option>
          <option value="sse">SSE (remote)</option>
          <option value="stdio">Local command (stdio)</option>
        </select>
      </label>

      {draft.transport === 'stdio' ? (
        <>
          <label className="connectorField">
            <span className="connectorField__label">Command</span>
            <input
              className="connectorField__input connectorField__input--mono"
              value={draft.command}
              onChange={(e) => set('command', e.target.value)}
              placeholder="npx"
            />
          </label>
          <label className="connectorField">
            <span className="connectorField__label">Arguments</span>
            <input
              className="connectorField__input connectorField__input--mono"
              value={draft.args}
              onChange={(e) => set('args', e.target.value)}
              placeholder="-y @modelcontextprotocol/server-filesystem /path"
            />
            <span className="connectorField__help">Space-separated.</span>
          </label>
        </>
      ) : (
        <label className="connectorField">
          <span className="connectorField__label">URL</span>
          <input
            className="connectorField__input connectorField__input--mono"
            value={draft.url}
            onChange={(e) => set('url', e.target.value)}
            placeholder="https://app.hex.tech/mcp"
          />
          <span className="connectorField__help">
            Must be https:// — http:// is allowed only for localhost.
          </span>
        </label>
      )}

      {draft.transport !== 'stdio' && (
        <div className="connectorField">
          <span className="connectorField__label">Headers</span>
          {draft.headerRows.map((row, i) => (
            <div key={i} className="connectorHeaderRow">
              <input
                className="connectorField__input connectorField__input--mono"
                value={row.key}
                onChange={(e) => setHeaderRow(i, { key: e.target.value })}
                placeholder="Authorization"
              />
              <input
                className="connectorField__input connectorField__input--mono"
                type="password"
                value={row.value}
                onChange={(e) => setHeaderRow(i, { value: e.target.value })}
                placeholder={savedHeaderKeys.has(row.key) ? 'saved — leave blank to keep' : 'Bearer …'}
              />
              <button
                type="button"
                className="connectorBtn"
                onClick={() => setDraft((d) => d && ({
                  ...d,
                  headerRows: d.headerRows.length > 1
                    ? d.headerRows.filter((_, j) => j !== i)
                    : [{ key: '', value: '' }],
                }))}
              >
                −
              </button>
            </div>
          ))}
          <button
            type="button"
            className="connectorLink"
            onClick={() => setDraft((d) => d && ({ ...d, headerRows: [...d.headerRows, { key: '', value: '' }] }))}
          >
            + Add header
          </button>
          <span className="connectorField__help">
            Leave empty for services that sign in with OAuth — the agent handles
            that in chat. Tokens are encrypted with your macOS keychain and are
            never shown again after saving; leave a saved field blank to keep
            it, or delete the row to remove it.
          </span>
        </div>
      )}

      <label className="connectorCheck">
        <input
          type="checkbox"
          checked={draft.alwaysLoad}
          onChange={(e) => set('alwaysLoad', e.target.checked)}
        />
        <span>
          Always load this server&apos;s tools
          <span className="connectorField__help">
            Off by default: tools stay behind tool search, which keeps them out
            of every prompt. Turn on only if the agent keeps missing them.
          </span>
        </span>
      </label>

      <div className="connectorForm__actions">
        <button type="button" className="gsStep__btn gsStep__btn--secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="gsStep__btn gsStep__btn--primary" onClick={onSave} disabled={busy}>
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Add connector'}
        </button>
      </div>
    </div>
  );
};

export default ConnectorsSettings;
