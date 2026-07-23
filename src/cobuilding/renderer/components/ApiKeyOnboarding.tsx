import React, { useState } from 'react';
import { ArrowRightIcon, ArrowLeftIcon } from 'lucide-react';
import './WelcomeScreen.css';

interface ApiKeyOnboardingProps {
  onSuccess: () => void;
  onBack?: () => void;
}

const ApiKeyOnboarding: React.FC<ApiKeyOnboardingProps> = ({ onSuccess, onBack }) => {
  const [apiKey, setApiKey] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    const key = apiKey.trim();
    if (!key) return;
    setSaving(true);
    setError(null);
    try {
      const res = await window.authAPI.setApiKey(key, baseURL.trim() || undefined);
      if (res.success) {
        onSuccess();
      } else {
        setError(res.error || 'Could not save the API key.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="welcomeScreen">
      <div className="welcomeScreen__branding">
        <span className="welcomeScreen__brandName">Acabox</span>
        <span className="welcomeScreen__brandLabel">SETUP</span>
      </div>
      <div className="welcomeScreen__content">
        <span className="welcomeScreen__eyebrow">API KEY</span>
        <h1 className="welcomeScreen__heading">Connect your Anthropic API key</h1>
        <p className="welcomeScreen__subtitle">
          Acabox uses your own Anthropic API key to run the agent. It's stored
          locally on this device and never leaves it except in requests to
          Anthropic. Create one at console.anthropic.com.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: 420, marginTop: 8 }}>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-ant-..."
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter' && apiKey.trim() && !saving) handleSave(); }}
            style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border-color, #555)', fontFamily: 'monospace', fontSize: 13 }}
          />
          <input
            type="text"
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            placeholder="Base URL (optional — defaults to api.anthropic.com)"
            style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border-color, #555)', fontFamily: 'monospace', fontSize: 13 }}
          />
          {error && <div style={{ color: 'var(--error-color, #e5484d)', fontSize: 13 }}>{error}</div>}
        </div>

        <button
          className="welcomeScreen__cta"
          onClick={handleSave}
          disabled={saving || !apiKey.trim()}
          style={{ marginTop: 20 }}
        >
          {saving ? 'Saving…' : <>Continue <ArrowRightIcon className="welcomeScreen__arrow" /></>}
        </button>

        {onBack && (
          <button
            onClick={onBack}
            style={{ marginTop: 16, background: 'none', border: 'none', color: 'var(--text-secondary, #888)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}
          >
            <ArrowLeftIcon size={14} /> Back
          </button>
        )}
      </div>
    </div>
  );
};

export default ApiKeyOnboarding;
