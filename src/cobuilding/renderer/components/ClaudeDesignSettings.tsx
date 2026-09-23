import React, { useCallback, useEffect, useState } from 'react';

/**
 * Settings → Claude Design. Signs the agent in to claude.ai/design so its
 * `DesignSync` tool can reach the user's design-system projects. The flow is
 * the bundled CLI's own sign-in, driven from main/claudeDesignLogin.ts.
 */

type Status = Awaited<ReturnType<Window['claudeDesignAPI']['getStatus']>>;

type Flow =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'waiting'; manualFirst: boolean }
  | { phase: 'failed'; message: string };

interface ClaudeDesignSettingsProps {
  /**
   * Whether Settings is the visible tab. The status is read on arrival, not
   * at mount: Settings mounts at boot behind `display:none`, so a mount-time
   * read would spawn the CLI (and touch the keychain) on every launch and
   * then show that boot snapshot forever. See `ApiSettingsProps.active`.
   */
  active?: boolean;
}

export const ClaudeDesignSettings: React.FC<ClaudeDesignSettingsProps> = ({ active = true }) => {
  const [status, setStatus] = useState<Status | null>(null);
  const [flow, setFlow] = useState<Flow>({ phase: 'idle' });
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeSent, setCodeSent] = useState(false);

  const refresh = useCallback(() => {
    window.claudeDesignAPI
      .getStatus()
      .then(setStatus)
      .catch((err) => setStatus({ available: false, signedIn: false, canSignInHere: false, reason: String(err) }));
  }, []);

  useEffect(() => {
    if (active) refresh();
  }, [active, refresh]);

  useEffect(
    () =>
      window.claudeDesignAPI.onEvent((event) => {
        if (event.state === 'waiting') {
          setFlow({ phase: 'waiting', manualFirst: event.manualFirst });
          return;
        }
        setCode('');
        setCodeSent(false);
        setCodeError(null);
        if (event.ok) {
          setFlow({ phase: 'idle' });
          refresh();
        } else {
          setFlow({ phase: 'failed', message: event.message });
        }
      }),
    [refresh],
  );

  const handleSignIn = async () => {
    setFlow({ phase: 'starting' });
    const res = await window.claudeDesignAPI.signIn();
    if (!res.ok) setFlow({ phase: 'failed', message: res.error });
  };

  const handleSubmitCode = async () => {
    setCodeError(null);
    const res = await window.claudeDesignAPI.submitCode(code);
    if (res.ok) setCodeSent(true);
    else setCodeError(res.error);
  };

  const busy = flow.phase === 'starting' || flow.phase === 'waiting';

  let description: string;
  if (!status) description = 'Checking…';
  else if (!status?.available) description = status?.reason || 'Claude Design is not available in this build.';
  else if (status.signedIn) description = 'Signed in. Chats can read your claude.ai/design design-system projects.';
  else if (!status.canSignInHere) description = status.reason || 'Sign-in is not possible on this machine.';
  else description = 'Not signed in. Sign in to let chats read your claude.ai/design design-system projects.';

  const canStart = !!status?.available && status.canSignInHere && !busy;

  return (
    <div className="wsSettings__dirRow" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div className="wsSettings__integrationName">Claude Design</div>
          <div className="wsSettings__integrationDesc">{description}</div>
        </div>
        {!busy && (
          <button
            type="button"
            className="gsStep__btn gsStep__btn--secondary"
            disabled={!canStart}
            onClick={handleSignIn}
          >
            {status?.signedIn ? 'Sign in again' : 'Sign in'}
          </button>
        )}
      </div>

      {flow.phase === 'starting' && <div className="wsSettings__integrationDesc">Starting sign-in…</div>}

      {flow.phase === 'waiting' && (
        <>
          <div className="wsSettings__integrationDesc">
            Finish signing in in your browser. The link stops working after five minutes.
            {flow.manualFirst
              ? ' When the page shows a code, paste it below.'
              : ' If the page shows a code instead of returning you here, paste it below.'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={code}
              onChange={(e) => { setCode(e.target.value); setCodeSent(false); }}
              placeholder="Code from the sign-in page"
              className="connectorField__input connectorField__input--mono"
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="gsStep__btn gsStep__btn--secondary"
              disabled={!code.trim()}
              onClick={handleSubmitCode}
            >
              Submit code
            </button>
          </div>
          {codeSent && <div className="wsSettings__integrationDesc">Code sent. Waiting for confirmation…</div>}
          {codeError && <p className="wsSettings__dirError">{codeError}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="gsStep__btn gsStep__btn--secondary" onClick={() => window.claudeDesignAPI.reopenPage()}>
              Open the page again
            </button>
            <button type="button" className="gsStep__btn gsStep__btn--secondary" onClick={() => window.claudeDesignAPI.cancel()}>
              Cancel
            </button>
          </div>
        </>
      )}

      {flow.phase === 'failed' && (
        <p className="wsSettings__dirError">{flow.message}</p>
      )}
    </div>
  );
};

export default ClaudeDesignSettings;
