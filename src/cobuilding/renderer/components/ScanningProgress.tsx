import React, { useState, useEffect, useRef, useCallback } from 'react';
import { CheckIcon } from 'lucide-react';
import './WorkspaceOnboarding.css';
import './ScanningProgress.css';

interface ScanningProgressProps {
  onComplete: (reportId: string) => void;
  onSkip: () => void;
}

interface ProgressItem {
  text: string;
  completed: boolean;
}

const ScanningProgress: React.FC<ScanningProgressProps> = ({ onComplete, onSkip }) => {
  const [items, setItems] = useState<ProgressItem[]>([]);
  const [fileActivities, setFileActivities] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(Date.now());
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const fileListRef = useRef<HTMLDivElement>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const stopProgressTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startProgressTimer = useCallback(() => {
    stopProgressTimer();
    startTimeRef.current = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      const p = 1 - Math.exp(-elapsed / 45_000);
      setProgress(Math.min(90, Math.round(p * 90)));
    }, 500);
  }, [stopProgressTimer]);

  const startScan = useCallback(() => {
    // Clean up any previous subscription
    unsubscribeRef.current?.();

    startProgressTimer();

    unsubscribeRef.current = window.scannerAPI.onEvent((event: ScannerEvent) => {
      if (event.type === 'progress') {
        setItems((prev) => {
          const updated = prev.map((item) => ({ ...item, completed: true }));
          return [...updated, { text: event.text, completed: false }];
        });
      } else if (event.type === 'file_activity') {
        setFileActivities((prev) => {
          const next = [...prev, event.path];
          return next.length > 200 ? next.slice(-200) : next;
        });
      } else if (event.type === 'complete') {
        setItems((prev) => prev.map((item) => ({ ...item, completed: true })));
        setProgress(100);
        setDone(true);
        stopProgressTimer();
        setTimeout(() => {
          onCompleteRef.current(event.reportId);
        }, 800);
      } else if (event.type === 'error') {
        setError(event.error);
        stopProgressTimer();
      }
    });

    window.scannerAPI.start().catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
      stopProgressTimer();
    });
  }, [startProgressTimer, stopProgressTimer]);

  // Auto-scroll file activity list to bottom
  useEffect(() => {
    if (fileListRef.current) {
      fileListRef.current.scrollTop = fileListRef.current.scrollHeight;
    }
  }, [fileActivities]);

  // Start scan on mount
  useEffect(() => {
    startScan();
    return () => {
      unsubscribeRef.current?.();
      stopProgressTimer();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRetry = () => {
    setError(null);
    setItems([]);
    setFileActivities([]);
    setProgress(0);
    setDone(false);
    startScan();
  };

  return (
    <div className="wsSetup">
      <div className="wsSetup__branding">
        <span className="wsSetup__brandName">Co-scientist</span>
        <span className="wsSetup__brandLabel">SETUP</span>
      </div>

      <div className="wsSetup__inner scanProgress__layout">
        <div className="scanProgress__top">
          <p className="wsSetup__stepIndicator">STEP 2 OF 5 &middot; READING YOUR WORK</p>

          <h1 className="wsSetup__title">Give me a minute to read everything</h1>

          <div className="wsSetup__progressBar">
            <div
              className="wsSetup__progressFill"
              style={{ width: `${progress}%` }}
            />
          </div>

          <ul className="wsSetup__progressList">
            {items.map((item, index) => (
              <li key={index} className="wsSetup__progressItem">
                {item.completed ? (
                  <span className="wsSetup__checkIcon">
                    <CheckIcon />
                  </span>
                ) : (
                  <span className="wsSetup__spinnerIcon" />
                )}
                <span>{item.text}</span>
              </li>
            ))}
          </ul>

          {error && (
            <>
              <div className="wsSetup__errorBox">
                Something went wrong while scanning your workspace: {error}
              </div>
              <div className="wsSetup__errorActions">
                <button type="button" className="wsSetup__retryBtn" onClick={handleRetry}>
                  Retry
                </button>
                <button type="button" className="wsSetup__skipBtn" onClick={onSkip}>
                  Skip for now
                </button>
              </div>
            </>
          )}

          {!error && !done && items.length === 0 && (
            <p className="wsSetup__subtitle" style={{ marginTop: 0 }}>
              Scanning your workspace to learn about your research...
            </p>
          )}
        </div>

        <div className="scanProgress__bottom">
          <div
            className={`wsSetup__fileActivity ${fileActivities.length > 0 ? 'wsSetup__fileActivity--visible' : ''}`}
            ref={fileListRef}
          >
            {fileActivities.map((path, i) => (
              <div key={i} className="wsSetup__fileActivityItem">
                <span className="wsSetup__fileActivityDot" />
                <span className="wsSetup__fileActivityPath">{path}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ScanningProgress;
