import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuiState, useComposerRuntime } from '@assistant-ui/react';
import { MSymbol } from './MSymbol';
import {
  ensureChatIndex,
  filterChats,
  lookupChatRef,
  useChatIndex,
  type ChatIndexEntry,
} from './chatIndex';
import {
  formatChatRef,
  parseChatRefs,
  splitOnChatRefs,
  MAX_CHAT_REFS_PER_MESSAGE,
} from '../../../shared/chatRefs';
import { matchAtTrigger } from './atMention';
import type { FC } from 'react';

/**
 * Referencing another conversation from the composer.
 *
 * THE REFERENCE LIVES IN THE MESSAGE TEXT, not in a parallel field, and that
 * single decision is what keeps this small. Picking a chat inserts a
 * `[[chat:177d891b]]` token at the caret, so:
 *
 *  - pasting a token copied from another chat's header behaves identically to
 *    picking one, with no second code path;
 *  - the stored row carries the reference for free, so a reloaded bubble
 *    still shows what was pointed at, with no new column and no history
 *    converter;
 *  - the user can edit or delete it like any other text, which is the one
 *    interaction a chip in a separate field always has to reinvent;
 *  - main resolves it on the way out (`resolveChatRefs`), so a reference the
 *    agent itself wrote in an earlier reply works too.
 *
 * The chips below the input are therefore a VIEW of the text, derived on every
 * render, never a source of truth that could drift from it.
 */

function useComposerTextarea(anchor: HTMLElement | null): HTMLTextAreaElement | null {
  const [el, setEl] = useState<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!anchor) return;
    // Climbed from this component's own node rather than looked up on
    // `document`: two composers are mounted at once (docked and tool side
    // panel), and a document-wide query would wire the side panel's picker to
    // the docked textarea — typing "@" in one would open a picker under the
    // other. Climbing also means neither composer's root class name is
    // baked in here, which is what makes this work unchanged in both.
    let node: HTMLElement | null = anchor.parentElement;
    let found: HTMLTextAreaElement | null = null;
    for (let depth = 0; node && depth < 4 && !found; depth += 1) {
      found = node.querySelector('textarea');
      node = node.parentElement;
    }
    setEl(found);
  }, [anchor]);
  return el;
}

interface PickerState {
  open: boolean;
  query: string;
  /** Characters before the caret that the insertion replaces (the "@query"). */
  replaceLen: number;
  /** Offset of the `@` that opened it, so a dismissal can be remembered. */
  atIndex: number;
}

const CLOSED: PickerState = { open: false, query: '', replaceLen: 0, atIndex: -1 };

/**
 * The picker list. Rendered above the composer so it never covers the text
 * being typed, and so it behaves the same in the 320px-wide side panel as in
 * the docked composer.
 */
const ChatPickerList: FC<{
  query: string;
  onPick: (entry: ChatIndexEntry) => void;
  onClose: () => void;
}> = ({ query, onPick, onClose }) => {
  const all = useChatIndex();
  const activeThreadId = useAuiState((s: any) => s.threadListItem?.remoteId) as string | undefined;
  const [highlight, setHighlight] = useState(0);
  const results = useMemo(
    () => filterChats(all, query, activeThreadId).slice(0, 8),
    [all, query, activeThreadId],
  );

  useEffect(() => { setHighlight(0); }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (!results.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => (h + 1) % results.length); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => (h - 1 + results.length) % results.length); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); onPick(results[highlight]); }
    };
    // Capture, because the composer's own Enter handler would otherwise send
    // the message while the picker is open and the user is choosing a chat.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [results, highlight, onPick, onClose]);

  return (
    <div className="cdChatPicker" role="listbox" aria-label="Reference another chat">
      <div className="cdChatPicker__head">
        {query ? `Chats matching “${query}”` : 'Reference another chat'}
      </div>
      {results.length === 0 && (
        <div className="cdChatPicker__empty">
          {all.length === 0 ? 'No other chats yet.' : 'No chat matches that.'}
        </div>
      )}
      {results.map((entry, i) => (
        <button
          key={entry.id}
          type="button"
          role="option"
          aria-selected={i === highlight}
          className={`cdChatPicker__row${i === highlight ? ' is-active' : ''}`}
          onMouseEnter={() => setHighlight(i)}
          onMouseDown={(e) => { e.preventDefault(); onPick(entry); }}
        >
          <MSymbol name={entry.appDirName ? 'widgets' : 'forum'} size={15} />
          <span className="cdChatPicker__title">{entry.title}</span>
          <span className="cdChatPicker__id">{entry.id.slice(0, 8)}</span>
        </button>
      ))}
    </div>
  );
};

