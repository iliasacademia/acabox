import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { FileTextIcon } from 'lucide-react';
import { onVisibilityChanged, cacheFullStoryConfig } from './utils/fullstory';
import {
  ConversationItem,
  styles,
  serverUrl,
  tokenParam,
  widParam,
  postBridge,
  getV4FocusedWid,
  navigateToPage,
  CloseIcon,
  WidthToggleIcon,
  DockRightIcon,
  UndockIcon,
  POPUP_HEIGHT_ENABLE_FEEDBACK,
  POPUP_HEIGHT_UNSAVED_DOCUMENT,
  POPUP_HEIGHT_PER_CONVERSATION,
} from './popupV2/shared';
import { useWordPollWebSocket } from './popupV2/useWordPollWebSocket';
import { ConversationListView, NotLinkedView, WorkspaceSessionsView, WorkspaceConversationView, effectiveDocDisplayName } from './popupV2/MenuView';
import {
  findAutoOpenCandidate,
  shouldAutoOpenFreshSession,
  shouldClearActiveOnDocChange,
  isActiveSessionStaleForDoc,
} from './popupV2/sessionLogic';


console.log('[AcademiaNotificationsPopupV2] Initializing...');

// Base height: title bar + section header + "View all" row + padding
const POPUP_HEIGHT_CONVERSATIONS_BASE = 140;

