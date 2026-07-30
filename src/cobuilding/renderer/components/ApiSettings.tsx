import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  API_ID_RULE,
  apiDisplayName,
  apiFromCatalog,
  describeAuthStyle,
  effectiveAllowedHosts,
  validateApi,
  type ApiAuthStyle,
  type ApiCatalogEntry,
  type ApiConfig,
  type ApiConfigForUi,
  type ApiCounters,
} from '../../shared/apis';
import './ApiSettings.css';

/**
 * Settings → APIs. HTTP endpoints the agent may reach through the host's
 * loopback proxy, with the credentials for the ones that need them.
 *
 * Reuses the `.connector*` classes wholesale — this is the sibling of the
 * Connectors section and they should be indistinguishable. `./ApiSettings.css`
 * holds only what has no connector equivalent.
 *
 * Everything shown is observed state: a credential is reported as present or
 * absent, never displayed, and usage counters are omitted entirely for an API
 * that has not been called rather than rendered as a zero.
 */

type Draft = {
  id: string;
  label: string;
  baseUrl: string;
  allowedHosts: string;
  authStyle: ApiAuthStyle;
  headerName: string;
  queryParam: string;
  secret: string;
  allowWrites: boolean;
  notes: string;
  catalogId?: string;
  docsUrl?: string;
};

const EMPTY_DRAFT: Draft = {
  id: '',
  label: '',
  baseUrl: '',
  allowedHosts: '',
  authStyle: 'none',
  headerName: '',
  queryParam: '',
  secret: '',
  allowWrites: false,
  notes: '',
};

function draftFromCatalog(entry: ApiCatalogEntry): Draft {
  const api = apiFromCatalog(entry);
  return {
    ...EMPTY_DRAFT,
    id: api.id,
    label: api.label,
    baseUrl: api.baseUrl,
    allowedHosts: api.allowedHosts.join(', '),
    authStyle: api.auth.style,
    headerName: api.auth.headerName ?? '',
    queryParam: api.auth.queryParam ?? '',
    allowWrites: api.allowWrites,
    notes: api.notes ?? '',
    catalogId: api.catalogId,
    docsUrl: api.docsUrl,
  };
}

function draftFromApi(a: ApiConfigForUi): Draft {
  return {
    id: a.id,
    label: a.label,
    baseUrl: a.baseUrl,
    allowedHosts: a.allowedHosts.join(', '),
    authStyle: a.auth.style,
    headerName: a.auth.headerName ?? '',
    queryParam: a.auth.queryParam ?? '',
    // Never populated from storage — the value doesn't cross IPC. Blank means
    // "keep the stored one" on save.
    secret: '',
    allowWrites: a.allowWrites,
    notes: a.notes ?? '',
    catalogId: a.catalogId,
    docsUrl: a.docsUrl,
  };
}

function draftToApi(d: Draft, enabled: boolean): ApiConfig {
  return {
    id: d.id.trim().toLowerCase(),
    label: d.label.trim() || d.id.trim(),
    baseUrl: d.baseUrl.trim(),
    allowedHosts: d.allowedHosts.split(',').map((h) => h.trim()).filter(Boolean),
    auth: {
      style: d.authStyle,
      ...(d.authStyle === 'header' ? { headerName: d.headerName.trim() } : {}),
      ...(d.authStyle === 'query' ? { queryParam: d.queryParam.trim() } : {}),
      ...(d.secret ? { secret: d.secret } : {}),
    },
    enabled,
    allowWrites: d.allowWrites,
    ...(d.notes.trim() ? { notes: d.notes.trim() } : {}),
    ...(d.catalogId ? { catalogId: d.catalogId } : {}),
    ...(d.docsUrl ? { docsUrl: d.docsUrl } : {}),
  };
}

function describeCounters(c: ApiCounters | undefined): string | null {
  if (!c || !c.calls) return null;
  const parts = [`${c.calls} call${c.calls === 1 ? '' : 's'} since launch`];
  if (c.refused) parts.push(`${c.refused} refused`);
  if (c.lastStatus) parts.push(`last ${c.lastStatus}`);
  return parts.join(' · ');
}