/**
 * Chips above the composer naming each referenced chat, plus the picker.
 *
 * Rendered as one component because the two share the composer text: the
 * chips read it, the picker writes it.
 */
export const ChatReferenceBar: FC = () => {
  // A callback ref, not useRef: the effect that finds the textarea has to
  // run again once the element exists, and assigning `.current` does not
  // re-render, so a plain ref would look up `null` exactly once and the
  // "@" trigger would never attach.
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const composerRuntime = useComposerRuntime();
  const text = (useAuiState((s: any) => s.composer?.text) as string | undefined) ?? '';
  const textarea = useComposerTextarea(anchor);
  const [picker, setPicker] = useState<PickerState>(CLOSED);
  // Escape has to STICK. Without remembering which `@` was dismissed, the very
  // next keystroke re-runs the trigger, matches the same `@`, and reopens the
  // picker — so Escape appears to do nothing and the only way out is deleting
  // the `@`. Reset implicitly: a different `@` has a different offset.
  const [dismissedAt, setDismissedAt] = useState(-1);
  useChatIndex(); // subscribe, so a rename re-labels the chips already shown

  useEffect(() => { ensureChatIndex(); }, []);

  const refs = useMemo(() => parseChatRefs(text), [text]);

  // `@` opens the picker. Read from the DOM rather than from the runtime's
  // text because only the DOM knows where the caret is — "@" typed in the
  // middle of an existing sentence must not match the end of the string.
  useEffect(() => {
    if (!textarea) return;
    const onInput = () => {
      const caret = textarea.selectionStart ?? 0;
      const match = matchAtTrigger(textarea.value.slice(0, caret));
      if (!match) {
        setPicker((p) => (p.open ? CLOSED : p));
        setDismissedAt(-1);
        return;
      }
      const { query, atIndex } = match;
      if (atIndex === dismissedAt) return;
      setPicker({ open: true, query, replaceLen: query.length + 1, atIndex });
    };
    textarea.addEventListener('input', onInput);
    return () => textarea.removeEventListener('input', onInput);
  }, [textarea, dismissedAt]);

  const insert = useCallback((entry: ChatIndexEntry) => {
    const token = formatChatRef(entry.id);
    const current = textarea?.value ?? text;
    const caret = textarea?.selectionStart ?? current.length;
    // Replace the "@query" that opened the picker, when that is how it was
    // opened; otherwise insert at the caret.
    const start = caret - picker.replaceLen;
    const next = `${current.slice(0, start)}${token} ${current.slice(caret)}`;
    composerRuntime.setText(next);
    setPicker(CLOSED);
    // Restore the caret after the inserted token. Deferred a tick because
    // setText re-renders the textarea and would otherwise drop the selection
    // to the end of the field.
    const position = start + token.length + 1;
    setTimeout(() => {
      textarea?.focus();
      textarea?.setSelectionRange(position, position);
    }, 0);
  }, [composerRuntime, picker.replaceLen, text, textarea]);

  const remove = useCallback((written: string) => {
    const current = textarea?.value ?? text;
    // The reference alphabet includes `.` and `-`, so the id has to be
    // escaped before it becomes a pattern — an unescaped `a.c` would also
    // strip a reference to `abc`.
    const escaped = written.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    composerRuntime.setText(
      current.replace(new RegExp(`\\[\\[chat:${escaped}\\]\\]\\s?`, 'gi'), '').trimStart(),
    );
  }, [composerRuntime, text, textarea]);

  return (
    <div className="cdChatRefBar" ref={setAnchor}>
      {picker.open && (
        <ChatPickerList
          query={picker.query}
          onPick={insert}
          onClose={() => { setDismissedAt(picker.atIndex); setPicker(CLOSED); }}
        />
      )}
      {refs.length > 0 && (
        <div className="cdChatRefChips">
          {refs.map((written) => {
            const entry = lookupChatRef(written);
            return (
              <span
                key={written}
                className={`cdChatRefChip${entry ? '' : ' cdChatRefChip--unknown'}`}
                title={entry ? `Referenced chat · ${entry.id}` : 'No chat matches this reference'}
              >
                <MSymbol name={entry ? 'forum' : 'help' } size={13} />
                <span className="cdChatRefChip__label">
                  {entry ? entry.title : `Unknown chat ${written}`}
                </span>
                <button
                  type="button"
                  className="cdChatRefChip__x"
                  aria-label={`Remove reference to ${entry ? entry.title : written}`}
                  onClick={() => remove(written)}
                >
                  <MSymbol name="close" size={13} />
                </button>
              </span>
            );
          })}
          {refs.length > MAX_CHAT_REFS_PER_MESSAGE && (
            <span className="cdChatRefChip cdChatRefChip--unknown">
              Only the first {MAX_CHAT_REFS_PER_MESSAGE} are sent
            </span>
          )}
        </div>
      )}
    </div>
  );
};

