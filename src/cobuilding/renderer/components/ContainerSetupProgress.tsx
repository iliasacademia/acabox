import React, { useState, useEffect, useRef, useCallback } from 'react';
import './WorkspaceOnboarding.css';

interface ContainerSetupProgressProps {
  onComplete: () => void;
  onError?: (error: string) => void;
}

const ContainerSetupProgress: React.FC<ContainerSetupProgressProps> = ({ onComplete }) => {
  const [statusMessage, setStatusMessage] = useState('Preparing your environment...');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(Date.now());
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const hasStartedRef = useRef(false);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startAsymptoticTimer = useCallback((estimatedMs: number) => {
    stopTimer();
    startTimeRef.current = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      const p = 1 - Math.exp(-elapsed / estimatedMs);
      setProgress(Math.min(95, Math.round(p * 95)));
    }, 500);
  }, [stopTimer]);

  const startSetup = useCallback(async () => {
    setError(null);
    setProgress(0);
    setStatusMessage('Preparing your environment...');
    startAsymptoticTimer(120_000);

    try {
      await window.containerAPI.ensureReady();
      stopTimer();
      setProgress(100);
      setStatusMessage('Ready');
      setTimeout(() => {
        onCompleteRef.current();
      }, 400);
    } catch (err) {
      stopTimer();
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    }
  }, [startAsymptoticTimer, stopTimer]);

  useEffect(() => {
    const cleanupSetup = window.containerAPI.onSetupProgress((p) => {
      const { stage, message } = p;
      if (stage === 'install-podman' || stage === 'download') {
        setStatusMessage('Downloading Podman...');
      } else if (stage === 'download-percent') {
        const raw = Math.min(100, parseInt(message, 10) || 0);
        setProgress(Math.round(raw * 0.3));
        setStatusMessage('Downloading Podman...');
      } else if (stage === 'install-podman-done') {
        setStatusMessage('Setting up Podman...');
        setProgress(30);
      } else if (stage === 'init') {
        setStatusMessage('Initializing environment...');
        setProgress(40);
      } else if (stage === 'start-machine') {
        setStatusMessage('Starting environment...');
        setProgress(50);
      } else if (stage === 'pull') {
        setStatusMessage('Downloading base image...');
        setProgress(60);
      } else if (stage === 'setup-done' || stage === 'ready') {
        setStatusMessage('Starting agent...');
        setProgress(90);
      }
    });

    const cleanupProgress = window.containerAPI.onProgress((p) => {
      if (p.stage === 'ready') {
        setStatusMessage('Starting agent...');
        setProgress(90);
      }
    });

    return () => {
      cleanupSetup();
      cleanupProgress();
      stopTimer();
    };
  }, [stopTimer]);

  useEffect(() => {
    if (hasStartedRef.current) return;
    hasStartedRef.current = true;
    startSetup();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRetry = () => {
    hasStartedRef.current = true;
    startSetup();
  };

  return (
    <div className="wsSetup">
      <div className="wsSetup__branding">
        <span className="wsSetup__brandName">Co-scientist</span>
        <span className="wsSetup__brandLabel">SETUP</span>
      </div>

      <div className="wsSetup__inner">
        <h1 className="wsSetup__title">Setting up your environment</h1>
        <p className="wsSetup__subtitle">
          This may take a few minutes the first time.
        </p>

        <div className="wsSetup__progressBar">
          <div
            className="wsSetup__progressFill"
            style={{ width: `${progress}%` }}
          />
        </div>

        {!error && (
          <div className="wsSetup__currentStep">
            <span className="wsSetup__spinnerIcon" />
            <span>{statusMessage}</span>
          </div>
        )}

        {error && (
          <>
            <div className="wsSetup__errorBox">
              Something went wrong while setting up: {error}
            </div>
            <div className="wsSetup__errorActions">
              <button type="button" className="wsSetup__retryBtn" onClick={handleRetry}>
                Retry
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default ContainerSetupProgress;
