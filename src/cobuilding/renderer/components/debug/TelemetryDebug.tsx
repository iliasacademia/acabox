import React, { useState } from 'react';
import { captureError } from '../../../shared/telemetry';

const SUBSYSTEMS = [
  'agent',
  'container',
  'kernel',
  'package_install',
  'tool_build',
  'integration_word',
  'integration_google_docs',
  'integration_obsidian',
  'integration_apple_notes',
  'integration_zotero',
  'auth_device',
  'auth_oauth_google',
  'workspace_scan',
  'scheduled_task',
  'office_addin',
  'ui',
] as const;

type LogLine = { ts: string; text: string };

// ─── Local ErrorBoundary so the "trigger boundary" test doesn't take down
// the whole Debug tab. Resets when its `resetKey` prop changes.
class LocalErrorBoundary extends React.Component<
  { resetKey: number; children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    captureError(error, {
      subsystem: 'ui',
      extra: { component_stack: info.componentStack, source: 'debug-panel-boundary-test' },
    });
  }
  componentDidUpdate(prev: { resetKey: number }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 12, border: '1px solid #fca5a5', background: '#fee2e2', borderRadius: 6, fontSize: 13 }}>
          <strong>ErrorBoundary caught:</strong> {this.state.error.message}
          <div style={{ marginTop: 4, color: '#6b7280', fontSize: 12 }}>
            Captured to Sentry with <code>subsystem: ui</code>. Press "Reset boundary" below to try again.
          </div>
        </div>
      );
    }
    return <>{this.props.children}</>;
  }
}

function ThrowOnRender(): React.ReactElement {
  throw new Error('telemetry test: thrown during React render');
}

