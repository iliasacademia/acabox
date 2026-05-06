import React, { useState, useEffect, useRef } from 'react';
import { setSetupState } from '../setupStore';
import './SetupBanner.css';

/**
 * Manages the initial environment setup (podman + base image download).
 * Updates the setupStore so other components (Composer, empty state) show
 * the appropriate blocking UI with progress. Only renders a visible banner
 * for errors.
 */

// Asymptotic progress timer for phases without real progress events
function createAsymptoticTimer(
  estimatedMs: number,
  basePercent: number,
  getMessage: () => string,
): { stop: () => void } {
  const start = Date.now();
  const interval = setInterval(() => {
    const elapsed = Date.now() - start;
    const progress = 1 - Math.exp(-elapsed / estimatedMs);
    const pct = Math.min(99, Math.round(basePercent + progress * (100 - basePercent)));
    setSetupState('downloading', getMessage(), pct);
  }, 500);
  return { stop: () => clearInterval(interval) };
}

// Module-scope guard: ensureSetup() must fire at most ONCE per JS session,
// not once per SetupBanner mount. If SetupBanner ever unmounts/remounts (a
// useRef reset would let the original component-scoped guard re-fire), the
// re-entrant ensureSetup → startAgentInfrastructure → startAgentServer path
// would `pkill -f agent-server.js` and kill any in-progress chat. Hoisting
// the flag outside the component closes that hole.
let hasEnsuredSetup = false;

export const SetupBanner: React.FC = () => {
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<{ stop: () => void } | null>(null);

  const stopTimer = () => {
    timerRef.current?.stop();
    timerRef.current = null;
  };

  const handleProgress = (progress: { stage: string; message: string; percent?: number }) => {
    const { stage, message } = progress;

    if (stage === 'install-podman' || stage === 'download') {
      stopTimer();
      setSetupState('downloading', 'Downloading Podman...', 0);
    } else if (stage === 'download-percent') {
      const raw = Math.min(100, parseInt(message, 10) || 0);
      setSetupState('downloading', 'Downloading Podman...', raw);
    } else if (stage === 'install-podman-done') {
      stopTimer();
      timerRef.current = createAsymptoticTimer(60_000, 0, () => 'Setting up Podman...');
    } else if (stage === 'init') {
      setSetupState('downloading', 'Initializing Podman VM...');
    } else if (stage === 'start-machine') {
      setSetupState('downloading', 'Starting Podman VM...');
    } else if (stage === 'pull') {
      stopTimer();
      setSetupState('downloading', 'Downloading base image...', 0);
      // Base image pull doesn't give granular progress — use asymptotic timer
      timerRef.current = createAsymptoticTimer(120_000, 0, () => 'Downloading base image...');
    } else if (stage === 'setup-done' || stage === 'ready') {
      // Base image is ready — unblock the UI. The container will start and
      // the agent's waitForAgent() handles its own "Agent initializing..."
      // spinner independently. App-specific deps install in the background.
      stopTimer();
      setSetupState('ready');
    }
  };

  useEffect(() => {
    const cleanupSetup = window.containerAPI.onSetupProgress(handleProgress);
    const cleanupProgress = window.containerAPI.onProgress(handleProgress);
    return () => { cleanupSetup(); cleanupProgress(); stopTimer(); };
  }, []);

  useEffect(() => {
    if (hasEnsuredSetup) return;
    hasEnsuredSetup = true;

    // Don't set 'downloading' here — only progress events should trigger
    // the blocking indicator. If the base image is already cached,
    // ensureSetup resolves immediately with no progress events → no flash.
    window.containerAPI.ensureSetup()
      .then(() => {
        // setup-done event already set 'ready' — this is a no-op fallback
        stopTimer();
        setSetupState('ready');
      })
      .catch((err) => {
        stopTimer();
        const msg = err instanceof Error ? err.message : String(err);
        setSetupState('error', msg);
        setError(msg);
      });
  }, []);

  if (!error) return null;

  const isPermissionError = error.includes('blocked') || error.includes('Gatekeeper') || error.includes('quarantine');

  const handleRetry = async () => {
    setError(null);
    setSetupState('downloading', 'Retrying setup...', 0);
    try {
      await window.containerAPI.deleteBinaries();
      hasEnsuredSetup = true; // explicit retry — keep the module guard set
      await window.containerAPI.ensureSetup();
      setSetupState('ready');
    } catch (err) {
      stopTimer();
      const msg = err instanceof Error ? err.message : String(err);
      setSetupState('error', msg);
      setError(msg);
    }
  };

  return (
    <div className="setupBanner setupBanner--error">
      <span className="setupBanner__title">Setup error</span>
      <span className="setupBanner__detail">
        {error}
        {isPermissionError && (
          <> You may also need to allow this in System Settings &gt; Privacy &amp; Security.</>
        )}
        {' '}<button className="setupBanner__retryBtn" onClick={handleRetry}>Retry</button>
      </span>
    </div>
  );
};
