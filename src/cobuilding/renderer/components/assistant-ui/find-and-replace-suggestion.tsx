import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { CheckIcon, LoaderIcon, XCircleIcon, MinusCircleIcon, CopyIcon, ChevronDownIcon, ChevronRightIcon } from 'lucide-react';

/**
 * Suggestion card for mcp__ms-word__find_and_replace.
 *
 * The tool always returns a proposal (never executes directly).
 * This card shows the diff and Approve/Deny buttons.
 * Approved edits are applied via POST /api/cobuilding/apply-edit.
 */

// ─── Helpers ─────────────────────────────────────────────────────

interface EditProposal {
  proposed?: boolean;
  document_path?: string;
  search_text?: string;
  replacement_text?: string;
  replace_scope?: string;
  match_case?: boolean;
  doc_offset?: number;
}

function parseResult(result: unknown): EditProposal | null {
  if (!result) return null;
  try {
    // Result can be: a JSON string, an object, or an MCP content array [{type:'text', text:'...'}]
    if (typeof result === 'string') return JSON.parse(result);
    if (Array.isArray(result)) {
      const textBlock = result.find((b: any) => b.type === 'text');
      if (textBlock?.text) return JSON.parse(textBlock.text);
    }
    if (typeof result === 'object') return result as EditProposal;
  } catch {}
  return null;
}

/** Get server URL and auth token (works in both Electron renderer and overlay webview) */
function getServerConfig(): { url: string; token: string | null } {
  // Overlay webview: loaded from http://localhost:PORT/...?token=...
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
    const params = new URLSearchParams(window.location.search);
    return { url: window.location.origin, token: params.get('token') };
  }
  // Electron renderer: use the global server URL set during startup
  return {
    url: (window as any).__COBUILDING_SERVER_URL__ || 'http://localhost:17224',
    token: (window as any).__COBUILDING_AUTH_TOKEN__ || null,
  };
}

function authHeaders(): Record<string, string> {
  const { token } = getServerConfig();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

/** Check if we're in the desktop Electron renderer (has IPC) vs overlay webview (HTTP only) */
const hasIPC = typeof (window as any).editStatesAPI !== 'undefined';

async function applyEdit(toolCallId: string, proposal: EditProposal): Promise<{ success: boolean; error?: string; replacementsCount?: number }> {
  const payload = {
    toolCallId,
    document_path: proposal.document_path,
    search_text: proposal.search_text,
    replacement_text: proposal.replacement_text,
    replace_scope: proposal.replace_scope || 'first',
    match_case: proposal.match_case ?? true,
  };
  if (hasIPC) {
    return (window as any).editStatesAPI.applyEdit(payload);
  }
  const { url } = getServerConfig();
  const res = await fetch(`${url}/api/cobuilding/apply-edit`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function setEditState(toolCallId: string, state: string): Promise<void> {
  if (hasIPC) {
    (window as any).editStatesAPI.setState(toolCallId, state);
    return;
  }
  const { url } = getServerConfig();
  fetch(`${url}/api/cobuilding/edit-state`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ toolCallId, state }),
  }).catch(() => {});
}

async function fetchEditStates(): Promise<Record<string, string>> {
  if (hasIPC) {
    return (window as any).editStatesAPI.getAll();
  }
  const { url } = getServerConfig();
  try {
    const res = await fetch(`${url}/api/cobuilding/edit-states`, { headers: authHeaders() });
    if (res.ok) return res.json();
  } catch {}
  return {};
}

// ─── Module-level batch registry ─────────────────────────────────
// Works across ToolGroups since cards may be separated by text.

type BatchAction = 'approve-all' | 'deny-all';
type BatchListener = (action: BatchAction, applyOrder?: string[]) => void;

interface PendingEntry { offset?: number; searchLen?: number; }
const pendingCards = new Map<string, PendingEntry>();
const batchListeners = new Set<BatchListener>();
const countListeners = new Set<() => void>();

