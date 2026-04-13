import React, { useEffect, useRef, useState } from "react";
import { XIcon, ChevronDownIcon, ChevronRightIcon, CheckIcon } from "lucide-react";

// Mirrors the CobuildError shape produced by _bridge/error-capture.ts.
interface CobuildError {
  kind: "exception" | "unhandledrejection" | "console" | "fetch" | "resource";
  message: string;
  stack?: string;
  source?: string;
  timestamp: number;
}

interface StoredError extends CobuildError {
  id: number;
  expanded: boolean;
}

type FixState = "idle" | "sending" | "sent";

// errorAPI is installed on window by _bridge/bridge.ts.
declare const window: Window & {
  errorAPI?: {
    requestFix(error: CobuildError): Promise<unknown>;
  };
};

const KIND_LABELS: Record<CobuildError["kind"], string> = {
  exception: "Exception",
  unhandledrejection: "Unhandled rejection",
  console: "console.error",
  fetch: "HTTP error",
  resource: "Resource error",
};

export function ErrorDisplay() {
  const [errors, setErrors] = useState<StoredError[]>([]);
  const [fixState, setFixState] = useState<Record<number, FixState>>({});
  const idRef = useRef(0);

  const requestFix = async (err: StoredError) => {
    if (!window.errorAPI) {
      console.warn("[ErrorDisplay] errorAPI not available on window");
      return;
    }
    setFixState((prev) => ({ ...prev, [err.id]: "sending" }));
    try {
      await window.errorAPI.requestFix({
        kind: err.kind,
        message: err.message,
        stack: err.stack,
        source: err.source,
        timestamp: err.timestamp,
      });
      setFixState((prev) => ({ ...prev, [err.id]: "sent" }));
    } catch {
      setFixState((prev) => {
        const next = { ...prev };
        delete next[err.id];
        return next;
      });
    }
  };

  useEffect(() => {
    // Replay any errors that fired before this component mounted.
    const buffer =
      (window as unknown as { __cobuildErrors?: CobuildError[] }).__cobuildErrors ?? [];
    if (buffer.length > 0) {
      setErrors(
        buffer.map((e) => ({ ...e, id: ++idRef.current, expanded: false })),
      );
    }

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<CobuildError>).detail;
      if (!detail) return;
      setErrors((prev) => [
        ...prev,
        { ...detail, id: ++idRef.current, expanded: false },
      ]);
    };
    window.addEventListener("cobuild-error", handler);
    return () => window.removeEventListener("cobuild-error", handler);
  }, []);

  if (errors.length === 0) return null;

  const dismiss = (id: number) =>
    setErrors((prev) => prev.filter((e) => e.id !== id));
  const clearAll = () => setErrors([]);
  const toggle = (id: number) =>
    setErrors((prev) =>
      prev.map((e) => (e.id === id ? { ...e, expanded: !e.expanded } : e)),
    );

  return (
    <div
      style={{
        position: "fixed",
        bottom: 16,
        right: 16,
        zIndex: 999999,
        width: 460,
        maxWidth: "calc(100vw - 32px)",
        maxHeight: "70vh",
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          background: "#991b1b",
          color: "white",
          borderRadius: 6,
          fontSize: 12,
          fontWeight: 600,
          boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
        }}
      >
        <span>
          {errors.length} error{errors.length === 1 ? "" : "s"}
        </span>
        <button
          onClick={clearAll}
          style={{
            background: "transparent",
            border: "1px solid rgba(255,255,255,0.4)",
            color: "white",
            cursor: "pointer",
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 4,
            fontWeight: 500,
          }}
        >
          Clear all
        </button>
      </div>
      {errors.map((err) => (
        <div
          key={err.id}
          style={{
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: 6,
            padding: 10,
            fontSize: 12,
            boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
            <button
              onClick={() => toggle(err.id)}
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: 0,
                color: "#991b1b",
                marginTop: 1,
                display: "flex",
              }}
              aria-label={err.expanded ? "Collapse details" : "Expand details"}
            >
              {err.expanded ? (
                <ChevronDownIcon size={14} />
              ) : (
                <ChevronRightIcon size={14} />
              )}
            </button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 10,
                  color: "#6b7280",
                  marginBottom: 2,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  fontWeight: 600,
                }}
              >
                {KIND_LABELS[err.kind]}
              </div>
              <div
                style={{
                  color: "#991b1b",
                  fontWeight: 500,
                  wordBreak: "break-word",
                }}
              >
                {err.message}
              </div>
              {err.expanded && (
                <pre
                  style={{
                    margin: "8px 0 0",
                    padding: 8,
                    background: "#fff1f2",
                    borderRadius: 4,
                    fontSize: 11,
                    color: "#b91c1c",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    overflowX: "auto",
                    maxHeight: 240,
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, Monaco, monospace",
                  }}
                >
                  {err.source ? `at ${err.source}\n\n` : ""}
                  {err.stack ?? "(no stack)"}
                </pre>
              )}
              <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
                <FixButton state={fixState[err.id] ?? "idle"} onClick={() => requestFix(err)} />
              </div>
            </div>
            <button
              onClick={() => dismiss(err.id)}
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: 0,
                color: "#991b1b",
                display: "flex",
              }}
              aria-label="Dismiss"
            >
              <XIcon size={14} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function FixButton({ state, onClick }: { state: FixState; onClick: () => void }) {
  const disabled = state !== "idle";
  const label = state === "sent" ? "Sent to chat" : state === "sending" ? "Sending..." : "Fix";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        background: state === "sent" ? "#dcfce7" : "white",
        border: `1px solid ${state === "sent" ? "#86efac" : "#fecaca"}`,
        color: state === "sent" ? "#166534" : "#991b1b",
        cursor: disabled ? "default" : "pointer",
        fontSize: 11,
        padding: "3px 8px",
        borderRadius: 4,
        fontWeight: 500,
        opacity: state === "sending" ? 0.7 : 1,
      }}
    >
      {state === "sent" && <CheckIcon size={12} />}
      {label}
    </button>
  );
}
