import { randomUUID } from "crypto";
import * as path from "path";
import log from "electron-log";
import { resolveClaudeBinary } from "../sdkBinarySetup";
import { createReport, updateReportStatus } from "../db/reportRepository";
import { createBriefing } from "../db/briefingsRepository";
import {
  generateDirectoryTree,
  DIRECTORY_ORGANIZATION_PROMPT,
  type ScanParams,
  type ScannerEvent,
  type SuggestionParsed,
  type TaggedFileParsed,
  type ScanContext,
} from "./shared";
import { runResearchProfileAgent } from "./agents/researchProfile";
import { runTaskSuggestionAgent } from "./agents/taskSuggestion";
import {
  runFileTaggingAgent,
  type FileTaggingResult,
} from "./agents/fileTagging";

export type { ScannerEvent, ScanParams };

export async function scanWorkspaceDirectory(
  params: ScanParams,
): Promise<void> {
  const {
    workspaceId,
    directoryPath,
    memoryDir,
    apiKey,
    baseURL,
    onMessage,
    onBriefingsChanged,
  } = params;
  const reportId = randomUUID();

  log.info(
    `[DirectoryScanner] Starting scan for workspace ${workspaceId} at ${directoryPath}`,
  );

  const claudeBinaryPath = resolveClaudeBinary();
  if (!claudeBinaryPath) {
    log.error("[DirectoryScanner] Claude binary not found — skipping scan");
    onMessage({ type: "error", error: "Claude binary not found" });
    return;
  }

  createReport(reportId, workspaceId, "directory_scan");
  updateReportStatus(reportId, "running");

  const ctx: ScanContext = {
    claudeBinaryPath,
    directoryPath,
    apiKey,
    baseURL,
    abortController: new AbortController(),
    treeOutput: generateDirectoryTree(directoryPath),
    workspaceId,
    reportId,
    memoryDir,
    onMessage,
    onBriefingsChanged,
  };

  const scanStartTime = Date.now();
  onMessage({ type: "progress", text: "Analyzing workspace" });

  try {
    // Launch all three agents in parallel. We only await the profile agent
    // before signalling completion to the UI — the other two run in the
    // background and update the report / create briefings when they finish.
    const profilePromise = runResearchProfileAgent(ctx);
    const taggingPromise = runFileTaggingAgent(ctx);
    const suggestionPromise = runTaskSuggestionAgent(ctx);

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
    completeBackgroundWork(taggingPromise, suggestionPromise, ctx);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error(
      `[DirectoryScanner] Scan error for workspace ${workspaceId}:`,
      err,
    );
    updateReportStatus(reportId, "failed", undefined, errorMessage);
    onMessage({ type: "error", error: errorMessage });
  }
}

async function completeBackgroundWork(
  taggingPromise: Promise<FileTaggingResult>,
  suggestionPromise: Promise<SuggestionParsed[]>,
  ctx: ScanContext,
): Promise<void> {
  createBriefing({
    workspaceId: ctx.workspaceId,
    type: "suggested_action",
    sourceReportId: ctx.reportId,
    whyImSuggestingThis:
      "A well-organized workspace makes it easier to find files and helps me give better recommendations.",
    briefingData: {
      title: "Organize your research directory",
      description:
        "I will figure out an effective way to organize the files in your workspace.",
      chat_prompt: DIRECTORY_ORGANIZATION_PROMPT,
    },
  });
  ctx.onBriefingsChanged();

  const tagging = await taggingPromise.catch((err) => {
    log.error("[DirectoryScanner] File tagging agent failed:", err);
    return { taggedFiles: [] as TaggedFileParsed[] };
  });

  const suggestions = await suggestionPromise.catch((err) => {
    log.error("[DirectoryScanner] Task suggestion agent failed:", err);
    return [] as SuggestionParsed[];
  });

  updateReportStatus(
    ctx.reportId,
    "completed",
    JSON.stringify({ tagged_files: tagging.taggedFiles, suggestions }),
  );
  log.info(
    `[DirectoryScanner] Background agents completed for workspace ${ctx.workspaceId}`,
  );
}
