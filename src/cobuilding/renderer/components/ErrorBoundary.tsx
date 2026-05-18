import React from 'react';
import { captureError } from '../../shared/telemetry';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Optional fallback UI. Defaults to a minimal error screen. */
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    captureError(error, {
      subsystem: 'ui',
      extra: { component_stack: info.componentStack },
    });
  }

  handleReload = (): void => {
    window.location.reload();
  };

  render(): React.ReactNode {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            padding: '24px',
            fontFamily: 'system-ui, sans-serif',
            color: '#1f2937',
            backgroundColor: '#f9fafb',
            gap: '12px',
          }}
        >
          <h2 style={{ margin: 0 }}>Something went wrong.</h2>
          <p style={{ margin: 0, color: '#6b7280', fontSize: '14px' }}>
            The error has been reported. Reloading usually clears it.
          </p>
          <pre
            style={{
              maxWidth: '600px',
              maxHeight: '160px',
              overflow: 'auto',
              fontSize: '12px',
              padding: '8px',
              backgroundColor: '#fff',
              border: '1px solid #e5e7eb',
              borderRadius: '4px',
            }}
          >
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              padding: '8px 16px',
              border: 'none',
              borderRadius: '6px',
              backgroundColor: '#2563eb',
              color: '#fff',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
