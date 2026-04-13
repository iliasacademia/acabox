import React, { useState, useEffect, useRef } from 'react';
import './SetupBanner.css';

type SetupPhase = 'idle' | 'install-podman' | 'build-image' | 'done' | 'error';

const PHASE_TITLES: Record<SetupPhase, string> = {
  'idle': 'Checking setup...',
  'install-podman': 'Installing Podman...',
  'build-image': 'Installing scientific software (this may take a while)...',
  'done': 'Setup complete',
  'error': 'Setup failed',
};

// Download is 0-75%, post-download setup (machine init/start) is 75-100%
const DOWNLOAD_WEIGHT = 0.75;
// Estimated time for post-download setup (machine init ~30s + start ~10s)
const POST_DOWNLOAD_ESTIMATED_MS = 60_000;

const BUILD_ESTIMATED_MS = 15 * 60 * 1000; // 15 minutes

export const SetupBanner: React.FC = () => {
  const [phase, setPhase] = useState<SetupPhase>('idle');
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);
  const [statusText, setStatusText] = useState<string | null>(null);
  const startedRef = useRef(false);
  const didWorkRef = useRef(false);
  const buildStartRef = useRef<number | null>(null);
  const buildTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const postDownloadStartRef = useRef<number | null>(null);
  const postDownloadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startPostDownloadTimer = () => {
    postDownloadStartRef.current = Date.now();
    postDownloadTimerRef.current = setInterval(() => {
      if (!postDownloadStartRef.current) return;
      const elapsed = Date.now() - postDownloadStartRef.current;
      // Asymptotic progress from 75% to 99% — always moving, never stuck
      const remaining = 1 - DOWNLOAD_WEIGHT; // 0.25
      const progress = remaining * (1 - Math.exp(-elapsed / POST_DOWNLOAD_ESTIMATED_MS));
      setPercent(Math.min(99, Math.round((DOWNLOAD_WEIGHT + progress) * 100)));
    }, 500);
  };

  const stopPostDownloadTimer = () => {
    if (postDownloadTimerRef.current) {
      clearInterval(postDownloadTimerRef.current);
      postDownloadTimerRef.current = null;
    }
    postDownloadStartRef.current = null;
  };

  const startBuildTimer = () => {
    buildStartRef.current = Date.now();
    setPercent(0);
    buildTimerRef.current = setInterval(() => {
      if (!buildStartRef.current) return;
      const elapsed = Date.now() - buildStartRef.current;
      const pct = Math.min(99, Math.round((elapsed / BUILD_ESTIMATED_MS) * 100));
      setPercent(pct);
    }, 1000);
  };

  const stopBuildTimer = () => {
    if (buildTimerRef.current) {
      clearInterval(buildTimerRef.current);
      buildTimerRef.current = null;
    }
    buildStartRef.current = null;
  };

  const handleProgress = (progress: { stage: string; message: string }) => {
    const { stage, message } = progress;

    if (stage === 'install-podman' || stage === 'download') {
      didWorkRef.current = true;
      setVisible(true);
      setPhase('install-podman');
      setStatusText('Downloading Podman...');
    } else if (stage === 'download-percent') {
      // Download maps to 0-75% of the install-podman phase
      const raw = Math.min(100, parseInt(message, 10) || 0);
      setPercent(Math.round(raw * DOWNLOAD_WEIGHT));
    } else if (stage === 'install-podman-done') {
      // Download done — start the post-download timer for the remaining 25%
      setPercent(Math.round(DOWNLOAD_WEIGHT * 100));
      setStatusText('Setting up Podman...');
      startPostDownloadTimer();
    } else if (stage === 'init') {
      didWorkRef.current = true;
      setVisible(true);
      setPhase('install-podman');
      setStatusText('Initializing Podman VM...');
    } else if (stage === 'start-machine') {
      didWorkRef.current = true;
      setVisible(true);
      setPhase('install-podman');
      setStatusText('Starting Podman VM...');
    } else if (stage === 'build-image' || stage === 'build' || stage === 'pull') {
      stopPostDownloadTimer();
      didWorkRef.current = true;
      setVisible(true);
      setStatusText(null);
      setPhase((prev) => {
        if (prev !== 'build-image') {
          startBuildTimer();
        }
        return 'build-image';
      });
    } else if (stage === 'build-image-done') {
      stopBuildTimer();
      setPercent(100);
    } else if (stage === 'setup-done' || stage === 'ready') {
      stopPostDownloadTimer();
      stopBuildTimer();
      if (didWorkRef.current) {
        setPhase('done');
        setPercent(100);
        setTimeout(() => setVisible(false), 2000);
      } else {
        setVisible(false);
      }
      didWorkRef.current = false;
      setStatusText(null);
      return;
    }
  };

  useEffect(() => {
    const cleanupSetup = window.containerAPI.onSetupProgress(handleProgress);
    const cleanupProgress = window.containerAPI.onProgress(handleProgress);

    return () => {
      cleanupSetup();
      cleanupProgress();
      stopBuildTimer();
      stopPostDownloadTimer();
    };
  }, []);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    window.containerAPI.ensureSetup()
      .then(() => {
        // setup-done event will handle the transition
      })
      .catch((err) => {
        stopBuildTimer();
        setPhase('error');
        setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  if (!visible) return null;
  if (phase === 'idle') return null;

  if (phase === 'done') {
    return (
      <div className="setupBanner setupBanner--done">
        <span className="setupBanner__title">Setup complete</span>
      </div>
    );
  }
  if (phase === 'error') {
    const isPermissionError = error?.includes('blocked') || error?.includes('Gatekeeper') || error?.includes('quarantine');

    const handleRetry = async () => {
      setPhase('idle');
      setError(null);
      setPercent(0);
      didWorkRef.current = false;
      try {
        await window.containerAPI.deleteBinaries();
        await window.containerAPI.ensureSetup();
      } catch (err) {
        stopBuildTimer();
        setPhase('error');
        setError(err instanceof Error ? err.message : String(err));
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
  }

  const title = statusText || PHASE_TITLES[phase];

  return (
    <div className="setupBanner">
      <span className="setupBanner__title">{title}</span>
      <div className="setupBanner__progressTrack">
        <div
          className="setupBanner__progressBar"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
};