const AcademiaNotificationsPopupV2: React.FC = () => {
  console.log('[AcademiaNotificationsPopupV2] Component mounting');

  // State for conversations (fetched from list_conversations API)
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  // State for project file info
  const [projectId, setProjectId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isEnableFeedback, setIsEnableFeedback] = useState(false);
  const [isUnsavedDocument, setIsUnsavedDocument] = useState(false);
  // Cobuilding workspace state
  const [isInWorkspace, setIsInWorkspace] = useState(false);
  const [workspaceSessions, setWorkspaceSessions] = useState<Array<{ id: string; title: string; created_at: string }>>([]);
  // Display name for the active document, server-supplied for synthetic-scheme
  // hosts (`gdocs://`, `applenotes://`) where the path itself is opaque.
  const [activeDocumentDisplayName, setActiveDocumentDisplayName] = useState<string | null>(null);
  const [activeSession, setActiveSessionRaw] = useState<{ id: string; title: string } | null>(() => {
    try {
      const saved = localStorage.getItem('overlay_active_session');
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  });
  const setActiveSession = (session: { id: string; title: string } | null) => {
    setActiveSessionRaw(session);
    if (session) {
      localStorage.setItem('overlay_active_session', JSON.stringify(session));
    } else {
      localStorage.removeItem('overlay_active_session');
    }
  };

  // Track previous height/width to avoid unnecessary resize calls
  const previousHeightRef = useRef<number>(0);
  const previousWidthRef = useRef<number>(0);

  // Title bar drag state
  const DRAG_THRESHOLD = 3;
  const titleBarAccumulatedOffsetRef = useRef({ dx: 0, dy: 0 });
  const titleBarDragStateRef = useRef<{
    startScreenX: number;
    startScreenY: number;
    baseOffsetX: number;
    baseOffsetY: number;
    didDrag: boolean;
    rafId: number | null;
  } | null>(null);
  const [isTitleBarDragging, setIsTitleBarDragging] = useState(false);

  // Resize state
  const accumulatedSizeRef = useRef<{ width: number; height: number } | null>(null);
  const resizeStateRef = useRef<{
    startScreenX: number;
    startScreenY: number;
    baseWidth: number;
    baseHeight: number;
    rafId: number | null;
  } | null>(null);

  // Width toggle state
  const [isWide, setIsWide] = useState(false);

  // Dock-to-right state — persisted per document path in localStorage
  const DOCK_PREF_KEY = 'academia_popup_docked:';
  const [isDocked, setIsDocked] = useState(false);
  const narrowWidthRef = useRef<number>(window.innerWidth);
  const WIDE_WIDTH = 700;
  const sizeAnimRef = useRef<number | null>(null);
  const prevDocPathRef = useRef<string | null>(null);
  const prevIsDockedActiveRef = useRef<boolean | undefined>(undefined);
  // Session IDs we've already auto-opened for the current docPath. Stops us
  // re-yanking the user back into a session if they explicitly went back to
  // the list view while the session is still inside our freshness window.
  // Persisted in localStorage so that hide/show cycles of the overlay
  // window don't reset the set — without this, a session the overlay
  // already moved past becomes "fresh again" on remount and the auto-open
  // logic re-fires, switching the user out of whatever they're typing in.
  const autoOpenedSessionIdsRef = useRef<Set<string>>(new Set());
  const autoOpenedStorageKey = (path: string | null): string =>
    `overlay_auto_opened_sessions:${path ?? '__none__'}`;
  const loadAutoOpenedFromStorage = (path: string | null): Set<string> => {
    try {
      const raw = localStorage.getItem(autoOpenedStorageKey(path));
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? new Set(arr.filter((s) => typeof s === 'string')) : new Set();
    } catch { return new Set(); }
  };
  const persistAutoOpened = (path: string | null, set: Set<string>) => {
    try {
      // Keep this bounded — the set only matters as a deduper, and the
      // most-recent sessions are the only ones that can still be inside
      // the 10s freshness window.
      const arr = Array.from(set).slice(-50);
      localStorage.setItem(autoOpenedStorageKey(path), JSON.stringify(arr));
    } catch { /* quota / serialization — non-fatal */ }
  };
  // Kickoff prompt the desktop side stashed for this docx (e.g. Writing-Agent
  // Use button or briefing card click). When non-null, the active conversation
  // view auto-sends it on mount so the overlay's chat adapter owns the SSE
  // stream and live progress renders without flicker. Cleared after fire.
  const [pendingKickoffPrompt, setPendingKickoffPrompt] = useState<string | null>(null);
  // Last kickoff id we acted on. The server doesn't consume the prompt
  // (avoids a race with WS connection ordering); we ignore subsequent polls
  // that carry the same id. Dedup by id (not prompt text) so a repeat click
  // with identical prompt text still forces a new chat.
  const lastFiredKickoffRef = useRef<string | null>(null);

  // Animate popup size (width and/or height) over ~250ms with ease-out
  const animateSize = (fromWidth: number, toWidth: number, fromHeight: number, toHeight: number, onDone?: () => void) => {
    if (sizeAnimRef.current !== null) cancelAnimationFrame(sizeAnimRef.current);
    if (Math.round(fromWidth) === Math.round(toWidth) && Math.round(fromHeight) === Math.round(toHeight)) {
      onDone?.();
      return;
    }
    const duration = 250;
    const startTime = performance.now();
    const step = (now: number) => {
      const t = Math.min((now - startTime) / duration, 1);
      const eased = 1 - (1 - t) * (1 - t); // ease-out quad
      const w = Math.round(fromWidth + (toWidth - fromWidth) * eased);
      const h = Math.round(fromHeight + (toHeight - fromHeight) * eased);
      postBridge('setPopupSize', { width: w, height: h });
      if (t < 1) {
        sizeAnimRef.current = requestAnimationFrame(step);
      } else {
        sizeAnimRef.current = null;
        accumulatedSizeRef.current = { width: toWidth, height: toHeight };
        onDone?.();
      }
    };
    sizeAnimRef.current = requestAnimationFrame(step);
  };

  // WebSocket-based polling
  const pollData = useWordPollWebSocket(widParam, tokenParam, serverUrl);
  const effectiveWid = getV4FocusedWid();
  const docPath = pollData?.activeDocumentPath ?? null;

  // When the active document changes from one doc to a DIFFERENT doc, close
  // any open conversation and return to the session list. The previous chat
  // is scoped to its original document and shouldn't keep accepting messages
  // in the context of a different file.
  //
  // Critical: do NOT clear when docPath transitions to null. That happens on
  // every Cmd+Tab away from Word (focus moves to a non-doc app, polling
  // reports activeDocumentPath=null) and clearing here causes the overlay
  // to lose its active session every time the user briefly switches apps.
  useEffect(() => {
    if (shouldClearActiveOnDocChange(prevDocPathRef.current, docPath)) {
      setActiveSession(null);
    }
  }, [docPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore per-document dock preference whenever the active document changes.
  useEffect(() => {
    if (!docPath) return;
    const pref = localStorage.getItem(DOCK_PREF_KEY + docPath) === 'true';
    setIsDocked(pref);
    if (pref || prevDocPathRef.current !== null) {
      postBridge('setDockRight', { docked: pref });
    }
    prevDocPathRef.current = docPath;
    // Hydrate auto-open tracking for the new doc from localStorage. Fresh
    // sessions for a different doc shouldn't be considered already-handled,
    // but sessions we already auto-opened for THIS doc on a prior render
    // (e.g. before a popup hide/show cycle) must stay deduped.
    autoOpenedSessionIdsRef.current = loadAutoOpenedFromStorage(docPath);
  }, [docPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // When Word is maximized the overlay falls back to floating (isDockedActive = false).
  // Detect the true→false transition and reset isDocked so one click re-docks.
  useEffect(() => {
    const curr = pollData?.isDockedActive;
    const prev = prevIsDockedActiveRef.current;
    prevIsDockedActiveRef.current = curr;
    if (prev === true && curr === false) {
      setIsDocked(false);
    }
  }, [pollData?.isDockedActive]); // eslint-disable-line react-hooks/exhaustive-deps

  // React to pollData changes
  useEffect(() => {
    console.log('[AcademiaNotificationsPopupV2] pollData changed:', pollData);
    if (!pollData) return;

    if (pollData.fullStoryConfig) cacheFullStoryConfig(pollData.fullStoryConfig);
    onVisibilityChanged('popup', pollData.shouldShowPopupV2 ?? false);

    setIsEnableFeedback(pollData.isEnableFeedback ?? false);
    setIsUnsavedDocument(pollData.isUnsavedDocument ?? false);
    setIsInWorkspace(pollData.isInWorkspace ?? false);
    setWorkspaceSessions(pollData.workspaceSessions ?? []);
    setActiveDocumentDisplayName(pollData.activeDocumentDisplayName ?? null);

    if (isActiveSessionStaleForDoc(activeSession?.id ?? null, pollData.workspaceSessions ?? [])) {
      setActiveSession(null);
    }

    // Kickoff set by the desktop side (briefing card or Tools-page tile). The
    // server sends it on every pollData while it's set; we dedup client-side
    // by kickoff id so repeat clicks each produce a fresh chat. If the
    // kickoff carries a prompt, auto-send it; otherwise just open an empty
    // new chat (Tools-page flow).
    const incomingPrompt = pollData.pendingKickoffPrompt;
    const incomingId = pollData.pendingKickoffId;
    let kickoffHandled = false;
    if (incomingId && incomingId !== lastFiredKickoffRef.current) {
      lastFiredKickoffRef.current = incomingId;
      kickoffHandled = true;
      const newSessionId = crypto.randomUUID();
      console.log('[AcademiaNotificationsPopupV2] Kickoff', incomingId, 'arrived; opening new chat', newSessionId, incomingPrompt ? '(with prompt)' : '(empty)');
      if (incomingPrompt) setPendingKickoffPrompt(incomingPrompt);
      setActiveSession({ id: newSessionId, title: 'New Conversation' });
      postBridge('clearKickoff', { kickoffId: incomingId }).catch(() => {});
    }

    // Auto-open a brand-new session for this document. Triggered when the
    // desktop side starts a Writing-Agent chat scoped to the active docx:
    // a session shows up that's <10s old and we haven't already auto-opened
    // it. Critical: only fires when there's no activeSession — once the
    // user is in a thread, focus changes (Cmd+Tab away/back, Word
    // minimize/restore) must not switch them to a different session. The
    // earlier "override any current activeSession" behavior caused the
    // overlay to drift onto whichever session the WebSocket poll surfaced
    // most recently, even mid-conversation.
    // Skip when a kickoff was just handled — the kickoff already created a
    // fresh session and auto-open would overwrite it with an existing one.
    const sessions = pollData.workspaceSessions ?? [];
    const NEW_SESSION_MAX_AGE_MS = 10_000;
    const alreadyAutoOpened = autoOpenedSessionIdsRef.current;
    const fresh = findAutoOpenCandidate(sessions, alreadyAutoOpened, Date.now(), NEW_SESSION_MAX_AGE_MS);
    if (!kickoffHandled && shouldAutoOpenFreshSession(activeSession?.id ?? null, fresh)) {
      console.log('[AcademiaNotificationsPopupV2] Auto-opening fresh session:', fresh!.id);
      setActiveSession({ id: fresh!.id, title: fresh!.title });
      alreadyAutoOpened.add(fresh!.id);
      persistAutoOpened(docPath, alreadyAutoOpened);
    } else if (fresh) {
      // Mark fresh sessions as "seen" even when we don't open them (because
      // the user already has an active session) — so when they later go
      // back to the list and a still-fresh session is sitting there,
      // returning to the list doesn't immediately yank them into it.
      alreadyAutoOpened.add(fresh.id);
      persistAutoOpened(docPath, alreadyAutoOpened);
    }

    if (!pollData.shouldShowPopupV2 && !pollData.isEnableFeedback && !pollData.isInWorkspace) {
      console.log(`[AcademiaNotificationsPopupV2] Hiding popup. Active path: ${pollData.activeDocumentPath || 'none'}`);
      if (sizeAnimRef.current !== null) {
        cancelAnimationFrame(sizeAnimRef.current);
        sizeAnimRef.current = null;
      }
      previousHeightRef.current = 0;
      previousWidthRef.current = 0;
      accumulatedSizeRef.current = null;
      postBridge('closeWindow', {}).catch(() => {});
      return;
    }

    if (pollData.projectId) {
      setProjectId(pollData.projectId);
      setIsLoading(false);
    } else {
      setIsLoading(false);
    }
  }, [pollData]);

  // Fetch conversations when projectId becomes available
  useEffect(() => {
    if (!projectId) return;
    const params = new URLSearchParams({
      offset: '0',
      limit: '5',
      parent_id: projectId.toString(),
      parent_type: 'Project',
    });
    const headers: Record<string, string> = {};
    if (tokenParam) headers['Authorization'] = `Bearer ${tokenParam}`;
    fetch(`${serverUrl}/proxy-api/v0/co_scientist/list_conversations?${params}`, { headers })
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data?.conversations) setConversations(data.conversations); })
      .catch(() => {});
  }, [projectId]);

  // Handle window resizing based on content
  useEffect(() => {
    let height: number;

    if (activeSession || isInWorkspace) {
      // Cobuilding overlay: always use a fixed height regardless of content.
      // The list / conversation scrolls internally; the launcher stays visible below.
      height = 460;
    } else if (isEnableFeedback && isUnsavedDocument) {
      height = POPUP_HEIGHT_UNSAVED_DOCUMENT;
    } else if (isEnableFeedback) {
      height = POPUP_HEIGHT_ENABLE_FEEDBACK;
    } else {
      height = POPUP_HEIGHT_CONVERSATIONS_BASE;
      height += Math.min(conversations.length, 5) * POPUP_HEIGHT_PER_CONVERSATION;
    }

    const width = isWide ? WIDE_WIDTH : narrowWidthRef.current;

    if (height !== previousHeightRef.current || width !== previousWidthRef.current) {
      const isFirstOpen = !previousHeightRef.current || !previousWidthRef.current;
      if (isFirstOpen) {
        postBridge('setPopupSize', { width, height });
        previousHeightRef.current = height;
        previousWidthRef.current = width;
        accumulatedSizeRef.current = { width, height };
      } else {
        animateSize(previousWidthRef.current, width, previousHeightRef.current, height, () => {
          previousHeightRef.current = height;
          previousWidthRef.current = width;
        });
      }
    }
  }, [isEnableFeedback, isUnsavedDocument, conversations, isWide, isInWorkspace, workspaceSessions, activeSession]);

  // Handle clicking a conversation — navigate to it in the main window
  const handleContinueConversation = async (conversation: ConversationItem) => {
    console.log('[AcademiaNotificationsPopupV2] Continue conversation:', conversation.id);
    if (!projectId) return;

    try {
      await navigateToPage({
        page: 'conversation',
        projectId,
        conversationId: conversation.id,
      }, tokenParam);

      onVisibilityChanged('popup', false);
      setIsDocked(false);
      postBridge('closeWindow', {}).catch(() => {});
    } catch (err) {
      console.error('[AcademiaNotificationsPopupV2] Error continuing conversation:', err);
    }
  };

  // Handle clicking a workspace session — show conversation in overlay
  const handleOpenSession = (session: { id: string; title: string; created_at: string }) => {
    console.log('[AcademiaNotificationsPopupV2] Open workspace session:', session.id);
    setActiveSession({ id: session.id, title: session.title });
  };

  const handleBackToSessions = () => {
    setActiveSession(null);
  };

  const handleNewConversation = () => {
    const id = crypto.randomUUID();
    console.log('[AcademiaNotificationsPopupV2] New conversation:', id);
    setActiveSession({ id, title: 'New Conversation' });
  };

  // When the user is in a workspace with no conversations, default the overlay
  // to a blank chat (composer + "Ask about your document" welcome) rather than
  // an empty list. Effectively auto-clicks "+ New" so there's no separate
  // empty-list state for users to land in.
  useEffect(() => {
    if (isInWorkspace && workspaceSessions.length === 0 && !activeSession) {
      const id = crypto.randomUUID();
      console.log('[AcademiaNotificationsPopupV2] Empty workspace — auto-opening blank chat:', id);
      setActiveSession({ id, title: 'New Conversation' });
    }
  }, [isInWorkspace, workspaceSessions.length, activeSession]);

  // Handle toggling popup width
  const handleToggleWidth = () => {
    const newIsWide = !isWide;
    setIsWide(newIsWide);
    const currentWidth = accumulatedSizeRef.current?.width ?? window.innerWidth;
    const targetWidth = newIsWide ? WIDE_WIDTH : narrowWidthRef.current;
    const currentHeight = accumulatedSizeRef.current?.height ?? window.innerHeight;
    animateSize(currentWidth, targetWidth, currentHeight, currentHeight);
  };

  // Handle toggling dock-to-right mode
  const handleToggleDock = () => {
    const newDocked = !isDocked;
    setIsDocked(newDocked);
    if (docPath) {
      localStorage.setItem(DOCK_PREF_KEY + docPath, String(newDocked));
    }
    postBridge('setDockRight', { docked: newDocked });
  };

  const handleClose = async () => {
    console.log('[AcademiaNotificationsPopupV2] Close button clicked');
    try {
      onVisibilityChanged('popup', false);
      setIsDocked(false);
      await postBridge('closeWindow', {});
      console.log('[AcademiaNotificationsPopupV2] Close window request sent');
    } catch (err) {
      console.error('[AcademiaNotificationsPopupV2] Close failed:', err);
    }
  };

  // --- Title bar drag handlers ---
  const handleTitleBarPointerDown = async (e: React.PointerEvent<HTMLDivElement>) => {
    if (isDocked) return; // Dragging is disabled when docked
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    let baseOffsetX = titleBarAccumulatedOffsetRef.current.dx;
    let baseOffsetY = titleBarAccumulatedOffsetRef.current.dy;
    try {
      const res = await fetch(`${serverUrl}/api/drag-offset?wid=${effectiveWid}`, {
        headers: tokenParam ? { Authorization: `Bearer ${tokenParam}` } : {},
      });
      if (res.ok) {
        const offset = await res.json();
        baseOffsetX = offset.dx ?? baseOffsetX;
        baseOffsetY = offset.dy ?? baseOffsetY;
        titleBarAccumulatedOffsetRef.current = { dx: baseOffsetX, dy: baseOffsetY };
      }
    } catch {
      // Fall back to locally tracked offset
    }
    setIsTitleBarDragging(true);
    titleBarDragStateRef.current = {
      startScreenX: e.screenX,
      startScreenY: e.screenY,
      baseOffsetX,
      baseOffsetY,
      didDrag: false,
      rafId: null,
    };
  };

  const handleTitleBarPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const ds = titleBarDragStateRef.current;
    if (!ds) return;

    const dx = e.screenX - ds.startScreenX;
    const dy = -(e.screenY - ds.startScreenY); // Cocoa Y is inverted

    if (!ds.didDrag && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
      ds.didDrag = true;
    }
    if (!ds.didDrag) return;

    if (ds.rafId !== null) return;
    ds.rafId = requestAnimationFrame(() => {
      ds.rafId = null;
      postBridge('setDragOffset', {
        dx: ds.baseOffsetX + dx,
        dy: ds.baseOffsetY + dy,
      });
    });
  };

  const handleTitleBarPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    const ds = titleBarDragStateRef.current;
    if (ds) {
      if (ds.rafId !== null) cancelAnimationFrame(ds.rafId);
      if (ds.didDrag) {
        const dx = e.screenX - ds.startScreenX;
        const dy = -(e.screenY - ds.startScreenY);
        const finalDx = ds.baseOffsetX + dx;
        const finalDy = ds.baseOffsetY + dy;
        postBridge('setDragOffset', { dx: finalDx, dy: finalDy });
        titleBarAccumulatedOffsetRef.current = { dx: finalDx, dy: finalDy };
      }
    }
    titleBarDragStateRef.current = null;
    setIsTitleBarDragging(false);
  };

  // --- Resize pointer handlers ---
  const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'ne-resize';
    const currentWidth = accumulatedSizeRef.current?.width ?? window.innerWidth;
    const currentHeight = accumulatedSizeRef.current?.height ?? window.innerHeight;
    resizeStateRef.current = {
      startScreenX: e.screenX,
      startScreenY: e.screenY,
      baseWidth: currentWidth,
      baseHeight: currentHeight,
      rafId: null,
    };
  };

  const handleResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rs = resizeStateRef.current;
    if (!rs) return;
    if (rs.rafId !== null) return;
    rs.rafId = requestAnimationFrame(() => {
      rs.rafId = null;
      const deltaX = e.screenX - rs.startScreenX;
      const deltaY = -(e.screenY - rs.startScreenY);
      const newWidth = Math.max(370, rs.baseWidth + deltaX);
      const newHeight = Math.max(previousHeightRef.current, rs.baseHeight + deltaY);
      postBridge('setPopupSize', { width: Math.round(newWidth), height: Math.round(newHeight) });
    });
  };

  const handleResizePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    const rs = resizeStateRef.current;
    if (rs) {
      if (rs.rafId !== null) {
        cancelAnimationFrame(rs.rafId);
      }
      const deltaX = e.screenX - rs.startScreenX;
      const deltaY = -(e.screenY - rs.startScreenY);
      const finalWidth = Math.max(370, rs.baseWidth + deltaX);
      const finalHeight = Math.max(previousHeightRef.current, rs.baseHeight + deltaY);
      postBridge('setPopupSize', { width: Math.round(finalWidth), height: Math.round(finalHeight) });
      accumulatedSizeRef.current = { width: finalWidth, height: finalHeight };
    }
    resizeStateRef.current = null;
    document.body.style.cursor = '';
  };

  return (
    <div style={styles.container}>
      <div style={{ ...styles.modal, overflow: 'hidden' }}>
        {/* Draggable title bar */}
        <div
          style={{ ...styles.titleBar, cursor: isTitleBarDragging ? 'grabbing' : 'default' }}
          onPointerDown={handleTitleBarPointerDown}
          onPointerMove={handleTitleBarPointerMove}
          onPointerUp={handleTitleBarPointerUp}
        >
          {/* Left spacer balances the right-side buttons to keep title visually centered */}
          <div style={{ width: '72px', flexShrink: 0 }} />
          <span style={styles.titleBarText}>Academia Co-scientist</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
            <button
              style={styles.titleBarCloseBtn}
              onClick={handleToggleDock}
              onPointerDown={e => e.stopPropagation()}
              aria-label={isDocked ? 'Undock panel' : 'Dock to right'}
              title={isDocked ? 'Undock panel' : 'Dock to right'}
            >
              {isDocked ? <UndockIcon /> : <DockRightIcon />}
            </button>
            <button
              style={{ ...styles.titleBarCloseBtn, opacity: isDocked ? 0.3 : 1, cursor: isDocked ? 'default' : undefined }}
              onClick={isDocked ? undefined : handleToggleWidth}
              onPointerDown={e => e.stopPropagation()}
              aria-label={isWide ? 'Narrow window' : 'Widen window'}
              title={isDocked ? 'Not available while docked' : (isWide ? 'Narrow window' : 'Widen window')}
            >
              <WidthToggleIcon />
            </button>
            <button
              style={styles.titleBarCloseBtn}
              onClick={handleClose}
              onPointerDown={e => e.stopPropagation()}
              aria-label="Close"
            >
              <CloseIcon />
            </button>
          </div>
        </div>
        {/* Full-width document title bar — sibling of the title bar so its
            negative margins escape the modal's 24px padding edge-to-edge. */}
        {isInWorkspace && (() => {
          const docDisplay = effectiveDocDisplayName(activeDocumentDisplayName, docPath);
          return docDisplay ? (
            <div className="overlayDocumentBar" title={docDisplay}>
              <FileTextIcon className="overlayDocumentBarIcon" />
              <span className="overlayDocumentBarName">{docDisplay}</span>
            </div>
          ) : null;
        })()}
        {/* Resize handle at top-right corner */}
        <div
          style={{
            ...styles.resizeHandle,
            cursor: 'ne-resize',
          }}
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerUp}
        />
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          {activeSession
            ? <WorkspaceConversationView
                // `key` forces a fresh mount when the user switches
                // conversations. assistant-ui's `useLocalRuntime` calls
                // `history.load()` only on initial thread mount; updating
                // the history adapter reference (via useMemo on sessionId)
                // doesn't re-fire the load. Without this `key`, the runtime
                // keeps showing the previously-opened conversation while
                // the prop quietly changes — that's the "previous conversation
                // is loaded instead of the conversation I was in" symptom.
                key={activeSession.id}
                sessionId={activeSession.id}
                sessionTitle={activeSession.title}
                documentPath={docPath}
                documentDisplayName={activeDocumentDisplayName}
                selectedText={pollData?.selectedText}
                onBack={handleBackToSessions}
                canGoBack={workspaceSessions.length > 0}
                initialPrompt={pendingKickoffPrompt ?? undefined}
                onInitialPromptSent={() => setPendingKickoffPrompt(null)}
              />
            : isInWorkspace
            ? <WorkspaceSessionsView
                sessions={workspaceSessions}
                documentPath={docPath}
                documentDisplayName={activeDocumentDisplayName}
                onOpenSession={handleOpenSession}
                onNewConversation={handleNewConversation}
              />
            : isEnableFeedback
            ? <NotLinkedView isUnsavedDocument={isUnsavedDocument} />
            : <ConversationListView
                conversations={conversations}
                isLoading={isLoading}
                onContinueConversation={handleContinueConversation}
              />}
        </div>
      </div>
    </div>
  );
};

// Initialize React app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<AcademiaNotificationsPopupV2 />);
  console.log('[AcademiaNotificationsPopupV2] React app initialized');
} else {
  console.error('[AcademiaNotificationsPopupV2] Root container not found!');
}
