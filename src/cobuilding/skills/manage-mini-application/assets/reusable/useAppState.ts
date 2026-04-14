import { useState, useEffect, useCallback, useRef } from "react";

// Persistent app state for cobuild mini-apps.
//
// All persistent params and file inputs go through this hook. The notebook
// (.applications/<dirName>/notebook.ipynb) is the durable, portable source of
// truth: visible cells hold params + input file refs (so a user grabbing the
// directory can re-run the analysis), and notebook.metadata.cobuild holds
// invisible bookkeeping (lastRun timestamp + hash).
//
// On mount the hook hydrates params from the parameters-tagged cell. On
// every change it debounces a write back to the same cell. selectInput()
// copies the picked file into ./input/<slot>/ and stores the relative path
// in params, so the directory stays self-contained and portable.

declare const window: Window & {
  filesAPI: {
    readFile(
      path: string,
    ): Promise<
      | { type: "text"; content: string }
      | { type: "image"; fileUrl: string }
      | { error: string; size?: number }
    >;
    writeFile(path: string, content: string): Promise<unknown>;
    selectFile(
      filters?: { name: string; extensions: string[] }[],
    ): Promise<string | null>;
    copyFile(
      sourcePath: string,
      destinationDir: string,
    ): Promise<{ copied: number }>;
    deleteFile(path: string): Promise<unknown>;
  };
  getWorkspacePath(): string;
};

/**
 * Whether the persisted "last run" matches the current params.
 *
 * - `'never'` — no run has ever been recorded for this app.
 * - `'fresh'` — params haven't changed since `markRunComplete` was last called.
 * - `'stale'` — params have changed since the last recorded run; results
 *   on screen / on disk may not reflect the current configuration.
 *
 * Distinct from a per-app *runtime* state (idle / running / complete / error)
 * which `useKernelAction` exposes as `phase`. They serve different purposes
 * and should not be conflated.
 */
export type Freshness = "never" | "fresh" | "stale";

export interface UseAppStateOptions<P extends Record<string, unknown>> {
  dirName: string;
  defaults: P;
  /**
   * Param keys whose value is a relative path to a file in `./input/<slot>/`.
   * `selectInput(slot)` copies the picked file there and writes the path.
   */
  inputSlots?: (keyof P & string)[];
}

export interface UseAppStateResult<
  P extends Record<string, unknown>,
  O = unknown,
  R = unknown,
> {
  loading: boolean;
  params: P;
  setParams: (updater: Partial<P> | ((prev: P) => P)) => void;
  /**
   * Open the native file picker, copy the chosen file into
   * `.applications/<dir>/input/<slot>/`, and persist the workspace-relative
   * path under `params[slot]`. Returns the new path so the caller can read
   * the file synchronously without waiting for the next render. Returns
   * `null` if the user cancelled the dialog.
   */
  selectInput: (
    slot: keyof P & string,
    filters?: { name: string; extensions: string[] }[],
  ) => Promise<string | null>;
  clearInput: (slot: keyof P & string) => Promise<void>;
  /**
   * Read the text content of the file currently in `params[slot]`. Returns
   * `null` if the slot is empty, the file is missing, or the file is
   * non-text (e.g. an image). Use this instead of calling
   * `window.filesAPI.readFile` directly — it handles the discriminated
   * union return shape and slot resolution for you.
   */
  readInput: (slot: keyof P & string) => Promise<string | null>;
  /**
   * Persisted descriptor of files the app has produced (typically the array
   * passed to `<OutputFileList files={...} />`). Survives remounts and
   * Electron restarts via `notebook.metadata.cobuild.outputs`. Set this from
   * your run handler — the actual files on disk are written separately via
   * `window.filesAPI.writeFile`; this is just the displayable index.
   */
  outputs: O[];
  setOutputs: (next: O[] | ((prev: O[]) => O[])) => void;
  /**
   * Persisted structured run summary — anything beyond a flat file list that
   * the UI needs to re-render after a remount (counts, contrasts,
   * visualization descriptors, etc.). Survives remounts via
   * `notebook.metadata.cobuild.runResult`. `null` until the first run sets
   * it. Apps with no structured result can ignore this field.
   */
  runResult: R | null;
  setRunResult: (next: R | null | ((prev: R | null) => R | null)) => void;
  freshness: Freshness;
  markRunComplete: () => Promise<void>;
}

const SAVE_DEBOUNCE_MS = 200;

