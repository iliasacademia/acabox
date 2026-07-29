import { useCallback, useEffect, useState } from "react";

/**
 * Detect work that finished while this tool was closed.
 *
 * A tool's UI is not where its work lives. Long operations — a kernel run, a
 * shell command — are owned by Acabox itself, and a shell command keeps running
 * even after the whole app has quit. So a run can complete at a moment when
 * there is no component around to call `setOutputs` / `markRunComplete`. The
 * files land in `output/`; the app just never hears about them, and on reopen
 * it looks like the run never happened.
 *
 * This hook closes that gap. It compares the host's record of finished work
 * against the last run this app actually recorded (`lastRunAt` from
 * `useAppState`) and reports anything newer.
 *
 * ```tsx
 * const { params, outputs, setOutputs, setRunResult, lastRunAt, markRunComplete } =
 *   useAppState<MyParams, OutputFile, MyRunResult>({ dirName: DIR_NAME, defaults });
 *
 * const { missedRuns, dismiss } = useRunsWhileClosed(DIR_NAME, lastRunAt);
 *
 * useEffect(() => {
 *   if (missedRuns.length === 0) return;
 *   void (async () => {
 *     // The results are already on disk — adopt them.
 *     const meta = await readJsonOutput<MyRunResultFile>(
 *       `.applications/${DIR_NAME}/output/run_metadata.json`,
 *     );
 *     if (meta) {
 *       setRunResult({ ...  });
 *       setOutputs(meta.files.map(toOutputFile));
 *       await markRunComplete();
 *     }
 *     dismiss();
 *   })();
 * }, [missedRuns]);
 * ```
 */

export interface HostJob {
  id: string;
  dirName: string;
  kind: "command" | "kernel" | "claude" | "agent-tool";
  label: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "done" | "failed" | "interrupted" | "finishedWhileAway";
}

/** Statuses that mean work stopped without this app recording the outcome. */
const UNRECORDED = new Set(["done", "finishedWhileAway"]);

let seq = 0;
const pending = new Map<string, (value: unknown) => void>();
let listening = false;

function ensureListener(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("message", (event: MessageEvent) => {
    const data: any = event.data;
    if (data?.type === "response" && pending.has(data.id)) {
      const resolve = pending.get(data.id)!;
      pending.delete(data.id);
      resolve(data.error ? [] : data.result);
    }
  });
}

function listJobs(): Promise<HostJob[]> {
  ensureListener();
  const id = `jobs-${++seq}`;
  return new Promise((resolve) => {
    pending.set(id, (v) => resolve(Array.isArray(v) ? (v as HostJob[]) : []));
    parent.postMessage({ type: "jobs:listForApp", id }, "*");
    // The bridge always answers, but never hang the app if it somehow doesn't.
    setTimeout(() => {
      if (pending.delete(id)) resolve([]);
    }, 5000);
  });
}

export function useRunsWhileClosed(
  dirName: string,
  lastRunAt: number | null,
): { missedRuns: HostJob[]; dismiss: () => void } {
  const [missedRuns, setMissedRuns] = useState<HostJob[]>([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listJobs().then((jobs) => {
      if (cancelled || dismissed) return;
      setMissedRuns(
        jobs.filter(
          (j) =>
            j.dirName === dirName &&
            UNRECORDED.has(j.status) &&
            typeof j.endedAt === "number" &&
            j.endedAt > (lastRunAt ?? 0),
        ),
      );
    });
    return () => {
      cancelled = true;
    };
    // `lastRunAt` moves once the app records the run, which clears this list.
  }, [dirName, lastRunAt, dismissed]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    setMissedRuns([]);
  }, []);

  return { missedRuns, dismiss };
}
