import React, { useCallback, useEffect, useState } from 'react';
import type { ShareSettingsForUi } from '../../main/share/shareStore';

/**
 * Settings → Sharing. Site URL, API URL and the publish token that let
 * `window.shareAPI` reach the operator's own Cloudflare Workers deployment
 * (`docs/design/sharing.md`; contracts in `docs/design/sharing-tickets.md`,
 * ticket U2).
 *
 * Reuses the `.connector*` / `.apiTestResult` / `.wsSettings__*` classes
 * wholesale — ApiSettings and ConnectorsSettings are mounted in the same
 * settings page (`DirectoryPermissions.tsx`) and already carry this CSS, the
 * same way ApiSettings itself reuses `.connectors` from ConnectorsSettings.css
 * with no local import. No new class is needed here, so there is no
 * `SharingSettings.css`.
 *
 * Like ApiSettings, everything shown is observed state: the token itself
 * never crosses IPC — only `hasToken` does — so it is never rendered, only a
 * placeholder standing in for "something is stored".
 */

const TOKEN_PLACEHOLDER = '•'.repeat(8); // eight bullet characters

export const SharingSettings: React.FC = () => {
  const [settings, setSettings] = useState<ShareSettingsForUi | null>(null);
  const [siteUrl, setSiteUrl] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const data = await window.shareAPI.getSettings();
    setSettings(data);
    setSiteUrl(data.siteUrl);
    setApiUrl(data.apiUrl);
    setToken('');
    setClearToken(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!settings) return null;

  const dirty =
    siteUrl !== settings.siteUrl ||
    apiUrl !== settings.apiUrl ||
    token !== '' ||
    clearToken;

  const canTest = settings.hasToken && !!settings.siteUrl && !!settings.apiUrl;

  const handleSave = async () => {
    setBusy(true);
    setError(null);
    try {
      const patch: { siteUrl: string; apiUrl: string; publishToken?: string; clearToken?: boolean } = {
        siteUrl,
        apiUrl,
        ...(token ? { publishToken: token } : {}),
        ...(clearToken ? { clearToken: true } : {}),
      };
      const result = await window.shareAPI.saveSettings(patch);
      if (!result.ok) {
        setError(result.error ?? 'Something went wrong.');
        return;
      }
      setTestResult(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const r = await window.shareAPI.test();
      setTestResult({
        ok: r.ok,
        text: r.ok ? 'Connected' : r.status ? `HTTP ${r.status}: ${r.error}` : (r.error ?? 'Something went wrong.'),
      });
    } finally {
      setTesting(false);
    }
  };

  const handleClearToken = () => {
    setToken('');
    setClearToken(true);
  };

  return (
    <div className="connectors">
      <p className="wsSettings__hint">
        Publish a mini-app or a single workspace file as a read-only, login-gated
        link on your own Cloudflare Workers deployment — setup lives in{' '}
        <code>src/share-workers/README.md</code>. Viewers sign in with an
        @academia.edu Google account, and Cloudflare Access is free for the
        first 50 viewers.
      </p>

      <label className="connectorField">
        <span className="connectorField__label">Site URL</span>
        <input
          className="connectorField__input connectorField__input--mono"
          value={siteUrl}
          onChange={(e) => setSiteUrl(e.target.value)}
          placeholder="https://acabox-share.<account>.workers.dev"
        />
      </label>

      <label className="connectorField">
        <span className="connectorField__label">API URL</span>
        <input
          className="connectorField__input connectorField__input--mono"
          value={apiUrl}
          onChange={(e) => setApiUrl(e.target.value)}
          placeholder="https://acabox-share-api.<account>.workers.dev"
        />
      </label>

      <label className="connectorField">
        <span className="connectorField__label">Publish token</span>
        <input
          className="connectorField__input connectorField__input--mono"
          type="password"
          value={token}
          onChange={(e) => { setToken(e.target.value); setClearToken(false); }}
          placeholder={settings.hasToken ? TOKEN_PLACEHOLDER : 'paste your publish token'}
        />
        <span className="connectorField__help">
          {clearToken
            ? 'The stored token will be removed when you save.'
            : 'Leave blank to keep the stored token.'}
          {settings.hasToken && !clearToken && (
            <>
              {' '}
              <button type="button" className="connectorLink" onClick={handleClearToken} disabled={busy}>
                Clear token
              </button>
            </>
          )}
        </span>
      </label>

      {error && <p className="wsSettings__dirError">{error}</p>}

      <div className="connectorForm__actions">
        <button
          type="button"
          className="gsStep__btn gsStep__btn--secondary"
          disabled={!canTest || testing}
          onClick={() => void handleTest()}
          title={canTest ? 'Send one real GET at /v1/health' : 'Save a site URL, API URL and token first'}
        >
          {testing ? 'Testing…' : 'Test'}
        </button>
        <button
          type="button"
          className="gsStep__btn gsStep__btn--primary"
          disabled={!dirty || busy}
          onClick={() => void handleSave()}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>

      {testResult && (
        <p className={`apiTestResult${testResult.ok ? ' apiTestResult--ok' : ''}`}>{testResult.text}</p>
      )}
    </div>
  );
};

export default SharingSettings;
