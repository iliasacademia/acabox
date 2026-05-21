import { randomUUID } from "crypto";
import log from "electron-log";
import { createReport, updateReportStatus } from "../db/reportRepository";
import {
  generateDirectoryTree,
  type ScanParams,
  type ScannerEvent,
  type ScanContext,
  type TreeOutput,
} from "./shared";
import { runResearchProfileAgent } from "./agents/researchProfile";
import { runQuickTaskSuggestionAgent, runInDepthTaskSuggestionAgent, type NotificationOutput } from "./agents/taskSuggestion";
import { runFileTaggingAgent } from "./agents/fileTagging";
import { captureError } from "../../shared/telemetry";

export type { ScannerEvent, ScanParams, NotificationOutput };

export async function scanWorkspaceDirectory(
  params: ScanParams,
): Promise<void> {
  const {
    workspaceId,
    directoryPaths,
    driveDirectories,
    memoryDir,
    apiKey,
    baseURL,
    onMessage,
    onBriefingsChanged,
  } = params;
  const reportId = randomUUID();

  log.info(
    `[DirectoryScanner] Starting scan for workspace ${workspaceId} at [${directoryPaths.join(', ')}]` +
    (driveDirectories?.length ? ` + ${driveDirectories.length} Drive folder(s)` : ''),
  );

  createReport(reportId, workspaceId, "directory_scan");
  updateReportStatus(reportId, "running");

  const treeOutputs: TreeOutput[] = directoryPaths.map((dp) => ({
    directoryPath: dp,
    tree: generateDirectoryTree(dp),
    source: 'local' as const,
  }));

  const ctx: ScanContext = {
    cwd: params.cwd,
    directoryPaths,
    apiKey,
    baseURL,
    abortController: new AbortController(),
    treeOutputs,
    workspaceId,
    reportId,
    memoryDir,
    onMessage,
    onBriefingsChanged,
    onNotifyUser: params.onNotifyUser,
  };

  const scanStartTime = Date.now();
  onMessage({ type: "progress", text: "Analyzing workspace" });

  try {
    // Launch all three agents in parallel. We only await the profile agent
    // before signalling completion to the UI — the other two run in the
    // background and update the report / create briefings when they finish.
    const profilePromise = runResearchProfileAgent(ctx);
    const taggingPromise = runFileTaggingAgent(ctx);
    const suggestionPromise = runQuickTaskSuggestionAgent(ctx);

    const profile = await profilePromise;

    const profileSeconds = Math.round((Date.now() - scanStartTime) / 1000);
    log.info(
      `[DirectoryScanner] Profile agent completed in ${profileSeconds}s`,
    );
    onMessage({ type: "timing", label: "Scan", seconds: profileSeconds });

    const reportData = JSON.stringify(profile);
    updateReportStatus(reportId, "completed", reportData);
    onMessage({ type: "complete", reportId, reportData });

    // Background agents — fire-and-forget
    completeBackgroundWork(taggingPromise, suggestionPromise, ctx).catch((err) => {
      log.error("[DirectoryScanner] Background work failed:", err);
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error(
      `[DirectoryScanner] Scan error for workspace ${workspaceId}:`,
      err,
    );
    captureError(err, {
      subsystem: 'workspace_scan',
      extra: { workspace_id: workspaceId, report_id: reportId },
    });
    updateReportStatus(reportId, "failed", undefined, errorMessage);
    onMessage({ type: "error", error: errorMessage });
  }
}

export async function runInDepthScan(params: ScanParams): Promise<NotificationOutput> {
  const treeOutputs: TreeOutput[] = params.directoryPaths.map((dp) => ({
    directoryPath: dp,
    tree: generateDirectoryTree(dp),
    source: 'local' as const,
  }));

  const ctx: ScanContext = {
    cwd: params.cwd,
    directoryPaths: params.directoryPaths,
    apiKey: params.apiKey,
    baseURL: params.baseURL,
    abortController: new AbortController(),
    treeOutputs,
    workspaceId: params.workspaceId,
    reportId: randomUUID(),
    memoryDir: params.memoryDir,
    onMessage: params.onMessage,
    onBriefingsChanged: params.onBriefingsChanged,
    onNotifyUser: params.onNotifyUser,
  };

  return runInDepthTaskSuggestionAgent(ctx);
}

async function completeBackgroundWork(
  taggingPromise: Promise<unknown>,
  suggestionPromise: Promise<void>,
  ctx: ScanContext,
): Promise<void> {
  await suggestionPromise.catch((err) => {
    log.error("[DirectoryScanner] Quick task suggestion agent failed:", err);
  });
  ctx.onBriefingsChanged();

  try {
    const notification = await runInDepthTaskSuggestionAgent(ctx);
    if (notification.made_changes) {
      ctx.onBriefingsChanged();
      ctx.onNotifyUser(notification.title, notification.body);
    }
  } catch (err) {
    log.error("[DirectoryScanner] In-depth task suggestion agent failed:", err);
  }

  await taggingPromise.catch((err) => {
    log.error("[DirectoryScanner] File tagging agent failed:", err);
  });

  log.info(
    `[DirectoryScanner] Background agents completed for workspace ${ctx.workspaceId}`,
  );
}
