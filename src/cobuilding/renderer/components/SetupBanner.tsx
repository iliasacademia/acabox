import React, { useState, useEffect } from 'react';
import './SetupBanner.css';

/**
 * Kicks off host setup (`ensureSetup`) at boot and shows a banner only when it
 * fails. There is no progress UI: main emits no download stages any more (the
 * Podman VM and its base image are gone), so a "setting up" state could only
 * ever be stale.
 */

export const SetupBanner: React.FC = () => {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.containerAPI.ensureSetup()
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  if (!error) return null;

  const isPermissionError = error.includes('blocked') || error.includes('Gatekeeper') || error.includes('quarantine');

  const handleRetry = async () => {
    setError(null);
    try {
      await window.containerAPI.ensureSetup();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="setupBanner setupBanner--error">
      <span className="setupBanner__title">Acabox couldn't finish starting</span>
      <span className="setupBanner__detail">
        Quit and reopen Acabox. If it keeps happening, the details below may help.
        {isPermissionError && (
          <> You may also need to allow Acabox in System Settings &gt; Privacy &amp; Security.</>
        )}
        {' '}<button className="setupBanner__retryBtn" onClick={handleRetry}>Try again</button>
        <details className="setupBanner__details">
          <summary>Details</summary>
          {error}
        </details>
      </span>
    </div>
  );
};
