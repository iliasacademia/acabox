import * as path from 'path';
import log from 'electron-log';
import { scanWorkspaceDirectory, runInDepthScan, type ScannerEvent } from '../directoryScanner';
import { AGENT_MEMORY_SUBDIR } from '../../shared/paths';
import { captureError } from '../../shared/telemetry';
import type { WorkspaceController } from './WorkspaceController';
import type { NotificationsController } from './NotificationsController';
import type { ScanParams } from '../directoryScanner/shared';

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour (beta — reduce later)

const LOG_PREFIX = '[BriefingsController]';

export interface BriefingsControllerDeps {
  workspaceController: WorkspaceController;
  notificationsController: NotificationsController;
  getCredentials(): { apiKey: string | null; baseURL: string | undefined };
  ensureCredentials(): Promise<void>;
  onBriefingsChanged(): void;
  onScannerEvent(event: ScannerEvent): void;
}

export class BriefingsController {
  private workspaceController: WorkspaceController;
  private notificationsController: NotificationsController;
  private getCredentials: BriefingsControllerDeps['getCredentials'];
  private ensureCredentials: BriefingsControllerDeps['ensureCredentials'];
  private onBriefingsChanged: BriefingsControllerDeps['onBriefingsChanged'];
  private onScannerEvent: BriefingsControllerDeps['onScannerEvent'];
  private scheduledTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  constructor(deps: BriefingsControllerDeps) {
    this.workspaceController = deps.workspaceController;
    this.notificationsController = deps.notificationsController;
    this.getCredentials = deps.getCredentials;
    this.ensureCredentials = deps.ensureCredentials;
    this.onBriefingsChanged = deps.onBriefingsChanged;
    this.onScannerEvent = deps.onScannerEvent;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  startScheduledBriefings(): void {
    if (this.scheduledTimer) return;
    log.info(`${LOG_PREFIX} Starting — every ${INTERVAL_MS / 1000}s`);
    this.scheduledTimer = setTimeout(() => this.runScheduledCycle(), INTERVAL_MS);
  }

  stopScheduledBriefings(): void {
    if (this.scheduledTimer) {
      clearTimeout(this.scheduledTimer);
      this.scheduledTimer = null;
    }
    this.busy = false;
    log.info(`${LOG_PREFIX} Stopped`);
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

  async trigger(): Promise<void> {
    if (this.busy) {
      log.info(`${LOG_PREFIX} Already busy — skipping manual trigger`);
      return;
    }
    log.info(`${LOG_PREFIX} Manual trigger`);

    const scanParams = await this.buildScanParams();
    if (!scanParams) return;

    this.busy = true;
    try {
      await this.executeInDepthRun(scanParams);
    } finally {
      this.busy = false;
    }
  }

  private async runScheduledCycle(): Promise<void> {
    this.scheduledTimer = null;

    if (!this.busy) {
      const scanParams = await this.buildScanParams();
      if (scanParams) {
        this.busy = true;
        try {
          await this.executeInDepthRun(scanParams);
        } catch (err) {
          log.error(`${LOG_PREFIX} Scheduled run failed:`, err);
          captureError(err, { subsystem: 'briefings_controller' });
        } finally {
          this.busy = false;
        }
      }
    } else {
      log.info(`${LOG_PREFIX} Already busy — rescheduling`);
    }

    this.scheduledTimer = setTimeout(() => this.runScheduledCycle(), INTERVAL_MS);
  }

  private async buildScanParams(): Promise<ScanParams | null> {
    const workspace = this.workspaceController.activeWorkspace;
    if (!workspace) {
      log.info(`${LOG_PREFIX} No active workspace — skipping`);
      return null;
    }

    const directoryPaths = this.workspaceController.userDirectoryPaths;
    if (directoryPaths.length === 0) {
      log.warn(`${LOG_PREFIX} No user directories — skipping`);
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
      memoryDir: path.join(this.workspaceController.workspacePath, AGENT_MEMORY_SUBDIR),
      apiKey,
      baseURL,
      onMessage: () => {},
      onBriefingsChanged: this.onBriefingsChanged,
      onNotifyUser: this.notificationsController.notifyUser.bind(this.notificationsController),
    };
  }

  private async executeInDepthRun(scanParams: ScanParams): Promise<void> {
    try {
      log.info(`${LOG_PREFIX} Running in-depth suggestions for workspace ${scanParams.workspaceId}`);
      const notification = await runInDepthScan(scanParams);
      if (notification.made_changes) {
        this.onBriefingsChanged();
        this.notificationsController.notifyUser(notification.title, notification.body);
      }
      log.info(`${LOG_PREFIX} Completed (made_changes=${notification.made_changes})`);
    } catch (err) {
      log.error(`${LOG_PREFIX} Run failed:`, err);
      captureError(err, {
        subsystem: 'briefings_controller',
        extra: { workspace_id: scanParams.workspaceId },
      });
    }
  }
}
