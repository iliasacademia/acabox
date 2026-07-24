import * as path from 'path';
import log from 'electron-log';
import { scanWorkspaceDirectory, type ScannerEvent } from '../directoryScanner';
import { AGENT_MEMORY_SUBDIR } from '../../shared/paths';
import type { WorkspaceController } from './WorkspaceController';
import type { ScanParams } from '../directoryScanner/shared';
import { listWorkspaceDirectoriesBySource } from '../db/workspaceRepository';

const LOG_PREFIX = '[BriefingsController]';

export interface BriefingsControllerDeps {
  workspaceController: WorkspaceController;
  getCredentials(): { apiKey: string | null; baseURL: string | undefined };
  ensureCredentials(): Promise<void>;
  onBriefingsChanged(): void;
  onScannerEvent(event: ScannerEvent): void;
}

export class BriefingsController {
  private workspaceController: WorkspaceController;
  private getCredentials: BriefingsControllerDeps['getCredentials'];
  private ensureCredentials: BriefingsControllerDeps['ensureCredentials'];
  private onBriefingsChanged: BriefingsControllerDeps['onBriefingsChanged'];
  private onScannerEvent: BriefingsControllerDeps['onScannerEvent'];
  private busy = false;

  constructor(deps: BriefingsControllerDeps) {
    this.workspaceController = deps.workspaceController;
    this.getCredentials = deps.getCredentials;
    this.ensureCredentials = deps.ensureCredentials;
    this.onBriefingsChanged = deps.onBriefingsChanged;
    this.onScannerEvent = deps.onScannerEvent;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  async runInitialWorkspaceScan(): Promise<void> {
    if (this.busy) {
      log.warn(`${LOG_PREFIX} Already busy — ignoring duplicate scan request`);
      return;
    }

    const scanParams = await this.buildScanParams();
    if (!scanParams) return;

    this.busy = true;
    try {
      await scanWorkspaceDirectory({
        ...scanParams,
        onMessage: this.onScannerEvent,
      });
    } finally {
      this.busy = false;
    }
  }

  private async buildScanParams(): Promise<ScanParams | null> {
    const workspace = this.workspaceController.activeWorkspace;
    if (!workspace) {
      log.info(`${LOG_PREFIX} No active workspace — skipping`);
      return null;
    }

    const directoryPaths = this.workspaceController.userDirectoryPaths;
    const driveDirs = listWorkspaceDirectoriesBySource(workspace.id, 'google-drive')
      .map(d => {
        const meta = d.metadata ? JSON.parse(d.metadata) : {};
        return { driveId: meta.driveId as string, name: d.display_name, mimeType: meta.mimeType as string | undefined };
      })
      .filter(d => d.driveId);
    if (directoryPaths.length === 0 && driveDirs.length === 0) {
      log.warn(`${LOG_PREFIX} No directories to scan — skipping`);
      return null;
    }

    let { apiKey, baseURL } = this.getCredentials();
    if (!apiKey) {
      await this.ensureCredentials();
      ({ apiKey, baseURL } = this.getCredentials());
    }
    if (!apiKey) {
      log.warn(`${LOG_PREFIX} No API key available — skipping`);
      return null;
    }

    return {
      workspaceId: workspace.id,
      cwd: this.workspaceController.workspacePath,
      directoryPaths,
      driveDirectories: driveDirs.length > 0 ? driveDirs : undefined,
      memoryDir: path.join(this.workspaceController.workspacePath, AGENT_MEMORY_SUBDIR),
      apiKey,
      baseURL,
      onMessage: () => {},
      onBriefingsChanged: this.onBriefingsChanged,
    };
  }
}
