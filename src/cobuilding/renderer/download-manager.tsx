import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';

type StepName = 'podman-download' | 'podman-setup' | 'machine' | 'image-download' | 'image-setup';
type StepStatus = 'pending' | 'active' | 'done' | 'error';
type ViewState = 'downloading' | 'complete' | 'error';

interface StepProgress {
  step: StepName;
  status: StepStatus;
  message: string;
  percent?: number;
}

interface StepState {
  status: StepStatus;
  message: string;
  percent: number;
}

interface SetupStatus {
  podmanDownload: 'done' | 'needed' | 'partial';
  podmanSetup: 'done' | 'needed';
  machine: 'done' | 'needed';
  imageDownload: 'done' | 'needed' | 'partial';
  imageSetup: 'done' | 'needed';
  currentTier: 'core' | 'full' | null;
}

const STEP_LABELS: Record<StepName, string> = {
  'podman-download': 'Podman Download',
  'podman-setup': 'Podman Setup',
  'machine': 'Virtual Machine',
  'image-download': 'Image Download',
  'image-setup': 'Image Setup',
};

const ALL_STEPS: StepName[] = ['podman-download', 'podman-setup', 'machine', 'image-download', 'image-setup'];

const api = (window as any).downloadManagerAPI;

function initialStepStates(): Record<StepName, StepState> {
  return {
    'podman-download': { status: 'pending', message: '', percent: 0 },
    'podman-setup': { status: 'pending', message: '', percent: 0 },
    'machine': { status: 'pending', message: '', percent: 0 },
    'image-download': { status: 'pending', message: '', percent: 0 },
    'image-setup': { status: 'pending', message: '', percent: 0 },
  };
}

// ─── ETA Tracker ─────────────────────────────────────────────────

function useEtaTracker() {
  const samplesRef = useRef<Map<StepName, Array<{ time: number; percent: number }>>>(new Map());

  const addSample = useCallback((step: StepName, percent: number) => {
    if (!samplesRef.current.has(step)) {
      samplesRef.current.set(step, []);
    }
    const samples = samplesRef.current.get(step)!;
    samples.push({ time: Date.now(), percent });
    // Keep last 10 samples
    if (samples.length > 10) samples.shift();
  }, []);

  const getEta = useCallback((step: StepName, currentPercent: number): string | null => {
    const samples = samplesRef.current.get(step);
    if (!samples || samples.length < 2 || currentPercent >= 100) return null;

    const first = samples[0];
    const last = samples[samples.length - 1];
    const elapsed = (last.time - first.time) / 1000;
    const progress = last.percent - first.percent;
    if (progress <= 0 || elapsed <= 0) return null;

    const remaining = 100 - currentPercent;
    const rate = progress / elapsed;
    const etaSeconds = Math.round(remaining / rate);

    if (etaSeconds < 5) return 'almost done';
    if (etaSeconds < 60) return `~${etaSeconds}s remaining`;
    const mins = Math.floor(etaSeconds / 60);
    const secs = etaSeconds % 60;
    return `~${mins}m ${secs}s remaining`;
  }, []);

  const reset = useCallback(() => {
    samplesRef.current.clear();
  }, []);

  return { addSample, getEta, reset };
}

// ─── Components ──────────────────────────────────────────────────

function ProgressBar({ percent, error }: { percent: number; error?: boolean }) {
  const clamped = Math.min(100, Math.round(percent));
  return (
    <div style={styles.progressBarRow}>
      <div style={styles.progressBarOuter}>
        <div
          style={{
            ...styles.progressBarInner,
            width: `${clamped}%`,
            background: error ? '#c0392b' : '#2c6fbb',
          }}
        />
      </div>
      <span style={styles.progressPercent}>{clamped}%</span>
    </div>
  );
}

