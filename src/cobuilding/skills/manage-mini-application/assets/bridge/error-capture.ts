// Global error capture for mini-apps.
//
// Installs handlers for uncaught exceptions, unhandled rejections,
// console.error, failed fetches, and resource load failures. Each captured
// error is appended to a buffer (so a late-mounting display can replay them)
// and dispatched as a "cobuild-error" CustomEvent on window.
//
// The buffer is exposed as `window.__cobuildErrors` so a React display
// component can read pre-mount errors without needing a direct import.
//
// This file is imported for its side effects from bridge.ts — keep it
// import-only with no exports.

export {};

interface CobuildError {
  kind: "exception" | "unhandledrejection" | "console" | "fetch" | "resource";
  message: string;
  stack?: string;
  source?: string;
  timestamp: number;
}

const MAX_BUFFERED_ERRORS = 50;
const errorBuffer: CobuildError[] = [];

function reportError(err: CobuildError): void {
  errorBuffer.push(err);
  if (errorBuffer.length > MAX_BUFFERED_ERRORS) {
    errorBuffer.shift();
  }
  try {
    window.dispatchEvent(new CustomEvent("cobuild-error", { detail: err }));
  } catch {
    // never let dispatch failure break anything
  }
}

(window as unknown as { __cobuildErrors: CobuildError[] }).__cobuildErrors = errorBuffer;

window.addEventListener(
  "error",
  (event) => {
    const target = event.target;
    if (target && target !== window && target instanceof Element) {
      const tag = target.tagName.toLowerCase();
      const src =
        (target as HTMLImageElement).src ||
        (target as HTMLLinkElement).href ||
        "(unknown source)";
      reportError({
        kind: "resource",
        message: `Failed to load ${tag}: ${src}`,
        timestamp: Date.now(),
      });
      return;
    }
    reportError({
      kind: "exception",
      message: event.message || (event.error ? String(event.error) : "Unknown error"),
      stack: event.error instanceof Error ? event.error.stack : undefined,
      source: event.filename
        ? `${event.filename}:${event.lineno}:${event.colno}`
        : undefined,
      timestamp: Date.now(),
    });
  },
  true,
);

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  reportError({
    kind: "unhandledrejection",
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
    timestamp: Date.now(),
  });
});

const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  try {
    const message = args
      .map((a) => {
        if (a instanceof Error) return a.message;
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");
    const errArg = args.find((a): a is Error => a instanceof Error);
    reportError({
      kind: "console",
      message,
      stack: errArg?.stack,
      timestamp: Date.now(),
    });
  } catch {
    // never let our patch break console.error
  }
  originalConsoleError(...args);
};

const originalFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const response = await originalFetch(input, init);
  if (!response.ok) {
    let url: string;
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.toString();
    else url = input.url;
    reportError({
      kind: "fetch",
      message: `HTTP ${response.status} ${response.statusText} \u2014 ${url}`,
      timestamp: Date.now(),
    });
  }
  return response;
};
