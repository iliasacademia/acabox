/**
 * Pure classification tests for the ⌘F / ⌘G shortcut — no DOM event, no
 * Electron. See docs/design/find-in-page.md (F3) for the rule table this
 * pins.
 */

import { findShortcutAction, isInsideCodeMirror, type FindShortcutEvent } from '../findShortcut';

function evt(overrides: Partial<FindShortcutEvent>): FindShortcutEvent {
  return {
    key: '',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: null,
    ...overrides,
  };
}

describe('findShortcutAction', () => {
  it('⌘F opens the bar', () => {
    expect(findShortcutAction(evt({ key: 'f', metaKey: true }))).toBe('open');
  });

  it('Ctrl+F opens the bar', () => {
    expect(findShortcutAction(evt({ key: 'f', ctrlKey: true }))).toBe('open');
  });

  it('⇧⌘F is not the find shortcut', () => {
    expect(findShortcutAction(evt({ key: 'f', metaKey: true, shiftKey: true }))).toBeNull();
  });

  it('⌥⌘F is not the find shortcut', () => {
    expect(findShortcutAction(evt({ key: 'f', metaKey: true, altKey: true }))).toBeNull();
  });

  it('plain f (no modifier) is not a shortcut', () => {
    expect(findShortcutAction(evt({ key: 'f' }))).toBeNull();
  });

  it('⌘G steps forward', () => {
    expect(findShortcutAction(evt({ key: 'g', metaKey: true }))).toBe('next');
  });

  it('⇧⌘G steps backward', () => {
    expect(findShortcutAction(evt({ key: 'g', metaKey: true, shiftKey: true }))).toBe('prev');
  });

  it('⌘F inside a CodeMirror editor yields to its own search panel', () => {
    const editor = document.createElement('div');
    editor.className = 'cm-editor';
    const content = document.createElement('div');
    content.className = 'cm-content';
    editor.appendChild(content);
    expect(findShortcutAction(evt({ key: 'f', metaKey: true, target: content }))).toBeNull();
  });

  it('⌘F with the target inside the composer textarea still opens (browsers do)', () => {
    const textarea = document.createElement('textarea');
    expect(findShortcutAction(evt({ key: 'f', metaKey: true, target: textarea }))).toBe('open');
  });
});

describe('isInsideCodeMirror', () => {
  it('returns false for a null target', () => {
    expect(isInsideCodeMirror(null)).toBe(false);
  });
});