function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m ${rem}s`;
}

function StepRow({
  step,
  state,
  eta,
  elapsed,
}: {
  step: StepName;
  state: StepState;
  eta: string | null;
  elapsed: number | null;
}) {
  const statusIcon = (() => {
    switch (state.status) {
      case 'done': return '✓';
      case 'error': return '✗';
      case 'active': return '○';
      default: return '—';
    }
  })();

  const statusColor = (() => {
    switch (state.status) {
      case 'done': return '#2e8b57';
      case 'error': return '#c0392b';
      case 'active': return '#2c6fbb';
      default: return '#bbb';
    }
  })();

  const timeLabel = (() => {
    if (state.status === 'done' && elapsed != null) return formatElapsed(elapsed);
    if (state.status === 'active' && eta) return eta;
    if (state.status === 'active' && elapsed != null) return formatElapsed(elapsed);
    return null;
  })();

  return (
    <div style={styles.stepRow}>
      <div style={styles.stepHeader}>
        <span style={{ ...styles.stepIcon, color: statusColor }}>{statusIcon}</span>
        <span style={styles.stepLabel}>{STEP_LABELS[step]}</span>
        {timeLabel && (
          <span style={styles.eta}>{timeLabel}</span>
        )}
      </div>
      {(state.status === 'active' || state.status === 'done' || state.status === 'error') && (
        <>
          <ProgressBar percent={state.percent} error={state.status === 'error'} />
          <div style={styles.stepMessage}>{state.message}</div>
        </>
      )}
    </div>
  );
}

function DownloadProgress({
  steps,
  viewState,
  errorStep,
  errorMessage,
  getEta,
  stepElapsed,
  totalElapsed,
  onRetryStep,
  onClearAndRetryAll,
}: {
  steps: Record<StepName, StepState>;
  viewState: ViewState;
  errorStep: StepName | null;
  errorMessage: string;
  getEta: (step: StepName, percent: number) => string | null;
  stepElapsed: Record<StepName, number | null>;
  totalElapsed: number;
  onRetryStep: () => void;
  onClearAndRetryAll: () => void;
}) {
  return (
    <div style={styles.container}>
      <h2 style={styles.title}>
        {viewState === 'complete' ? 'Setup Complete' : viewState === 'error' ? 'Setup Error' : 'Downloading...'}
      </h2>
      <div style={styles.totalElapsed}>{formatElapsed(totalElapsed)}</div>

      <div style={styles.stepList}>
        {ALL_STEPS.map((step) => (
          <StepRow
            key={step}
            step={step}
            state={steps[step]}
            eta={getEta(step, steps[step].percent)}
            elapsed={stepElapsed[step]}
          />
        ))}
      </div>

      {viewState === 'error' && (
        <div style={styles.errorPanel}>
          <div style={styles.errorMessage}>{errorMessage}</div>
          <div style={styles.errorButtons}>
            {errorStep && (
              <button style={styles.secondaryBtn} onClick={onRetryStep}>
                Retry Step
              </button>
            )}
            <button style={styles.dangerBtn} onClick={onClearAndRetryAll}>
              Clear and Retry All
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

// ─── Main App ────────────────────────────────────────────────────

function initialElapsed(): Record<StepName, number | null> {
  return {
    'podman-download': null, 'podman-setup': null, 'machine': null,
    'image-download': null, 'image-setup': null,
  };
}

function DownloadManagerApp() {
  const [viewState, setViewState] = useState<ViewState>('downloading');
  const [steps, setSteps] = useState<Record<StepName, StepState>>(initialStepStates);
  const [errorStep, setErrorStep] = useState<StepName | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [totalElapsed, setTotalElapsed] = useState(0);
  const totalStartRef = useRef<number | null>(null);
  const startedRef = useRef(false);
  const { addSample, getEta, reset: resetEta } = useEtaTracker();

  // Track elapsed time per step
  const stepStartTimesRef = useRef<Record<StepName, number | null>>(initialElapsed());
  const [stepElapsed, setStepElapsed] = useState<Record<StepName, number | null>>(initialElapsed);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Tick every second to update elapsed for active steps
  useEffect(() => {
    elapsedTimerRef.current = setInterval(() => {
      const starts = stepStartTimesRef.current;
      const now = Date.now();
      setStepElapsed(prev => {
        const next = { ...prev };
        let changed = false;
        for (const step of ALL_STEPS) {
          const start = starts[step];
          if (start != null && next[step] !== null && prev[step] !== null) {
            // Only update active steps (done steps keep their final elapsed)
          }
          if (start != null) {
            const elapsed = now - start;
            if (prev[step] !== elapsed) {
              next[step] = elapsed;
              changed = true;
            }
          }
        }
        return changed ? next : prev;
      });
      if (totalStartRef.current != null) {
        setTotalElapsed(now - totalStartRef.current);
      }
    }, 1000);
    return () => { if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current); };
  }, []);

  // Auto-start downloads with core tier on mount
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    totalStartRef.current = Date.now();
    api.startDownloads('core').then(() => {
      setTotalElapsed(Date.now() - totalStartRef.current!);
      totalStartRef.current = null;
      setViewState('complete');
      api.continue();
    }).catch(() => {
      // Error handled via dm:error event
    });
  }, []);

  useEffect(() => {
    const cleanupProgress = api.onProgress((progress: StepProgress) => {
      // Track start time when step becomes active
      if (progress.status === 'active' && stepStartTimesRef.current[progress.step] == null) {
        stepStartTimesRef.current[progress.step] = Date.now();
      }
      // Freeze elapsed when step completes
      if (progress.status === 'done' || progress.status === 'error') {
        const start = stepStartTimesRef.current[progress.step];
        if (start != null) {
          setStepElapsed(prev => ({ ...prev, [progress.step]: Date.now() - start }));
          stepStartTimesRef.current[progress.step] = null;
        }
      }

      setSteps(prev => ({
        ...prev,
        [progress.step]: {
          status: progress.status,
          message: progress.message,
          percent: progress.percent ?? prev[progress.step].percent,
        },
      }));

      if (progress.status === 'active' && progress.percent != null) {
        addSample(progress.step, progress.percent);
      }
    });

    const cleanupError = api.onError((error: { step: StepName; message: string }) => {
      setViewState('error');
      setErrorStep(error.step);
      setErrorMessage(error.message);
    });

    return () => { cleanupProgress(); cleanupError(); };
  }, [addSample]);

  const handleRetryStep = useCallback(async () => {
    if (!errorStep) return;
    setViewState('downloading');
    setErrorMessage('');
    stepStartTimesRef.current[errorStep] = null;
    setStepElapsed(prev => ({ ...prev, [errorStep]: null }));
    setSteps(prev => ({
      ...prev,
      [errorStep]: { status: 'pending', message: '', percent: 0 },
    }));
    totalStartRef.current = Date.now();
    setTotalElapsed(0);
    try {
      await api.retryStep(errorStep);
      setTotalElapsed(Date.now() - totalStartRef.current);
      totalStartRef.current = null;
      setViewState('complete');
      api.continue();
    } catch {
      // Error handled via dm:error event
    }
  }, [errorStep]);

  const handleClearAndRetryAll = useCallback(async () => {
    setViewState('downloading');
    setErrorMessage('');
    setErrorStep(null);
    setSteps(initialStepStates());
    setStepElapsed(initialElapsed());
    stepStartTimesRef.current = initialElapsed();
    totalStartRef.current = Date.now();
    setTotalElapsed(0);
    resetEta();
    try {
      await api.clearAndRetryAll();
      setTotalElapsed(Date.now() - totalStartRef.current);
      totalStartRef.current = null;
      setViewState('complete');
      api.continue();
    } catch {
      // Error handled via dm:error event
    }
  }, [resetEta]);

  return (
    <DownloadProgress
      steps={steps}
      viewState={viewState}
      errorStep={errorStep}
      errorMessage={errorMessage}
      getEta={getEta}
      stepElapsed={stepElapsed}
      totalElapsed={totalElapsed}
      onRetryStep={handleRetryStep}
      onClearAndRetryAll={handleClearAndRetryAll}
    />
  );
}

// ─── Styles ──────────────────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    fontFamily: "'DM Sans', system-ui, sans-serif",
    padding: '24px',
    boxSizing: 'border-box',
    color: '#333',
    background: '#faf8f5',
  },
  title: {
    fontSize: '20px',
    fontWeight: 600,
    marginBottom: '8px',
    color: '#1a1a1a',
  },
  subtitle: {
    fontSize: '14px',
    color: '#888',
    marginBottom: '20px',
  },
  totalElapsed: {
    fontSize: '13px',
    color: '#999',
    marginBottom: '16px',
  },
  secondaryBtn: {
    padding: '8px 16px',
    border: '1px solid #ccc',
    borderRadius: '6px',
    background: 'transparent',
    color: '#333',
    cursor: 'pointer',
    fontSize: '13px',
  },
  dangerBtn: {
    padding: '8px 16px',
    border: 'none',
    borderRadius: '6px',
    background: '#c0392b',
    color: 'white',
    cursor: 'pointer',
    fontSize: '13px',
  },
  stepList: {
    width: '100%',
    maxWidth: '440px',
    marginBottom: '20px',
  },
  stepRow: {
    marginBottom: '12px',
  },
  stepHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '4px',
  },
  stepIcon: {
    fontSize: '14px',
    fontWeight: 'bold',
    width: '16px',
    textAlign: 'center' as const,
  },
  stepLabel: {
    fontSize: '13px',
    fontWeight: 500,
    color: '#333',
  },
  eta: {
    marginLeft: 'auto',
    fontSize: '11px',
    color: '#999',
  },
  progressBarRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '2px',
  },
  progressBarOuter: {
    flex: 1,
    height: '6px',
    background: '#e8e2d6',
    borderRadius: '3px',
    overflow: 'hidden',
  },
  progressPercent: {
    fontSize: '11px',
    color: '#999',
    width: '32px',
    textAlign: 'right' as const,
    flexShrink: 0,
  },
  progressBarInner: {
    height: '100%',
    borderRadius: '3px',
    transition: 'width 0.3s ease',
  },
  stepMessage: {
    fontSize: '11px',
    color: '#999',
    marginTop: '2px',
  },
  errorPanel: {
    width: '100%',
    maxWidth: '440px',
    padding: '12px',
    background: '#fdf0f0',
    borderRadius: '8px',
    border: '1px solid #e8c0c0',
    marginBottom: '16px',
  },
  errorMessage: {
    fontSize: '13px',
    color: '#c0392b',
    marginBottom: '12px',
    wordBreak: 'break-word' as const,
  },
  errorButtons: {
    display: 'flex',
    gap: '8px',
    justifyContent: 'flex-end',
  },
};

// ─── Mount ───────────────────────────────────────────────────────

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<DownloadManagerApp />);
}
