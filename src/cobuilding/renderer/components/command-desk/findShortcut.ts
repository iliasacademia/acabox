/**
 * ⌘F / ⌘G shortcut classification for the main renderer.
 *
 * Pure and Electron-free so it is unit-testable without a real keyboard
 * event or DOM: docs/design/find-in-page.md (F3). ⌘F opens the find bar,
 * ⌘G / ⇧⌘G steps the active query — except inside a CodeMirror editor,
 * where ⌘F must yield to CodeMirror's own search panel (`basicSetup` binds
 * ⌘F to it; see `components/notebook/CodeEditor.tsx`).
 */

export type FindShortcutAction = 'open' | 'next' | 'prev';

export interface FindShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

/** True when `target` is a Node with a `.cm-editor` ancestor (inclusive). */
export function isInsideCodeMirror(target: EventTarget | null): boolean {
  if (!target || !(target instanceof Node)) return false;
  const el: Element | null =
    target.nodeType === Node.ELEMENT_NODE ? (target as Element) : target.parentElement;
  return el ? el.closest('.cm-editor') !== null : false;
}

export function findShortcutAction(e: FindShortcutEvent): FindShortcutAction | null {
  const mod = e.metaKey || e.ctrlKey;
  if (e.altKey) return null;
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'f') {
    return isInsideCodeMirror(e.target) ? null : 'open';
  }
  if (mod && e.key.toLowerCase() === 'g') {
    return e.shiftKey ? 'prev' : 'next';
  }
  return null;
}
