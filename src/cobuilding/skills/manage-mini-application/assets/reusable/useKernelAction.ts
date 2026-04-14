import { useCallback, useEffect, useRef, useState } from "react";
import { formatParamsAssignment } from "./useAppState";

// Standard run lifecycle for a notebook-backed mini-app.
//
// Every kernel-backed app needs the same six steps:
//   1. Connect to the kernel (`ir` or `python3`).
//   2. Inject `params_json` into the kernel using the exact same canonical
//      format the persisted parameters cell uses.
//   3. Find the `action`-tagged cell in `notebook.ipynb`.
//   4. Execute it.
//   5. Surface any error outputs to the user.
//   6. Track UI state — running / error / complete + elapsed timer.
//
// `useKernelAction` does all of that. Errors flow through the existing
// global `ErrorDisplay` (via `cobuild-error` custom events), so apps don't
// need to roll their own red-bordered error panel.
//
// After `await action.run()` succeeds, the caller is responsible for the
// app-specific *post-run* work: reading output files, calling `setOutputs`
// / `setRunResult` on `useAppState`, and `markRunComplete`.

declare const window: Window & {
  filesAPI: {
    readFile(
      path: string,
    ): Promise<
      | { type: "text"; content: string }
      | { type: "image"; fileUrl: string }
      | { error: string; size?: number }
    >;
  };
  kernel: {
    connect(kernelName: string): Promise<unknown>;
    executeCode(code: string): Promise<KernelOutput[]>;
  };
};

interface KernelOutput {
  output_type: string;
  name?: string;
  text?: string | string[];
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

export type KernelActionPhase = "idle" | "running" | "complete" | "error";

export type KernelName = "ir" | "python3" | (string & {});

export interface UseKernelActionOptions {
  dirName: string;
  kernel: KernelName;
  /**
   * Build the parameter object that gets serialized into `params_json` and
   * injected into the kernel. Called fresh at the start of every `run()`.
   * Typically composed from `useAppState`'s `params` plus run-time-only
   * fields like `outdir`.
   */
  buildKernelParams: () => Record<string, unknown>;
}

export interface UseKernelActionResult {
  /**
   * Connect (if needed), inject params, execute the action cell. Resolves
   * with `{ ok: true }` on success, `{ ok: false }` if anything failed.
   * Errors are already surfaced via the global `ErrorDisplay` — callers
   * just check `ok` and skip post-run work on failure.
   */
  run: () => Promise<{ ok: true } | { ok: false }>;
  phase: KernelActionPhase;
  elapsedSeconds: number;
}

function joinSource(source: unknown): string {
  if (Array.isArray(source)) return source.join("");
  if (typeof source === "string") return source;
  return "";
}

interface NotebookCell {
  metadata?: { tags?: string[] };
  source?: string | string[];
}

/**
 * Dispatch a runtime error into the same `cobuild-error` channel that
 * `_bridge/error-capture.ts` uses, so it lands in the floating
 * `ErrorDisplay` panel (with the "Fix" button wired up) instead of an
 * app-specific red box. One error UI for the whole app.
 */
function dispatchKernelError(message: string, stack?: string, source?: string): void {
  window.dispatchEvent(
    new CustomEvent("cobuild-error", {
      detail: {
        kind: "exception",
        message,
        stack,
        source,
        timestamp: Date.now(),
      },
    }),
  );
}

export function useKernelAction(
  options: UseKernelActionOptions,
): UseKernelActionResult {
  const { dirName, kernel, buildKernelParams } = options;
  const [phase, setPhase] = useState<KernelActionPhase>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const buildKernelParamsRef = useRef(buildKernelParams);
  buildKernelParamsRef.current = buildKernelParams;

  // Elapsed timer — tied to phase, identical pattern across every app.
  useEffect(() => {
    if (phase !== "running") return;
    setElapsedSeconds(0);
    const interval = setInterval(() => {
      setElapsedSeconds((s) => s + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [phase]);

  const run = useCallback(async (): Promise<{ ok: true } | { ok: false }> => {
    setPhase("running");
    try {
      await window.kernel.connect(kernel);

      const kernelParams = buildKernelParamsRef.current();
      const paramsCode = formatParamsAssignment(kernelParams, kernel);
      let outputs = await window.kernel.executeCode(paramsCode);
      for (const o of outputs) {
        if (o.output_type === "error") {
          dispatchKernelError(
            `${o.ename ?? "Error"}: ${o.evalue ?? ""}`,
            o.traceback?.join("\n"),
            "kernel: parameters cell",
          );
          setPhase("error");
          return { ok: false };
        }
      }

      // Read the action cell out of the notebook by tag. We re-read every
      // run so the cell can be edited (in the source viewer or directly in
      // a Jupyter editor) between runs without restarting the app.
      const notebookPath = `.applications/${dirName}/notebook.ipynb`;
      const nbResult = await window.filesAPI.readFile(notebookPath);
      if (!("type" in nbResult) || nbResult.type !== "text") {
        dispatchKernelError(
          `Failed to read notebook at ${notebookPath}`,
          undefined,
          "useKernelAction",
        );
        setPhase("error");
        return { ok: false };
      }
      let actionCode: string;
      try {
        const notebook = JSON.parse(nbResult.content) as { cells?: NotebookCell[] };
        const actionCell = notebook.cells?.find((c) =>
          c.metadata?.tags?.includes("action"),
        );
        if (!actionCell) {
          dispatchKernelError(
            "No cell tagged 'action' found in notebook.ipynb",
            undefined,
            "useKernelAction",
          );
          setPhase("error");
          return { ok: false };
        }
        actionCode = joinSource(actionCell.source);
      } catch (err) {
        dispatchKernelError(
          `Notebook JSON is invalid: ${err instanceof Error ? err.message : String(err)}`,
          undefined,
          "useKernelAction",
        );
        setPhase("error");
        return { ok: false };
      }

      outputs = await window.kernel.executeCode(actionCode);
      for (const o of outputs) {
        if (o.output_type === "error") {
          dispatchKernelError(
            `${o.ename ?? "Error"}: ${o.evalue ?? ""}`,
            o.traceback?.join("\n"),
            "kernel: action cell",
          );
          setPhase("error");
          return { ok: false };
        }
      }

      setPhase("complete");
      return { ok: true };
    } catch (err) {
      dispatchKernelError(
        err instanceof Error ? err.message : String(err),
        err instanceof Error ? err.stack : undefined,
        "useKernelAction",
      );
      setPhase("error");
      return { ok: false };
    }
  }, [dirName, kernel]);

  return { run, phase, elapsedSeconds };
}