export const ApiSettings: React.FC = () => {
  const [apis, setApis] = useState<ApiConfigForUi[]>([]);
  const [catalog, setCatalog] = useState<ApiCatalogEntry[]>([]);
  const [counters, setCounters] = useState<Record<string, ApiCounters>>({});
  const [proxy, setProxy] = useState<{ running: boolean; baseUrl: string | null; error: string | null }>(
    { running: false, baseUrl: null, error: null },
  );
  const [loaded, setLoaded] = useState(false);

  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; text: string }>>({});

  const load = useCallback(async () => {
    const data = await window.apisAPI.list();
    setApis(data.apis);
    setCatalog(data.catalog);
    setCounters(data.counters);
    setProxy(data.proxy);
    setLoaded(true);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const catalogTaken = useMemo(
    () => new Set(apis.map((a) => a.catalogId).filter(Boolean)),
    [apis],
  );

  const applyResult = (result: { success: boolean; error?: string; apis: ApiConfigForUi[] }) => {
    if (!result.success) { setError(result.error ?? 'Something went wrong.'); return false; }
    setApis(result.apis);
    setError(null);
    // No push to the agent server: the proxy reads the store on every request,
    // so a change is live immediately. Only the prompt's summary is per-session.
    setNotice('Saved. Calls use it immediately; new chats also get it described in their prompt.');
    return true;
  };

  const handleSave = async () => {
    if (!draft) return;
    const candidate = draftToApi(draft, true);
    const others = apis.filter((a) => a.id !== editingId).map((a) => a.id);
    const validation = validateApi(candidate, others);
    if (!validation.ok) { setError(validation.error ?? 'Invalid API.'); return; }

    setBusy(true);
    try {
      const result = await window.apisAPI.save(candidate, editingId ?? undefined);
      if (applyResult(result)) { setDraft(null); setEditingId(null); setPicking(false); }
    } finally { setBusy(false); }
  };

  const handleClearSecret = async (a: ApiConfigForUi) => {
    setBusy(true);
    try {
      applyResult(await window.apisAPI.save({ ...a, auth: { ...a.auth } } as ApiConfig, a.id, true));
    } finally { setBusy(false); }
  };

  const handleTest = async (id: string) => {
    setTesting(id);
    try {
      const r = await window.apisAPI.test(id);
      setTestResults((prev) => ({
        ...prev,
        [id]: {
          ok: r.ok,
          text: r.error ?? (r.ok ? `Reached it — HTTP ${r.status}.` : `HTTP ${r.status}.`),
        },
      }));
      void load();   // pick up the counter this call just incremented
    } finally { setTesting(null); }
  };

  const mutate = async (fn: () => Promise<{ success: boolean; error?: string; apis: ApiConfigForUi[] }>) => {
    setBusy(true);
    try { applyResult(await fn()); }
    finally { setBusy(false); }
  };

  if (!loaded) return null;

  return (
    <div className="connectors">
      <p className="wsSettings__hint">
        HTTP APIs Claude may call directly, for services with no MCP connector —
        or where the connector is read-only and the REST API isn&apos;t. Acabox
        holds the credentials and attaches them itself, so a key is never shown
        to the agent, written into a script, or stored in a chat.
      </p>

      {!proxy.running && (
        <div className="connectorWarn">
          <div className="connectorWarn__title">The API proxy isn&apos;t running</div>
          <div className="connectorWarn__body">
            {proxy.error
              ? <>It failed to start: <code>{proxy.error}</code></>
              : 'It starts with the agent — open a chat, or restart Acabox.'}{' '}
            Nothing configured here can be called until it does, and Claude is not
            told the APIs exist.
          </div>
        </div>
      )}

      {apis.length > 0 && (
        <div className="connectorList">
          {apis.map((a) => {
            const counterText = describeCounters(counters[a.id]);
            const test = testResults[a.id];
            return (
              <div key={a.id} className={`connectorRow${a.enabled ? '' : ' connectorRow--off'}`}>
                <span
                  className={`connectorDot ${a.enabled ? 'connectorDot--ok' : 'connectorDot--idle'}`}
                  aria-hidden="true"
                />
                <div className="connectorRow__main">
                  <div className="connectorRow__name">
                    {apiDisplayName(a)}
                    <span className="connectorRow__chip">
                      {a.allowWrites ? 'READ & WRITE' : 'READ ONLY'}
                    </span>
                    {a.auth.style !== 'none' && (
                      <span className={`apiKeyChip${a.hasSecret ? ' apiKeyChip--set' : ''}`}>
                        {a.hasSecret ? 'KEY SET' : 'NO KEY'}
                      </span>
                    )}
                  </div>
                  <div className="connectorRow__target" title={a.baseUrl}>{a.baseUrl}</div>
                  <div className="connectorRow__status">
                    {describeAuthStyle(a.auth)}
                    {` · ${effectiveAllowedHosts(a).join(', ')}`}
                    {counterText && ` · ${counterText}`}
                  </div>
                  {test && (
                    <div className={`apiTestResult${test.ok ? ' apiTestResult--ok' : ''}`}>
                      {test.text}
                    </div>
                  )}
                </div>
                <div className="connectorRow__actions">
                  <button
                    type="button"
                    className="connectorBtn"
                    disabled={busy || testing === a.id || !proxy.running}
                    onClick={() => void handleTest(a.id)}
                    title={proxy.running ? 'Send one real GET at the base URL' : 'The proxy is not running'}
                  >
                    {testing === a.id ? 'Testing…' : 'Test'}
                  </button>
                  <button
                    type="button"
                    className="connectorBtn"
                    disabled={busy}
                    onClick={() => void mutate(() => window.apisAPI.setEnabled(a.id, !a.enabled))}
                  >
                    {a.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    type="button"
                    className="connectorBtn"
                    disabled={busy}
                    onClick={() => {
                      setDraft(draftFromApi(a));
                      setEditingId(a.id);
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
                    onClick={() => void mutate(() => window.apisAPI.remove(a.id))}
                  >
                    Remove
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {apis.length === 0 && (
        <p className="wsSettings__hint" style={{ margin: '0 0 12px' }}>
          No APIs yet.
        </p>
      )}

      {error && <p className="wsSettings__dirError">{error}</p>}
      {notice && !error && <p className="connectorNotice">{notice}</p>}

      {!draft && !picking && (
        <button
          type="button"
          className="wsSettings__dirAddBtn"
          onClick={() => { setPicking(true); setError(null); setNotice(null); }}
        >
          + Add API
        </button>
      )}

      {picking && !draft && (
        <div className="connectorPicker">
          <div className="connectorPicker__label">Choose an API</div>
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
                    {entry.auth.style === 'none'
                      ? 'No key needed'
                      : entry.secretOptional ? 'Key optional' : 'Needs a key'}
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
              <div className="connectorCard__desc">Any HTTPS API, with or without a key.</div>
            </button>
          </div>
          <button type="button" className="connectorLink" onClick={() => setPicking(false)}>
            Cancel
          </button>
        </div>
      )}

      {draft && (
        <ApiForm
          draft={draft}
          setDraft={setDraft}
          editing={!!editingId}
          hasStoredSecret={!!apis.find((a) => a.id === editingId)?.hasSecret}
          busy={busy}
          onClearSecret={() => {
            const existing = apis.find((a) => a.id === editingId);
            if (existing) void handleClearSecret(existing);
          }}
          onSave={handleSave}
          onCancel={() => { setDraft(null); setEditingId(null); setPicking(false); setError(null); }}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------

const ApiForm: React.FC<{
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft | null>>;
  editing: boolean;
  hasStoredSecret: boolean;
  busy: boolean;
  onClearSecret: () => void;
  onSave: () => void;
  onCancel: () => void;
}> = ({ draft, setDraft, editing, hasStoredSecret, busy, onClearSecret, onSave, onCancel }) => {
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  return (
    <div className="connectorForm">
      <div className="connectorForm__title">
        {editing ? `Edit ${draft.id}` : draft.catalogId ? `Add ${draft.label}` : 'Add an API'}
      </div>

      <label className="connectorField">
        <span className="connectorField__label">Name</span>
        <input
          className="connectorField__input connectorField__input--mono"
          value={draft.id}
          onChange={(e) => set('id', e.target.value)}
          placeholder="hex"
        />
        <span className="connectorField__help">
          Claude calls it as <code>$ACABOX_API_BASE/{draft.id || 'name'}/…</code>.{' '}
          {API_ID_RULE} Uppercase is lowercased on save.
        </span>
      </label>

      <label className="connectorField">
        <span className="connectorField__label">Base URL</span>
        <input
          className="connectorField__input connectorField__input--mono"
          value={draft.baseUrl}
          onChange={(e) => set('baseUrl', e.target.value)}
          placeholder="https://app.hex.tech/api/v1/"
        />
        <span className="connectorField__help">
          Requests resolve against this, and on this host they may not escape its
          path — so a trailing slash matters. https:// only, except localhost.
        </span>
      </label>

      <label className="connectorField">
        <span className="connectorField__label">Authentication</span>
        <select
          className="connectorField__input"
          value={draft.authStyle}
          onChange={(e) => set('authStyle', e.target.value as ApiAuthStyle)}
        >
          <option value="none">None — public API</option>
          <option value="bearer">Bearer token (Authorization: Bearer …)</option>
          <option value="header">Custom header</option>
          <option value="query">Query parameter</option>
        </select>
      </label>

      {draft.authStyle === 'header' && (
        <label className="connectorField">
          <span className="connectorField__label">Header name</span>
          <input
            className="connectorField__input connectorField__input--mono"
            value={draft.headerName}
            onChange={(e) => set('headerName', e.target.value)}
            placeholder="x-api-key"
          />
        </label>
      )}

      {draft.authStyle === 'query' && (
        <label className="connectorField">
          <span className="connectorField__label">Parameter name</span>
          <input
            className="connectorField__input connectorField__input--mono"
            value={draft.queryParam}
            onChange={(e) => set('queryParam', e.target.value)}
            placeholder="api_key"
          />
        </label>
      )}

      {draft.authStyle !== 'none' && (
        <label className="connectorField">
          <span className="connectorField__label">API key</span>
          <input
            className="connectorField__input connectorField__input--mono"
            type="password"
            value={draft.secret}
            onChange={(e) => set('secret', e.target.value)}
            placeholder={hasStoredSecret ? 'saved — leave blank to keep' : 'paste your key'}
          />
          <span className="connectorField__help">
            Encrypted with your macOS keychain and never shown again. Leave blank
            to keep the saved one.
            {hasStoredSecret && (
              <>
                {' '}
                <button type="button" className="connectorLink" onClick={onClearSecret} disabled={busy}>
                  Remove the saved key
                </button>
              </>
            )}
          </span>
        </label>
      )}

      <label className="connectorField">
        <span className="connectorField__label">Extra allowed hosts</span>
        <input
          className="connectorField__input connectorField__input--mono"
          value={draft.allowedHosts}
          onChange={(e) => set('allowedHosts', e.target.value)}
          placeholder="files.example.org, .example-cdn.com"
        />
        <span className="connectorField__help">
          The base URL&apos;s own host is always allowed. Add others only if this
          API redirects downloads elsewhere — a refusal names the exact host, so
          you can come back and paste it. A leading dot matches subdomains
          (<code>.zenodo.org</code> covers <code>files.zenodo.org</code>).
        </span>
      </label>

      <label className="connectorField">
        <span className="connectorField__label">Notes for Claude</span>
        <textarea
          className="connectorField__input apiNotes"
          value={draft.notes}
          onChange={(e) => set('notes', e.target.value)}
          rows={3}
          placeholder="What this API is for, and the one thing Claude needs to know about it."
        />
        <span className="connectorField__help">
          Goes into the prompt verbatim. This is the field that stops Claude
          guessing endpoints — a sentence here is worth more than any other
          setting on this form.
        </span>
      </label>

      <label className="connectorCheck">
        <input
          type="checkbox"
          checked={draft.allowWrites}
          onChange={(e) => set('allowWrites', e.target.checked)}
        />
        <span>
          Allow writes
          <span className="connectorField__help">
            Off by default: only GET and HEAD are permitted, and anything else is
            refused by Acabox before it reaches the network. Turn this on only for
            an API you intend Claude to change things in — a page it reads
            mid-task could otherwise talk it into a DELETE.
          </span>
        </span>
      </label>

      <div className="connectorForm__actions">
        <button type="button" className="gsStep__btn gsStep__btn--secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="gsStep__btn gsStep__btn--primary" onClick={onSave} disabled={busy}>
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Add API'}
        </button>
      </div>
    </div>
  );
};

export default ApiSettings;
