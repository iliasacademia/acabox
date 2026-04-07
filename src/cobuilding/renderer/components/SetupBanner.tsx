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

const BUILD_ESTIMATED_MS = 15 * 60 * 1000; // 15 minutes

export const SetupBanner: React.FC = () => {
  const [phase, setPhase] = useState<SetupPhase>('idle');
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);
  const startedRef = useRef(false);
  const didWorkRef = useRef(false);
  const buildStartRef = useRef<number | null>(null);
  const buildTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  useEffect(() => {
    const cleanup = window.containerAPI.onSetupProgress((progress) => {
      const { stage, message } = progress;

      if (stage === 'install-podman' || stage === 'download') {
        didWorkRef.current = true;
        setPhase('install-podman');
      } else if (stage === 'download-percent') {
        setPercent(Math.min(100, parseInt(message, 10) || 0));
      } else if (stage === 'install-podman-done') {
        setPercent(100);
      } else if (stage === 'build-image' || stage === 'build') {
        didWorkRef.current = true;
        setPhase((prev) => {
          if (prev !== 'build-image') {
            startBuildTimer();
          }
          return 'build-image';
        });
      } else if (stage === 'build-image-done') {
        stopBuildTimer();
        setPercent(100);
      } else if (stage === 'setup-done') {
        stopBuildTimer();
        if (didWorkRef.current) {
          setPhase('done');
          setPercent(100);
          setTimeout(() => setVisible(false), 2000);
        } else {
          setVisible(false);
        }
        return;
      } else if (stage === 'init' || stage === 'start-machine') {
        didWorkRef.current = true;
        setPhase('install-podman');
      }
    });

    return () => {
      cleanup();
      stopBuildTimer();
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
    return (
      <div className="setupBanner setupBanner--error">
        <span className="setupBanner__title">Setup failed</span>
      </div>
    );
  }

  const title = PHASE_TITLES[phase];

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
