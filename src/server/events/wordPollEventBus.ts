/**
 * Event bus for overlay poll state changes (formerly Word-only — now host-agnostic).
 *
 * Emits a 'change' event whenever poll-relevant state mutates
 * (notifications synced, notification status changed, tracked PIDs changed,
 * project file cache changed, Obsidian workspace.json changed, etc.). The
 * WebSocket handler subscribes to this bus and pushes updated poll responses
 * to connected clients.
 *
 * `WordPoll*` names are kept as aliases for back-compat; prefer `OverlayPoll*`
 * in new code.
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
  | 'review-error-changed'
  | 'selected-text-changed'
  | 'selected-text-cleared'
  | 'obsidian-active-note-changed';

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

// Host-agnostic aliases. New code should use these names; old call sites keep
// working through the `wordPollEventBus`/`WordPollChangeReason` exports above.
export type OverlayPollChangeReason = WordPollChangeReason;
export const overlayPollEventBus = wordPollEventBus;
