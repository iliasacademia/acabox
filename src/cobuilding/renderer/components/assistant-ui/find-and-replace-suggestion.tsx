import React, { createContext, memo, useContext, useCallback, useEffect, useRef, useState } from 'react';
import { CheckIcon, LoaderIcon, XCircleIcon, MinusCircleIcon } from 'lucide-react';

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
  search_text?: string;
  replacement_text?: string;
  replace_scope?: string;
  match_case?: boolean;
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

async function applyEdit(toolCallId: string, proposal: EditProposal): Promise<{ success: boolean; error?: string; replacementsCount?: number }> {
  const { url } = getServerConfig();
  const res = await fetch(`${url}/api/cobuilding/apply-edit`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      toolCallId,
      search_text: proposal.search_text,
      replacement_text: proposal.replacement_text,
      replace_scope: proposal.replace_scope || 'first',
      match_case: proposal.match_case ?? true,
    }),
  });
  return res.json();
}

async function setEditState(toolCallId: string, state: string): Promise<void> {
  const { url } = getServerConfig();
  fetch(`${url}/api/cobuilding/edit-state`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ toolCallId, state }),
  }).catch(() => {});
}

async function fetchEditStates(): Promise<Record<string, string>> {
  const { url } = getServerConfig();
  try {
    const res = await fetch(`${url}/api/cobuilding/edit-states`, { headers: authHeaders() });
    if (res.ok) return res.json();
  } catch {}
  return {};
}

// ─── Batch action context ────────────────────────────────────────

type BatchAction = 'approve-all' | 'deny-all' | null;
type BatchListener = (action: BatchAction) => void;

interface SuggestionGroupContextValue {
  registerPending: (id: string) => void;
  unregisterPending: (id: string) => void;
  getPendingCount: () => number;
  subscribeBatch: (listener: BatchListener) => () => void;
  emitBatch: (action: BatchAction) => void;
}

const SuggestionGroupContext = createContext<SuggestionGroupContextValue | null>(null);

export function SuggestionGroupProvider({ children }: { children: React.ReactNode }) {
  const pendingRef = useRef(new Set<string>());
  const listenersRef = useRef(new Set<BatchListener>());

  const ctx: SuggestionGroupContextValue = {
    registerPending: (id) => { pendingRef.current.add(id); },
    unregisterPending: (id) => { pendingRef.current.delete(id); },
    getPendingCount: () => pendingRef.current.size,
    subscribeBatch: (listener) => {
      listenersRef.current.add(listener);
      return () => { listenersRef.current.delete(listener); };
    },
    emitBatch: (action) => {
      for (const l of listenersRef.current) l(action);
    },
  };

  return (
    <SuggestionGroupContext.Provider value={ctx}>
      {children}
    </SuggestionGroupContext.Provider>
  );
}

// ─── Batch header ────────────────────────────────────────────────

export const SuggestionBatchHeader: React.FC = () => {
  const group = useContext(SuggestionGroupContext);
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => forceUpdate(n => n + 1), 500);
    return () => clearInterval(timer);
  }, []);

  if (!group) return null;
  const count = group.getPendingCount();
  if (count === 0) return null;

  return (
    <div className="suggestionBatchHeader">
      <span className="suggestionBatchCount">
        {count} {count === 1 ? 'suggestion' : 'suggestions'}
      </span>
      <div className="suggestionBatchActions">
        <button className="suggestionBtn suggestionBtn--approve" onClick={() => group.emitBatch('approve-all')}>
          Approve all
        </button>
        <button className="suggestionBtn suggestionBtn--deny" onClick={() => group.emitBatch('deny-all')}>
          Deny all
        </button>
      </div>
    </div>
  );
};

// ─── Individual suggestion card ──────────────────────────────────

type CardState = 'pending' | 'applying' | 'applied' | 'denied' | 'error';

const FindAndReplaceSuggestionImpl = ({
  toolCallId,
  args,
  result,
  status,
}: any) => {
  const group = useContext(SuggestionGroupContext);
  const [cardState, setCardState] = useState<CardState>('pending');
  const [error, setError] = useState<string | null>(null);

  // Load persisted state from server on mount
  useEffect(() => {
    if (!toolCallId) return;
    fetchEditStates().then(states => {
      const persisted = states[toolCallId] as CardState | undefined;
      if (persisted) setCardState(persisted);
    });
  }, [toolCallId]);

  const parsed = parseResult(result);
  const searchText = parsed?.search_text ?? (args as any)?.search_text ?? '';
  const replacementText = parsed?.replacement_text ?? (args as any)?.replacement_text ?? '';
  const isRunning = status?.type === 'running';
  const isProposal = parsed?.proposed === true;

  // Register with batch group when pending
  useEffect(() => {
    if (isProposal && cardState === 'pending' && group) {
      group.registerPending(toolCallId);
      return () => group.unregisterPending(toolCallId);
    }
  }, [isProposal, cardState, toolCallId, group]);

  const handleApproveRef = useRef<() => void>(() => {});
  const handleDenyRef = useRef<() => void>(() => {});

  // Listen for batch actions
  useEffect(() => {
    if (!isProposal || cardState !== 'pending' || !group) return;
    return group.subscribeBatch((action) => {
      if (action === 'approve-all') handleApproveRef.current();
      if (action === 'deny-all') handleDenyRef.current();
    });
  }, [isProposal, cardState, group]);

  const handleApprove = useCallback(async () => {
    if (!parsed) return;
    setCardState('applying');
    if (group) group.unregisterPending(toolCallId);
    try {
      const res = await applyEdit(toolCallId, parsed);
      if (res.success) {
        setCardState('applied');
      } else {
        setError(res.error || 'Unknown error');
        setCardState('error');
      }
    } catch (err) {
      setError(String(err));
      setCardState('error');
    }
  }, [parsed, toolCallId, group]);

  const handleDeny = useCallback(() => {
    setCardState('denied');
    setEditState(toolCallId, 'denied');
    if (group) group.unregisterPending(toolCallId);
  }, [toolCallId, group]);

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

  // --- Denied ---
  if (cardState === 'denied') {
    return (
      <div className="suggestionCard suggestionCard--skipped">
        <div className="suggestionHeader">
          <MinusCircleIcon size={14} />
          <span className="suggestionHeaderText">Skipped</span>
        </div>
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
  if (cardState === 'applied') {
    return (
      <div className="suggestionCard suggestionCard--applied">
        <div className="suggestionHeader">
          <CheckIcon size={14} />
          <span className="suggestionHeaderText">Applied edit</span>
        </div>
        <div className="suggestionDiff">
          <del className="suggestionDiffDel">{searchText}</del>
          <ins className="suggestionDiffIns">{replacementText}</ins>
        </div>
      </div>
    );
  }

  // --- Error ---
  if (cardState === 'error') {
    return (
      <div className="suggestionCard suggestionCard--error">
        <div className="suggestionHeader">
          <XCircleIcon size={14} />
          <span className="suggestionHeaderText">Failed: {error}</span>
        </div>
      </div>
    );
  }

  // --- Proposal: show diff with approve/deny ---
  if (isProposal && searchText) {
    return (
      <div className="suggestionCard">
        <div className="suggestionDiff">
          <del className="suggestionDiffDel">{searchText}</del>
          <ins className="suggestionDiffIns">{replacementText}</ins>
        </div>
        <div className="suggestionActions">
          <button className="suggestionBtn suggestionBtn--approve" onClick={handleApprove}>
            Approve
          </button>
          <button className="suggestionBtn suggestionBtn--deny" onClick={handleDeny}>
            Deny
          </button>
        </div>
      </div>
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