/** Toolbar control, beside Attach. Present so the feature is discoverable by
 *  someone who would never think to try "@". */
export const ChatReferenceButton: FC = () => {
  const [open, setOpen] = useState(false);
  useEffect(() => { ensureChatIndex(); }, []);
  const composerRuntime = useComposerRuntime();
  const text = (useAuiState((s: any) => s.composer?.text) as string | undefined) ?? '';

  const insert = useCallback((entry: ChatIndexEntry) => {
    const token = formatChatRef(entry.id);
    composerRuntime.setText(text ? `${text.replace(/\s*$/, '')} ${token} ` : `${token} `);
    setOpen(false);
  }, [composerRuntime, text]);

  return (
    <span className="cdChatRefBtnWrap">
      {open && (
        <ChatPickerList query="" onPick={insert} onClose={() => setOpen(false)} />
      )}
      <button
        type="button"
        className="cdIconBtn"
        title="Reference another chat"
        aria-label="Reference another chat"
        aria-expanded={open}
        onClick={() => { ensureChatIndex(true); setOpen((o) => !o); }}
      >
        <MSymbol name="forum" size={19} />
      </button>
    </span>
  );
};

/**
 * A reference rendered inside a message, as a chip that opens that chat.
 *
 * The same component serves the user's own message (where the token is text
 * they typed or pasted) and the agent's reply (where it may have written one
 * itself, having been handed the id). Resolution is against the cached index,
 * so a reference to a chat that has since been deleted renders as visibly
 * unknown rather than as a link that goes nowhere.
 */
export const ChatRefLink: FC<{ written: string }> = ({ written }) => {
  useChatIndex();
  useEffect(() => { ensureChatIndex(); }, []);
  const entry = lookupChatRef(written);

  if (!entry) {
    return (
      <span className="cdChatRefLink cdChatRefLink--unknown" title={`No chat matches ${written}`}>
        <MSymbol name="help" size={13} />
        chat {written}
      </span>
    );
  }
  return (
    <span
      className="cdChatRefLink"
      role="link"
      tabIndex={0}
      title={`Open “${entry.title}”`}
      onClick={() => window.dispatchEvent(
        new CustomEvent('cd:open-chat', { detail: { threadId: entry.id } }),
      )}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent('cd:open-chat', { detail: { threadId: entry.id } }));
        }
      }}
    >
      <MSymbol name="forum" size={13} />
      {entry.title}
    </span>
  );
};

/**
 * The `Text` part renderer for a USER message.
 *
 * User messages are deliberately not rendered as markdown — what someone
 * typed should appear as they typed it — so they do not pass through
 * `markdown-text.tsx` and would otherwise show the raw `[[chat:…]]` token.
 * Caught by looking at a real sent message, not by a test: every assertion
 * was about what the agent received, and the token was correct there.
 *
 * This renders the text verbatim except for the references, which become the
 * same chip the assistant's replies get, so both sides of the conversation
 * show a reference the same way.
 */
export const UserTextWithChatRefs: FC<{ text: string }> = ({ text }) => {
  const segments = splitOnChatRefs(text ?? '');
  if (segments.length === 1 && segments[0].kind === 'text') return <>{text}</>;
  return (
    <>
      {segments.map((segment, i) => (segment.kind === 'ref'
        ? <ChatRefLink key={`r${i}`} written={segment.written} />
        : <React.Fragment key={`t${i}`}>{segment.text}</React.Fragment>))}
    </>
  );
};
