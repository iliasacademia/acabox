import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
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
import { ConversationListView, NotLinkedView, WorkspaceSessionsView, WorkspaceConversationView } from './popupV2/MenuView';


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

  // Restore per-document dock preference whenever the active document changes.
  useEffect(() => {
    if (!docPath) return;
    const pref = localStorage.getItem(DOCK_PREF_KEY + docPath) === 'true';
    setIsDocked(pref);
    if (pref || prevDocPathRef.current !== null) {
      postBridge('setDockRight', { docked: pref });
    }
    prevDocPathRef.current = docPath;
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

    if (activeSession) {
      // Full conversation view — use a large fixed height
      height = 500;
    } else if (isInWorkspace) {
      height = POPUP_HEIGHT_CONVERSATIONS_BASE;
      height += workspaceSessions.length * POPUP_HEIGHT_PER_CONVERSATION;
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
      <div style={{ ...styles.modal, overflowY: 'auto' }}>
        {/* Draggable title bar */}
        <div
          style={{ ...styles.titleBar, cursor: isTitleBarDragging ? 'grabbing' : 'default' }}
          onPointerDown={handleTitleBarPointerDown}
          onPointerMove={handleTitleBarPointerMove}
          onPointerUp={handleTitleBarPointerUp}
        >
          {/* Left spacer balances the right-side buttons to keep title visually centered */}
          <div style={{ width: '72px', flexShrink: 0 }} />
          <span style={styles.titleBarText}>Academia</span>
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
        {activeSession
          ? <WorkspaceConversationView
              sessionId={activeSession.id}
              sessionTitle={activeSession.title}
              documentPath={docPath}
              selectedText={pollData?.selectedText}
              onBack={handleBackToSessions}
            />
          : isInWorkspace
          ? <WorkspaceSessionsView
              sessions={workspaceSessions}
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
