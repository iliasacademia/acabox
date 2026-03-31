/**
 * Event bus for Word poll state changes.
 *
 * Emits a 'change' event whenever poll-relevant state mutates
 * (notifications synced, notification status changed, tracked PIDs changed,
 * project file cache changed). The WebSocket handler subscribes to this bus
 * and pushes updated poll responses to connected clients.
 */

import { EventEmitter } from 'events';
import { logToWindowMonitorDb } from '../../windowMonitorDb';

export type WordPollChangeReason =
  | 'notifications-synced'
  | 'notification-status-changed'
  | 'tracked-pids-changed'
  | 'project-file-cache-changed'
  | 'v2-project-file-cache-changed'
  | 'window-document-path-changed'
  | 'reviewing-state-changed'
  | 'webview-visibility-changed'
  | 'review-error-changed';

interface WordPollEvents {
  change: [reason: WordPollChangeReason];
}

class WordPollEventBus extends EventEmitter {
  emit(event: 'change', reason: WordPollChangeReason): boolean {
    logToWindowMonitorDb('word_poll_event', { event, reason });
    return super.emit(event, reason);
  }

  on(event: 'change', listener: (reason: WordPollChangeReason) => void): this {
    return super.on(event, listener);
  }

  off(event: 'change', listener: (reason: WordPollChangeReason) => void): this {
    return super.off(event, listener);
  }
}

export const wordPollEventBus = new WordPollEventBus();
