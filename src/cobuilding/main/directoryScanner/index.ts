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
import { runFileTaggingAgent } from "./agents/fileTagging";
import { captureError } from "../../shared/telemetry";

export type { ScannerEvent, ScanParams };

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
  };

  const scanStartTime = Date.now();
  onMessage({ type: "progress", text: "Analyzing workspace" });

  try {
    // Launch both agents in parallel. We only await the profile agent
    // before signalling completion to the UI — tagging runs in the
    // background and updates the report / creates briefings when it finishes.
    const profilePromise = runResearchProfileAgent(ctx);
    const taggingPromise = runFileTaggingAgent(ctx);

    const profile = await profilePromise;

    const profileSeconds = Math.round((Date.now() - scanStartTime) / 1000);
    log.info(
      `[DirectoryScanner] Profile agent completed in ${profileSeconds}s`,
    );
    onMessage({ type: "timing", label: "Scan", seconds: profileSeconds });

    const reportData = JSON.stringify(profile);
    updateReportStatus(reportId, "completed", reportData);
    onMessage({ type: "complete", reportId, reportData });

    // Background agent — fire-and-forget
    taggingPromise
      .then(() => {
        log.info(
          `[DirectoryScanner] Background agents completed for workspace ${ctx.workspaceId}`,
        );
      })
      .catch((err) => {
        log.error("[DirectoryScanner] File tagging agent failed:", err);
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