// --- canonicalization & hashing -------------------------------------------
// Stable key order + fixed indent makes both the cell source text and the
// run hash deterministic across writes. Matching reader and writer formats
// is what keeps the round-trip lossless.

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function canonicalize(params: unknown): string {
  return JSON.stringify(sortKeys(params), null, 2);
}

// Embedding canonical JSON inside a host-language single-quoted string:
// escape `\` first so we don't double-escape the backslashes we add for `'`.
// Both R and Python interpret `\n`, `\t`, etc. inside single-quoted strings,
// so backslashes in JSON escape sequences (e.g. `"hello\nworld"`) MUST be
// doubled, otherwise the host would substitute a literal newline before the
// JSON parser ever sees the text.
function escapeForSingleQuote(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function unescapeFromSingleQuote(text: string): string {
  // Reverse: any `\X` becomes `X`. This handles both `\\` -> `\` and
  // `\'` -> `'` in a single pass without ordering pitfalls.
  return text.replace(/\\(.)/g, "$1");
}

// Non-cryptographic 53-bit string hash (cyrb53 by bryc). Used purely to
// detect "did the params change since the last run" — collision risk is
// vanishingly small for any realistic param payload, and unlike
// `crypto.subtle.digest` this works in iframes loaded via `local-file://`,
// which are not secure contexts.
function paramsHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const high = 2097151 & h2;
  const low = h1 >>> 0;
  return (4294967296 * high + low).toString(16).padStart(14, "0");
}

// --- notebook helpers -----------------------------------------------------

interface NotebookCell {
  id?: string;
  cell_type: string;
  metadata?: { tags?: string[] };
  source?: string | string[];
  execution_count?: number | null;
  outputs?: unknown[];
}

interface Notebook {
  nbformat?: number;
  nbformat_minor?: number;
  metadata?: {
    kernelspec?: { name?: string };
    cobuild?: {
      version?: number;
      lastRun?: { completedAt: number; paramsHash: string } | null;
      outputs?: unknown[];
      runResult?: unknown;
    };
    [key: string]: unknown;
  };
  cells?: NotebookCell[];
}

function findParametersCell(nb: Notebook): NotebookCell | undefined {
  return nb.cells?.find((c) => c.metadata?.tags?.includes("parameters"));
}

function paramsCellSource(params: unknown, kernelName: string | undefined): string {
  return formatParamsAssignment(params, kernelName);
}

/**
 * Build the `params_json <- '...'` (R) or `params_json = '...'` (Python)
 * assignment that lives in the notebook's `parameters`-tagged cell and is
 * also injected into the kernel before executing the action cell.
 *
 * Exported so `useKernelAction` produces byte-identical assignments to what
 * the persisted parameters cell holds — same canonical key order, same
 * escape rules — guaranteeing that "what's in the notebook" equals "what
 * the kernel sees" with no second source of truth.
 */
export function formatParamsAssignment(
  params: unknown,
  kernelName: string | undefined,
): string {
  const op = kernelName === "ir" ? "<-" : "=";
  const escaped = escapeForSingleQuote(canonicalize(params));
  return `params_json ${op} '${escaped}'`;
}

function readParamsFromCell<P extends Record<string, unknown>>(
  cell: NotebookCell | undefined,
  defaults: P,
): P {
  if (!cell) return defaults;
  const source = Array.isArray(cell.source)
    ? cell.source.join("")
    : (cell.source ?? "");
  const match = source.match(/^\s*params_json\s*(?:<-|=)\s*'([\s\S]*)'\s*$/);
  if (!match) return defaults;
  try {
    const obj = JSON.parse(unescapeFromSingleQuote(match[1])) as Partial<P>;
    return { ...defaults, ...obj };
  } catch {
    return defaults;
  }
}

function writeParametersCell(nb: Notebook, params: unknown): void {
  const kernelName = nb.metadata?.kernelspec?.name;
  const source = paramsCellSource(params, kernelName);
  const existing = findParametersCell(nb);
  if (existing) {
    existing.source = [source];
    return;
  }
  // Re-create the parameters cell if a user (or earlier code) deleted it.
  nb.cells = nb.cells ?? [];
  nb.cells.push({
    id: "parameters",
    cell_type: "code",
    metadata: { tags: ["parameters"] },
    source: [source],
    execution_count: null,
    outputs: [],
  });
}

function serializeNotebook(nb: Notebook): string {
  return JSON.stringify(nb, null, 1) + "\n";
}