function registerPending(id: string, entry?: PendingEntry) {
  pendingCards.set(id, entry ?? {});
  countListeners.forEach(l => l());
}
function unregisterPending(id: string) {
  pendingCards.delete(id);
  countListeners.forEach(l => l());
}

/** Check if two proposals overlap based on their document offsets. */
function proposalsOverlap(a: PendingEntry, b: PendingEntry): boolean {
  if (typeof a.offset !== 'number' || typeof b.offset !== 'number') return false;
  if (typeof a.searchLen !== 'number' || typeof b.searchLen !== 'number') return false;
  const aEnd = a.offset + a.searchLen;
  const bEnd = b.offset + b.searchLen;
  return a.offset < bEnd && b.offset < aEnd;
}

function emitBatch(action: BatchAction) {
  if (action === 'approve-all') {
    // Sort by offset descending (bottom-to-top) so earlier edits don't
    // shift positions of later ones. Cards without offsets go first
    // (they'll be applied without position guarantees).
    const sorted = [...pendingCards.entries()]
      .sort(([, a], [, b]) => {
        if (typeof a.offset !== 'number' && typeof b.offset !== 'number') return 0;
        if (typeof a.offset !== 'number') return -1;
        if (typeof b.offset !== 'number') return 1;
        return b.offset - a.offset;
      })
      .map(([id]) => id);
    batchListeners.forEach(l => l(action, sorted));
  } else {
    batchListeners.forEach(l => l(action));
  }
}

// ─── Module-level overlap-retry registry ─────────────────────────
// When one apply succeeds, sibling cards that previously failed and whose
// search text overlaps with the just-applied edit auto-retry once. Common
// cause for the original failure: the prior apply left track-change markup
// in the same paragraph, which breaks Word's find for sibling edits in
// that area. After the first apply lands, Word's revision state has
// settled and the second attempt often goes through.

type AppliedEvent = {
  toolCallId: string;
  searchText: string;
  replacementText: string;
};
type AppliedListener = (e: AppliedEvent) => void;

const appliedListeners = new Set<AppliedListener>();
const appliedEdits = new Map<string, PendingEntry>();

/** Check if this proposal overlaps with any already-applied edit. */
function isSuperseded(entry: PendingEntry): boolean {
  for (const applied of appliedEdits.values()) {
    if (proposalsOverlap(entry, applied)) return true;
  }
  return false;
}
/** Per-card auto-retry budget. Capped at 1 so we never loop indefinitely. */
const overlapRetriesUsed = new Map<string, number>();

function emitApplied(e: AppliedEvent) {
  appliedListeners.forEach(l => l(e));
}

/**
 * Heuristic substring overlap. Returns true when the two strings share a
 * common substring of at least `minLen` chars (case-insensitive). Used to
 * decide whether the just-applied edit modified a region this card was
 * searching against — i.e. whether retrying makes sense.
 */
function shareSubstring(a: string, b: string, minLen = 20): boolean {
  if (!a || !b || a.length < minLen || b.length < minLen) return false;
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  for (let i = 0; i + minLen <= aLower.length; i++) {
    if (bLower.includes(aLower.substring(i, i + minLen))) return true;
  }
  return false;
}

// ─── Individual suggestion card ──────────────────────────────────

type CardState = 'pending' | 'applying' | 'applied' | 'denied';

