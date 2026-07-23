import React, { useState, useEffect } from 'react';

/**
 * In-app "Anthropic API Key" settings section. Shows the active key (masked)
 * and where it comes from (env vs settings), and lets the user paste/update a
 * key. Reused by the Settings tab and the Debug panel.
 */
export const ApiKeySettings: React.FC = () => {
  const [maskedKey, setMaskedKey] = useState<string | null>(null);
  const [source, setSource] = useState<'env' | 'settings' | null>(null);
  const [baseURL, setBaseURL] = useState<string | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newBaseURL, setNewBaseURL] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ success: boolean; error?: string } | null>(null);

  const load = () => {
    Promise.all([window.authAPI.getApiKey(), window.authAPI.getApiKeyStatus()]).then(
      ([{ apiKey }, status]) => {
        setMaskedKey(apiKey ? `${apiKey.slice(0, 10)}…${apiKey.slice(-4)}` : null);
        setSource(status.source);
        setBaseURL(status.baseURL);
      },
    );
  };

  useEffect(load, []);

  const handleSave = async () => {
    const key = newKey.trim();
    if (!key) return;
    setSaving(true);
    setResult(null);
    try {
      const res = await window.authAPI.setApiKey(key, newBaseURL.trim() || undefined);
      setResult(res);
      if (res.success) {
        setNewKey('');
        setNewBaseURL('');
        load();
      }
    } catch (err) {
      setResult({ success: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  const envManaged = source === 'env';

  return (
    <div className="wsSettings__dirRow" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
      <div>
        <div className="wsSettings__integrationName">Anthropic API key</div>
        <div className="wsSettings__integrationDesc">
          {maskedKey
            ? `Active key: ${maskedKey}${source ? ` (from ${source})` : ''}${baseURL ? ` · ${baseURL}` : ''}`
            : 'No API key set. Paste one below to use Acabox.'}
        </div>
      </div>

      {envManaged ? (
        <div className="wsSettings__integrationDesc">
          The key is set via the ANTHROPIC_API_KEY environment variable and takes
          precedence. Unset it to manage the key here.
        </div>
      ) : (
        <>
          <input
            type="password"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="sk-ant-..."
            style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border-color, #555)', fontFamily: 'monospace', fontSize: 12 }}
          />
          <input
            type="text"
            value={newBaseURL}
            onChange={(e) => setNewBaseURL(e.target.value)}
            placeholder="Base URL (optional — defaults to api.anthropic.com)"
            style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border-color, #555)', fontFamily: 'monospace', fontSize: 12 }}
          />
          <div>
            <button
              type="button"
              className="gsStep__btn gsStep__btn--secondary"
              disabled={saving || !newKey.trim()}
              onClick={handleSave}
            >
              {saving ? 'Saving…' : maskedKey ? 'Update key' : 'Save key'}
            </button>
          </div>
          {result && !result.success && (
            <div style={{ color: 'var(--error-color, #e5484d)', fontSize: 12 }}>{result.error || 'Save failed'}</div>
          )}
          {result?.success && (
            <div style={{ color: 'var(--success-color, #30a46c)', fontSize: 12 }}>Saved.</div>
          )}
        </>
      )}
    </div>
  );
};

export default ApiKeySettings;