// --- hook -----------------------------------------------------------------

export function useAppState<
  P extends Record<string, unknown>,
  O = unknown,
  R = unknown,
>(options: UseAppStateOptions<P>): UseAppStateResult<P, O, R> {
  const { dirName, defaults } = options;
  const notebookPath = `.applications/${dirName}/notebook.ipynb`;

  const [loading, setLoading] = useState(true);
  const [params, setParamsState] = useState<P>(defaults);
  const [outputs, setOutputsState] = useState<O[]>([]);
  const [runResult, setRunResultState] = useState<R | null>(null);
  const [lastRunHash, setLastRunHash] = useState<string | null>(null);

  const notebookRef = useRef<Notebook | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paramsRef = useRef<P>(defaults);
  paramsRef.current = params;
  const outputsRef = useRef<O[]>([]);
  outputsRef.current = outputs;
  const runResultRef = useRef<R | null>(null);
  runResultRef.current = runResult;

  const currentHash = paramsHash(canonicalize(params));

  // Hydrate from notebook on mount. If the notebook doesn't exist yet (the
  // agent may not have run the scaffold script, or this is the first mount
  // after the app was created by hand), create one with defaults so the
  // hook can function normally.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let nb: Notebook | null = null;
      try {
        const result = await window.filesAPI.readFile(notebookPath);
        if (cancelled) return;
        if ("type" in result && result.type === "text" && result.content.trim()) {
          nb = JSON.parse(result.content) as Notebook;
        }
      } catch {
        // ENOENT or other read error — notebook doesn't exist yet.
      }

      // If the notebook is missing or empty, create a minimal one.
      if (!nb) {
        nb = {
          nbformat: 4,
          nbformat_minor: 5,
          metadata: {
            kernelspec: { name: "python3" },
            cobuild: { version: 1, lastRun: null },
          },
          cells: [
            {
              id: "parameters",
              cell_type: "code",
              metadata: { tags: ["parameters"] },
              source: [formatParamsAssignment(defaults, "python3")],
              execution_count: null,
              outputs: [],
            },
          ],
        };
        try {
          await window.filesAPI.writeFile(notebookPath, serializeNotebook(nb));
        } catch (writeErr) {
          console.error("useAppState: failed to create notebook", writeErr);
        }
      }

      if (cancelled) return;
      notebookRef.current = nb;
      const loaded = readParamsFromCell(findParametersCell(nb), defaults);
      setParamsState(loaded);
      setLastRunHash(nb.metadata?.cobuild?.lastRun?.paramsHash ?? null);
      const persistedOutputs = nb.metadata?.cobuild?.outputs;
      if (Array.isArray(persistedOutputs)) {
        setOutputsState(persistedOutputs as O[]);
      }
      const persistedRunResult = nb.metadata?.cobuild?.runResult;
      if (persistedRunResult !== undefined) {
        setRunResultState(persistedRunResult as R | null);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // defaults is intentionally excluded — callers commonly pass a fresh
    // object literal each render; we only want to hydrate once per dirName.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notebookPath]);

  // Build the latest-state notebook write. Used by both the debounced
  // save effect and the on-unmount flush. Reads everything from refs so
  // stale closures aren't an issue.
  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const nb = notebookRef.current;
    if (!nb) return;
    writeParametersCell(nb, paramsRef.current);
    nb.metadata = nb.metadata ?? {};
    nb.metadata.cobuild = { ...(nb.metadata.cobuild ?? { version: 1 }) };
    nb.metadata.cobuild.outputs = outputsRef.current as unknown[];
    nb.metadata.cobuild.runResult = runResultRef.current;
    // Fire-and-forget: this runs on unmount where we can't await, and
    // for normal saves the user doesn't need to wait for the write.
    window.filesAPI
      .writeFile(notebookPath, serializeNotebook(nb))
      .catch((err) => {
        console.error("useAppState: failed to save notebook", err);
      });
  }, [notebookPath]);

  // Debounced save on every params/outputs/runResult change after hydration.
  // Cleanup intentionally does NOT clear the timer — we let scheduled saves
  // fire even mid-rerender. The next dep-change run clears any prior timer
  // so we still debounce correctly within a single mount.
  useEffect(() => {
    if (loading) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }, [params, outputs, runResult, loading, flushSave]);

  // On unmount, if a save is pending in the debounce window, flush it
  // immediately. Without this, the iframe being torn down (tab switch,
  // app close) cancels the timer and drops the pending write.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) flushSave();
    };
  }, [flushSave]);

  const setParams = useCallback(
    (updater: Partial<P> | ((prev: P) => P)) => {
      setParamsState((prev) =>
        typeof updater === "function"
          ? (updater as (p: P) => P)(prev)
          : { ...prev, ...updater },
      );
    },
    [],
  );

  const setOutputs = useCallback(
    (updater: O[] | ((prev: O[]) => O[])) => {
      setOutputsState((prev) =>
        typeof updater === "function"
          ? (updater as (p: O[]) => O[])(prev)
          : updater,
      );
    },
    [],
  );

  const setRunResult = useCallback(
    (updater: R | null | ((prev: R | null) => R | null)) => {
      setRunResultState((prev) =>
        typeof updater === "function"
          ? (updater as (p: R | null) => R | null)(prev)
          : updater,
      );
    },
    [],
  );

  const selectInput = useCallback(
    async (
      slot: keyof P & string,
      filters?: { name: string; extensions: string[] }[],
    ) => {
      const absPath = await window.filesAPI.selectFile(filters);
      if (!absPath) return null;
      const destDir = `.applications/${dirName}/input/${slot}`;
      // Wipe any previous file(s) in this slot so re-picking doesn't leave
      // orphans on disk. The slot dir holds at most one file.
      try {
        await window.filesAPI.deleteFile(destDir);
      } catch {
        // Slot directory may not exist yet — copyFile will create it.
      }
      await window.filesAPI.copyFile(absPath, destDir);
      const basename = absPath.split("/").pop() ?? "";
      // Workspace-relative path: works for `window.filesAPI.readFile` (which
      // resolves from the workspace root) and for the cobuild kernel (whose
      // CWD is also the workspace root). This means a user `cp -r`'ing the
      // app dir elsewhere will need to rewrite paths to re-run the notebook
      // standalone — tradeoff in favor of "things just work" inside cobuild.
      const relativePath = `.applications/${dirName}/input/${slot}/${basename}`;
      setParams({ [slot]: relativePath } as unknown as Partial<P>);
      // Update paramsRef synchronously so a `readInput(slot)` call right
      // after `selectInput` sees the new path (React state hasn't flushed
      // yet at this point).
      paramsRef.current = { ...paramsRef.current, [slot]: relativePath } as P;
      return relativePath;
    },
    [dirName, setParams],
  );

  const clearInput = useCallback(
    async (slot: keyof P & string) => {
      const destDir = `.applications/${dirName}/input/${slot}`;
      try {
        await window.filesAPI.deleteFile(destDir);
      } catch {
        // Slot directory may not exist; nothing to clean up.
      }
      setParams({ [slot]: "" } as unknown as Partial<P>);
      paramsRef.current = { ...paramsRef.current, [slot]: "" } as P;
    },
    [dirName, setParams],
  );

  const readInput = useCallback(
    async (slot: keyof P & string): Promise<string | null> => {
      const path = paramsRef.current[slot];
      if (typeof path !== "string" || path === "") return null;
      try {
        const result = await window.filesAPI.readFile(path);
        if ("type" in result && result.type === "text") return result.content;
        return null;
      } catch {
        return null;
      }
    },
    [],
  );

  const markRunComplete = useCallback(async () => {
    // Cancel any pending debounced save — we're about to write a fresh
    // version of the notebook ourselves, including the latest params.
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const nb = notebookRef.current;
    if (!nb) return;
    const current = paramsRef.current;
    writeParametersCell(nb, current);
    const hash = paramsHash(canonicalize(current));
    nb.metadata = nb.metadata ?? {};
    nb.metadata.cobuild = { ...(nb.metadata.cobuild ?? { version: 1 }) };
    nb.metadata.cobuild.lastRun = { completedAt: Date.now(), paramsHash: hash };
    nb.metadata.cobuild.outputs = outputsRef.current as unknown[];
    nb.metadata.cobuild.runResult = runResultRef.current;
    await window.filesAPI.writeFile(notebookPath, serializeNotebook(nb));
    setLastRunHash(hash);
  }, [notebookPath]);

  const freshness: Freshness =
    lastRunHash === null
      ? "never"
      : currentHash === lastRunHash
        ? "fresh"
        : "stale";

  return {
    loading,
    params,
    setParams,
    selectInput,
    clearInput,
    readInput,
    outputs,
    setOutputs,
    runResult,
    setRunResult,
    freshness,
    markRunComplete,
  };
}
