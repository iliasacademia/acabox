import { Notification, app } from 'electron';
import type { WorkspaceController } from './WorkspaceController';
import {
  createNotification,
  listNotifications,
  getUnreadCount,
  markAllAsRead,
  type AppNotification,
  type CreateNotificationInput,
} from '../db/notificationsRepository';

export interface NotificationsControllerDeps {
  workspaceController: WorkspaceController;
  onDesktopNotificationClick: () => void;
}

export class NotificationsController {
  private activeDesktopNotifications = new Set<Notification>();
  private deps: NotificationsControllerDeps;

  constructor(deps: NotificationsControllerDeps) {
    this.deps = deps;
  }

  private get workspaceId(): string | null {
    return this.deps.workspaceController.workspaceId;
  }

  list(limit?: number): AppNotification[] {
    if (!this.workspaceId) return [];
    return listNotifications(this.workspaceId, limit);
  }

  create(input: CreateNotificationInput): string {
    return createNotification(input);
  }

  getUnreadCount(): number {
    if (!this.workspaceId) return 0;
    return getUnreadCount(this.workspaceId);
  }

  markAllAsRead(): void {
    if (!this.workspaceId) return;
    markAllAsRead(this.workspaceId);
    this.updateDockBadge();
  }

  updateDockBadge(): void {
    if (!app.dock) return;
    const count = this.getUnreadCount();
    app.dock.setBadge(count > 0 ? String(count) : '');
  }

  notifyUser(title: string, body: string): void {
    if (this.workspaceId) {
      createNotification({ workspaceId: this.workspaceId, type: 'briefing', title, body });
    }
    this.showDesktopNotification({ title, body, onClick: this.deps.onDesktopNotificationClick });
    this.updateDockBadge();
  }

  showDesktopNotification(opts: { title: string; body: string; onClick?: () => void }): void {
    const notification = new Notification({ title: opts.title, body: opts.body });
    const release = () => { this.activeDesktopNotifications.delete(notification); };
    notification.on('click', () => {
      release();
      opts.onClick?.();
    });
    notification.on('close', release);
    this.activeDesktopNotifications.add(notification);
    notification.show();
  }
}