export const TelemetryDebug: React.FC = () => {
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [subsystem, setSubsystem] = useState<string>('container');
  const [shouldThrowInRender, setShouldThrowInRender] = useState(false);
  const [boundaryResetKey, setBoundaryResetKey] = useState(0);

  const append = (text: string) => {
    const ts = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, { ts, text }].slice(-20));
  };

  // ─── Renderer-side triggers ─────────────────────────────────────────

  const triggerRendererSyncThrow = () => {
    append('Renderer: throwing in event handler …');
    throw new Error('telemetry test: renderer sync throw in event handler');
  };

  const triggerRendererRejection = () => {
    append('Renderer: kicking off an unhandled promise rejection …');
    // No .catch() and not returned — global unhandledrejection fires.
    void Promise.reject(new Error('telemetry test: renderer unhandled promise rejection'));
  };

  const triggerRendererCapture = () => {
    append(`Renderer: captureError with subsystem="${subsystem}" …`);
    captureError(new Error(`telemetry test: renderer explicit capture (${subsystem})`), {
      subsystem,
      extra: { source: 'debug-panel' },
    });
  };

  const triggerBoundary = () => {
    append('Renderer: triggering React ErrorBoundary …');
    setShouldThrowInRender(true);
  };

  const resetBoundary = () => {
    setShouldThrowInRender(false);
    setBoundaryResetKey((k) => k + 1);
  };

  const triggerRendererCrash = () => {
    append('Renderer: calling process.crash() — the window will reload.');
    // Tiny delay so the log line lands first.
    setTimeout(() => {
      // process.crash() on the renderer triggers render-process-gone in main.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process as any).crash();
    }, 100);
  };

  // ─── Main-side triggers (via IPC) ───────────────────────────────────

  const triggerMain = async (kind: 'uncaught' | 'rejection' | 'capture') => {
    append(`Main: telemetryTest("${kind}"${kind === 'capture' ? `, "${subsystem}"`: ''}) …`);
    try {
      const res = await window.debugAPI.telemetryTest(kind, kind === 'capture' ? subsystem : undefined);
      append(`Main: response ${JSON.stringify(res)}`);
    } catch (err) {
      append(`Main: IPC error ${(err as Error).message}`);
    }
  };

  // ─── Layout ──────────────────────────────────────────────────────────

  const dsnConfigured = Boolean(process.env.SENTRY_DSN);

  return (
    <div style={{ padding: 16, fontSize: 14, lineHeight: 1.5 }}>
      <h2 style={{ marginTop: 0 }}>Telemetry</h2>

      <div style={{ background: dsnConfigured ? '#ecfdf5' : '#fef3c7', border: `1px solid ${dsnConfigured ? '#86efac' : '#fcd34d'}`, padding: 10, borderRadius: 6, marginBottom: 16, fontSize: 13 }}>
        <strong>Sentry DSN:</strong> {dsnConfigured ? 'configured' : 'NOT configured — events will be dropped'}
        <div style={{ color: '#4b5563', marginTop: 4 }}>
          DSN is baked at build time. If this says "NOT configured," set <code>SENTRY_DSN</code> in <code>.env.local</code> and restart.
        </div>
      </div>

      <p style={{ color: '#4b5563', marginTop: 0 }}>
        Each button below triggers a different error path. Verify the corresponding event appears in Sentry → Issues.
        Test errors are tagged with a recognizable message — search for <code>telemetry test:</code>.
      </p>

      <SectionHeader>Renderer-side</SectionHeader>
      <Row>
        <Btn onClick={triggerRendererSyncThrow}>Throw in event handler</Btn>
        <Hint>
          Synchronous throw inside <code>onClick</code>. Captured via Sentry's <code>onError</code> integration in the renderer.
        </Hint>
      </Row>
      <Row>
        <Btn onClick={triggerRendererRejection}>Unhandled promise rejection</Btn>
        <Hint>
          <code>Promise.reject()</code> with no <code>.catch()</code>. Captured via the <code>unhandledrejection</code> window event.
        </Hint>
      </Row>
      <Row>
        <Btn onClick={triggerBoundary}>Trigger React ErrorBoundary</Btn>
        <Hint>
          Renders a child component that throws. Caught by the local boundary, then forwarded to Sentry as <code>subsystem: ui</code>.
        </Hint>
      </Row>
      <Row>
        <Btn onClick={triggerRendererCrash} danger>Crash renderer process</Btn>
        <Hint>
          Calls <code>process.crash()</code>. Main hears <code>render-process-gone</code> → captures with <code>subsystem: render_process</code>. Window reloads.
        </Hint>
      </Row>

      <SectionHeader>Main-side (via IPC)</SectionHeader>
      <Row>
        <Btn onClick={() => triggerMain('uncaught')}>Uncaught exception in main</Btn>
        <Hint>
          <code>setImmediate(() =&gt; throw)</code> in main. Hits our <code>uncaughtException</code> handler → <code>subsystem: main_uncaught</code>.
        </Hint>
      </Row>
      <Row>
        <Btn onClick={() => triggerMain('rejection')}>Unhandled rejection in main</Btn>
        <Hint>
          <code>Promise.reject()</code> on a fresh tick in main. Hits our <code>unhandledRejection</code> handler → <code>subsystem: main_unhandled_rejection</code>.
        </Hint>
      </Row>

      <SectionHeader>Manual capture with subsystem tag</SectionHeader>
      <Row>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Subsystem:
          <select value={subsystem} onChange={(e) => setSubsystem(e.target.value)} style={{ padding: 4 }}>
            {SUBSYSTEMS.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
      </Row>
      <Row>
        <Btn onClick={triggerRendererCapture}>captureError from renderer</Btn>
        <Hint>Calls our <code>captureError()</code> helper with the selected subsystem from the renderer side.</Hint>
      </Row>
      <Row>
        <Btn onClick={() => triggerMain('capture')}>captureError from main</Btn>
        <Hint>Same, but the call happens in the main process.</Hint>
      </Row>

      <SectionHeader>Local boundary preview</SectionHeader>
      <div style={{ marginBottom: 12 }}>
        <LocalErrorBoundary resetKey={boundaryResetKey}>
          {shouldThrowInRender ? <ThrowOnRender /> : (
            <div style={{ padding: 8, border: '1px dashed #d1d5db', borderRadius: 4, color: '#6b7280', fontSize: 13 }}>
              Boundary idle. Press "Trigger React ErrorBoundary" above to force an error here.
            </div>
          )}
        </LocalErrorBoundary>
      </div>
      <button onClick={resetBoundary} style={btnStyle()}>Reset boundary</button>

      <SectionHeader>Activity log</SectionHeader>
      <pre style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: 10, fontSize: 12, maxHeight: 200, overflow: 'auto', margin: 0 }}>
        {logs.length === 0 ? '(empty)' : logs.map((l) => `[${l.ts}] ${l.text}`).join('\n')}
      </pre>
    </div>
  );
};

// ─── Small layout helpers ────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <h3 style={{ marginTop: 24, marginBottom: 8, fontSize: 14, color: '#374151', borderBottom: '1px solid #e5e7eb', paddingBottom: 4 }}>{children}</h3>;
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>{children}</div>;
}

function Hint({ children }: { children: React.ReactNode }) {
  return <span style={{ color: '#6b7280', fontSize: 12 }}>{children}</span>;
}

function btnStyle(danger = false): React.CSSProperties {
  return {
    padding: '6px 12px',
    fontSize: 13,
    borderRadius: 6,
    border: '1px solid',
    borderColor: danger ? '#dc2626' : '#d1d5db',
    background: danger ? '#fef2f2' : '#fff',
    color: danger ? '#b91c1c' : '#111827',
    cursor: 'pointer',
    minWidth: 220,
    textAlign: 'left' as const,
  };
}

function Btn({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return <button type="button" onClick={onClick} style={btnStyle(danger)}>{children}</button>;
}