const FindAndReplaceSuggestionImpl = ({
  toolCallId,
  args,
  result,
  status,
}: any) => {
  const [cardState, setCardState] = useState<CardState>('pending');
  const [error, setError] = useState<string | null>(null);
  const [showBatchHeader, setShowBatchHeader] = useState(false);
  // Mirror the batch-registry size into local state so re-renders fire when
  // sibling cards register/unregister even if `showBatchHeader` is unchanged.
  // (setShowBatchHeader(true)→setShowBatchHeader(true) is a React no-op, so
  // reading `pendingCards.size` directly in render would otherwise stay stale.)
  const [batchCount, setBatchCount] = useState(0);
  const [copied, setCopied] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);

  // Poll server for edit state changes (syncs overlay ↔ desktop)
  useEffect(() => {
    if (!toolCallId) return;
    let cancelled = false;
    const check = () => {
      fetchEditStates().then(states => {
        if (cancelled) return;
        const persisted = states[toolCallId] as CardState | undefined;
        if (persisted && persisted !== cardState) setCardState(persisted);
      });
    };
    check();
    const timer = setInterval(check, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [toolCallId]); // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = parseResult(result);
  const searchText = parsed?.search_text ?? (args as any)?.search_text ?? '';
  const replacementText = parsed?.replacement_text ?? (args as any)?.replacement_text ?? '';
  const isRunning = status?.type === 'running';
  const isProposal = parsed?.proposed === true;

  // Register/unregister with module-level batch registry
  useEffect(() => {
    if (isProposal && cardState === 'pending') {
      registerPending(toolCallId, {
        offset: parsed?.doc_offset,
        searchLen: searchText.length || undefined,
      });
      return () => unregisterPending(toolCallId);
    }
  }, [isProposal, cardState, toolCallId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Show batch header on the first pending card
  useEffect(() => {
    const update = () => {
      const firstPending = [...pendingCards.keys()][0];
      setShowBatchHeader(firstPending === toolCallId && pendingCards.size > 1);
      setBatchCount(pendingCards.size);
    };
    countListeners.add(update);
    update();
    return () => { countListeners.delete(update); };
  }, [toolCallId]);

  const handleApproveRef = useRef<() => void>(() => {});
  const handleDenyRef = useRef<() => void>(() => {});

  // Listen for batch actions
  useEffect(() => {
    if (!isProposal || cardState !== 'pending') return;
    const listener: BatchListener = (action, applyOrder) => {
      if (action === 'deny-all') { handleDenyRef.current(); return; }
      if (action === 'approve-all') {
        if (applyOrder) {
          // Stagger approvals bottom-to-top so each edit lands before
          // the next one starts, preventing position drift.
          const idx = applyOrder.indexOf(toolCallId);
          if (idx >= 0) {
            setTimeout(() => handleApproveRef.current(), idx * 500);
          } else {
            handleApproveRef.current();
          }
        } else {
          handleApproveRef.current();
        }
      }
    };
    batchListeners.add(listener);
    return () => { batchListeners.delete(listener); };
  }, [isProposal, cardState, toolCallId]);

  // Listen for sibling-apply success. If our search text overlaps with a
  // just-applied sibling and we previously failed, retry once — Word's
  // find may have stabilized after the prior edit landed.
  useEffect(() => {
    if (!isProposal || !parsed) return;
    const listener: AppliedListener = (e) => {
      if (e.toolCallId === toolCallId) return; // never react to our own apply
      if (cardState !== 'pending' || !error) return; // only retry prior failures
      const thisSearch = parsed.search_text || '';
      const overlaps =
        shareSubstring(thisSearch, e.searchText) ||
        shareSubstring(thisSearch, e.replacementText);
      if (!overlaps) return;
      if ((overlapRetriesUsed.get(toolCallId) ?? 0) >= 1) return;
      overlapRetriesUsed.set(toolCallId, 1);
      // Small delay to let Word settle its revision state before retrying.
      setTimeout(() => handleApproveRef.current?.(), 250);
    };
    appliedListeners.add(listener);
    return () => { appliedListeners.delete(listener); };
  }, [isProposal, parsed, toolCallId, cardState, error]);

  const handleApprove = useCallback(async () => {
    if (!parsed) return;

    // Check if an overlapping edit was already applied — if so, this
    // edit's search text likely no longer exists in the document.
    const myEntry: PendingEntry = {
      offset: parsed.doc_offset,
      searchLen: (parsed.search_text || '').length || undefined,
    };
    if (isSuperseded(myEntry)) {
      setError('Superseded by an earlier edit in the same passage. Use Copy to apply manually if needed.');
      setCardState('denied');
      setEditState(toolCallId, 'denied');
      unregisterPending(toolCallId);
      return;
    }

    setError(null);
    setCardState('applying');
    unregisterPending(toolCallId);
    try {
      const res = await applyEdit(toolCallId, parsed);
      // Require both success AND a non-zero replacement count. Some failure
      // modes return success=true with count=0 (e.g. silent host-app misses);
      // gating on count prevents the green "Applied" card from appearing when
      // nothing actually landed in the document.
      const didApply = res.success && (res.replacementsCount ?? 0) > 0;
      if (didApply) {
        setCardState('applied');
        // Record this edit so future overlapping edits are superseded.
        appliedEdits.set(toolCallId, myEntry);
        // Broadcast to sibling cards so any that failed in the same
        // paragraph can auto-retry now that this revision has landed.
        emitApplied({
          toolCallId,
          searchText: parsed.search_text || '',
          replacementText: parsed.replacement_text || '',
        });
      } else {
        setError(res.error || (res.success ? 'No matches were replaced' : 'Unknown error'));
        setCardState('pending');
        registerPending(toolCallId, myEntry);
      }
    } catch (err) {
      setError(String(err));
      setCardState('pending');
      registerPending(toolCallId);
    }
  }, [parsed, toolCallId]);

  const handleDeny = useCallback(() => {
    setCardState('denied');
    setEditState(toolCallId, 'denied');
    unregisterPending(toolCallId);
  }, [toolCallId]);

  const handleCopy = useCallback(async () => {
    // Copy the proposed replacement as plain text. When apply fails because
    // of ligatures, smart-quotes, or other glyph mismatches, the user can
    // paste this into Word manually.
    const text = replacementText || '';
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Surface clipboard denial in the same error slot.
      setError('Could not copy to clipboard');
    }
  }, [replacementText]);

  // Keep refs in sync so batch listeners call the latest version
  handleApproveRef.current = handleApprove;
  handleDenyRef.current = handleDeny;

  // --- Running (tool still executing) ---
  if (isRunning) {
    return (
      <div className="suggestionCard suggestionCard--running">
        <div className="suggestionHeader">
          <LoaderIcon size={14} className="suggestionSpinner" />
          <span className="suggestionHeaderText">Proposing edit...</span>
        </div>
      </div>
    );
  }

  // --- Denied / dismissed ---
  // Collapsed by default but expandable: clicking Dismiss is easy to do by
  // accident, and when expanded we show the full proposal actions (Accept /
  // Copy / Dismiss) so the user can recover or re-confirm.
  if (cardState === 'denied') {
    const handleAcceptFromDismissed = async () => {
      setDetailsExpanded(false);
      setError(null);
      // Clear the persisted denied state before approving so the polling
      // doesn't briefly flip us back to denied while applyEdit is in flight.
      setEditState(toolCallId, '');
      registerPending(toolCallId);
      setCardState('pending');
      // handleApprove reads cardState via closure, but its internal flow only
      // checks `parsed`; calling it directly works.
      handleApproveRef.current();
    };
    const handleDismissAgain = () => {
      setDetailsExpanded(false);
      // Already in 'denied' state — just re-persist and collapse.
      setEditState(toolCallId, 'denied');
    };
    return (
      <div className="suggestionCard suggestionCard--skipped">
        <button
          type="button"
          className="suggestionHeader suggestionHeader--toggle"
          onClick={() => setDetailsExpanded((v) => !v)}
          aria-expanded={detailsExpanded}
        >
          {detailsExpanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
          <MinusCircleIcon size={14} />
          <span className="suggestionHeaderText">Dismissed</span>
        </button>
        {detailsExpanded && (
          <>
            <div className="suggestionDiff">
              <del className="suggestionDiffDel">{searchText}</del>
              <ins className="suggestionDiffIns">{replacementText}</ins>
            </div>
            <div className="suggestionActions">
              <button className="suggestionBtn suggestionBtn--approve" onClick={handleAcceptFromDismissed}>
                Accept
              </button>
              <button
                className="suggestionBtn suggestionBtn--copy"
                onClick={handleCopy}
                title="Copy the proposed text"
              >
                {copied ? (
                  <><CheckIcon size={12} /> Copied</>
                ) : (
                  <><CopyIcon size={12} /> Copy</>
                )}
              </button>
              <button className="suggestionBtn suggestionBtn--deny" onClick={handleDismissAgain}>
                Dismiss
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  // --- Applying ---
  if (cardState === 'applying') {
    return (
      <div className="suggestionCard suggestionCard--running">
        <div className="suggestionHeader">
          <LoaderIcon size={14} className="suggestionSpinner" />
          <span className="suggestionHeaderText">Applying edit...</span>
        </div>
      </div>
    );
  }

  // --- Applied ---
  // Collapsed by default. Expand to review the diff and copy the replacement
  // text if needed (e.g. to paste somewhere else, or to verify what landed).
  if (cardState === 'applied') {
    return (
      <div className="suggestionCard suggestionCard--applied">
        <button
          type="button"
          className="suggestionHeader suggestionHeader--toggle"
          onClick={() => setDetailsExpanded((v) => !v)}
          aria-expanded={detailsExpanded}
        >
          {detailsExpanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
          <CheckIcon size={14} />
          <span className="suggestionHeaderText">Applied edit</span>
        </button>
        {detailsExpanded && (
          <>
            <div className="suggestionDiff">
              <del className="suggestionDiffDel">{searchText}</del>
              <ins className="suggestionDiffIns">{replacementText}</ins>
            </div>
            <div className="suggestionActions">
              <button
                className="suggestionBtn suggestionBtn--copy"
                onClick={handleCopy}
                title="Copy the applied text"
              >
                {copied ? (
                  <><CheckIcon size={12} /> Copied</>
                ) : (
                  <><CopyIcon size={12} /> Copy</>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  // --- Proposal: show diff with approve/deny ---
  if (isProposal && searchText) {
    return (
      <>
        {showBatchHeader && (
          <div className="suggestionBatchHeader">
            <span className="suggestionBatchCount">
              {batchCount} suggestions
            </span>
            <div className="suggestionBatchActions">
              <button className="suggestionBtn suggestionBtn--approve" onClick={() => emitBatch('approve-all')}>
                Approve all
              </button>
              <button className="suggestionBtn suggestionBtn--deny" onClick={() => emitBatch('deny-all')}>
                Dismiss all
              </button>
            </div>
          </div>
        )}
        <div className="suggestionCard">
          <div className="suggestionDiff">
            <del className="suggestionDiffDel">{searchText}</del>
            <ins className="suggestionDiffIns">{replacementText}</ins>
          </div>
          {error && (
            <div className="suggestionError">
              <XCircleIcon size={14} />
              <span>Failed: {error}</span>
            </div>
          )}
          <div className="suggestionActions">
            <button className="suggestionBtn suggestionBtn--approve" onClick={handleApprove}>
              {error ? 'Retry' : 'Approve'}
            </button>
            <button
              className="suggestionBtn suggestionBtn--copy"
              onClick={handleCopy}
              title="Copy the proposed text so you can paste it into the document manually"
            >
              {copied ? (
                <><CheckIcon size={12} /> Copied</>
              ) : (
                <><CopyIcon size={12} /> Copy</>
              )}
            </button>
            <button
              className="suggestionBtn suggestionBtn--deny"
              onClick={handleDeny}
              title="Dismiss this proposal — use this if you applied it manually or don't want it"
            >
              Dismiss
            </button>
          </div>
        </div>
      </>
    );
  }

  // --- No data yet ---
  return (
    <div className="suggestionCard suggestionCard--running">
      <div className="suggestionHeader">
        <LoaderIcon size={14} className="suggestionSpinner" />
        <span className="suggestionHeaderText">Processing...</span>
      </div>
    </div>
  );
};

export const FindAndReplaceSuggestion = memo(FindAndReplaceSuggestionImpl);
FindAndReplaceSuggestion.displayName = 'FindAndReplaceSuggestion';
