import React from 'react';
import { FullStoryConfig } from '../utils/fullstory';
import { formatRelativeDate } from '../../shared/utils';
import type { ChatStreamMessage } from '../../cobuilding/shared/types';

// ─── URL Parameters & Server URL ────────────────────────────────────
export const serverUrl = window.location.origin;

const popupUrlParams = new URLSearchParams(window.location.search);
export const pidParam = popupUrlParams.get('pid');
export const widParam = popupUrlParams.get('wid');
export const tokenParam = popupUrlParams.get('token');
export const popupInstanceId = `AcademiaNotificationsPopupV2-${widParam || pidParam || Math.random().toString(36).substring(2, 8)}`;

/**
 * Tracks the currently focused window ID received from poll data.
 * Used by postBridge() when no explicit widOverride is given.
 */
let _v4FocusedWid: string | null = null;
export function setV4FocusedWid(wid: string | null) { _v4FocusedWid = wid; }
export function getV4FocusedWid(): string | null { return _v4FocusedWid; }

// ─── Height Constants ───────────────────────────────────────────────
// Title bar height: 36px bar (eats the 24px top padding via negative margin) + 16px margin below = 28px net
export const POPUP_TITLE_BAR_HEIGHT = 36;
export const POPUP_HEIGHT_NO_NOTIFICATIONS = 240 + POPUP_TITLE_BAR_HEIGHT;
export const POPUP_HEIGHT_ONE_NOTIFICATION = 320 + POPUP_TITLE_BAR_HEIGHT;
export const POPUP_HEIGHT_TWO_NOTIFICATIONS = 400 + POPUP_TITLE_BAR_HEIGHT;
export const POPUP_HEIGHT_REVIEW_VIEW = 660 + POPUP_TITLE_BAR_HEIGHT;
export const REVIEW_STATUS_CARD_HEIGHT = 72;
export const ERROR_MESSAGE_HEIGHT = 60;
export const POPUP_HEIGHT_REVIEW_INPUT = 380 + POPUP_TITLE_BAR_HEIGHT;
export const POPUP_HEIGHT_REVIEW_INPUT_PROGRESS = 250 + POPUP_TITLE_BAR_HEIGHT;
export const POPUP_HEIGHT_CONVERSATIONS_BASE = 100; // section header + "view all" row + spacing
export const POPUP_HEIGHT_PER_CONVERSATION = 74; // height per conversation card including gap

// ─── Type Definitions ───────────────────────────────────────────────
export type AgentRunStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface AgentRun {
  agent_run_id: number;
  agent_name: string;
  file_id: number;
  file_name: string;
  status: AgentRunStatus;
  running_jobs_count: number;
  created_at: string;
  review_data: unknown | null;
}

export interface ProjectStatusResponse {
  project_id: number;
  agent_runs: AgentRun[];
}

export interface ConversationItem {
  id: number;
  title: string | null;
  summary: string | null;
  created_at: string;
}

export type NotificationData = {
  id: number;
  project_id: number;
  conversation_id: number;
  created_at: number;
  title: string;
  conversation_title?: string;
  body_html?: string;
  isRead: boolean;
  selected_text?: string;
  review_type?: 'full-paper' | 'selected-text' | 'review-changes';
  isInProgress?: boolean;
};

export interface WordPollResponse {
  projectId?: number;
  projectFileId?: number;
  notificationCount?: number;
  isActive: boolean;
  recentReviewNotifications?: NotificationData[];
  activeDocumentPath?: string | null;
  /**
   * Server-supplied human-readable name for the active document. For
   * synthetic-scheme hosts (`gdocs://<id>`, `applenotes://<id>`) the path is
   * opaque, so the renderer should prefer this over deriving from the path.
   */
  activeDocumentDisplayName?: string | null;
  isReviewingSelectedText?: boolean;
  reviewType?: 'full-paper' | 'selected-text' | 'review-changes';
  selectedTextReviewStartedAt?: number;
  selectedText?: string;
  hasSelectedText?: boolean;
  isAwaitingReviewInput?: boolean;
  shouldShowButtonV2?: boolean;
  shouldShowPopupV2?: boolean;
  fullStoryConfig?: FullStoryConfig;
  reviewErrorMessage?: string;
  projectReviewState?: 'idle' | 'reviewing' | 'completed' | 'failed';
  wid?: string;
  /** Whether the panel is currently rendered in the docked position (false when Word is maximized and panel fell back to floating) */
  isDockedActive?: boolean;
  /** Whether the open document is within the cobuilding workspace directory */
  isInWorkspace?: boolean;
  /** Cobuilding workspace sessions (included when isInWorkspace is true) */
  workspaceSessions?: Array<{
    id: string;
    title: string;
    created_at: string;
    is_running?: boolean;
  }>;
  /**
   * Pending kickoff prompt for the active document, set by surfaces like the
   * Writing-Agent flow that want the overlay to start a new chat with this
   * text already sent. Consumed exactly once per pollData arrival; the server
   * deletes the entry after including it in a response.
   */
  pendingKickoffPrompt?: string;
  /**
   * Unique id for the current kickoff. Popup dedups by this id rather than by
   * prompt text, so repeat clicks (or identical prompts) each force a new chat.
   */
  pendingKickoffId?: string;
  pendingNavigateSessionId?: string;
  pendingNavigateNonce?: string;
}

// ─── Unified WebSocket Protocol ────────────────────────────────────
// All overlay↔main communication flows through a single WebSocket.

// Server → Client messages
export type ServerWebSocketMessage =
  | { type: 'poll'; data: WordPollResponse }
  | { type: 'chat:event'; sessionId: string; data: ChatStreamMessage }
  | { type: 'chat:done'; sessionId: string }
  | { type: 'chat:error'; sessionId: string; error: string }
  | { type: 'bridge:ack'; requestId: string; data: unknown }
  | { type: 'heartbeat' };

// Client → Server messages
export type ClientWebSocketMessage =
  | { type: 'refresh' }
  | { type: 'chat:send'; sessionId: string; text: string; documentPath?: string; selectedText?: string }
  | { type: 'chat:subscribe'; sessionId: string }
  | { type: 'chat:unsubscribe'; sessionId: string }
  | { type: 'bridge'; action: string; payload: Record<string, unknown>; requestId?: string };

// Backwards-compat alias
export type WebSocketMessage = ServerWebSocketMessage;

export type ReviewState = 'idle' | 'reviewing' | 'completed' | 'failed';

export type ViewMode = 'menu' | 'review' | 'review-input';

export interface NavigateRequest {
  page: 'conversation' | 'conversations' | 'external' | 'session';
  projectId?: number;
  conversationId?: number;
  sessionId?: string;
  openDiffModal?: boolean;
  url?: string;
}

// ─── WebSocket bridge sender ──────────────────────────────────────
// When a WebSocket is connected, bridge commands go over it.
// Falls back to HTTP POST if not connected.
let _bridgeWsSender: ((action: string, payload: Record<string, unknown>) => void) | null = null;
export function setBridgeWsSender(sender: ((action: string, payload: Record<string, unknown>) => void) | null) {
  _bridgeWsSender = sender;
}

// ─── Utility Functions ──────────────────────────────────────────────
export function postBridge(action: string, payload: Record<string, unknown> = {}, widOverride?: string | null) {
  if (_bridgeWsSender) {
    _bridgeWsSender(action, payload);
    return Promise.resolve(new Response(JSON.stringify({ success: true })));
  }
  const effectiveWid = widOverride ?? _v4FocusedWid;
  return fetch(`${serverUrl}/bridge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenParam}`,
    },
    body: JSON.stringify({ action, payload, pid: Number(pidParam), wid: effectiveWid }),
  });
}

export const formatConversationDate = (dateStr: string): string => {
  return formatRelativeDate(new Date(dateStr));
};

export const formatNotificationDate = (timestamp: number): string => {
  const date = new Date(timestamp);
  const weekday = date.toLocaleDateString('en-US', { weekday: 'short' });
  const month = date.toLocaleDateString('en-US', { month: 'short' });
  const day = date.getDate();
  const time = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).toLowerCase();
  return `${weekday}, ${month} ${day} at ${time}`;
};

export const navigateToPage = async (payload: NavigateRequest, token: string | null): Promise<boolean> => {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${serverUrl}/api/navigate`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error('[AcademiaNotificationsPopupV2] Navigation API failed:', response.status);
      return false;
    }

    const data = await response.json();
    return data.success === true;
  } catch (err) {
    console.error('[AcademiaNotificationsPopupV2] Navigation API error:', err);
    return false;
  }
};

// ─── SVG Icon Components ────────────────────────────────────────────
export const ArrowForwardIcon: React.FC = () => (
  React.createElement('svg', { width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('path', { d: 'M12 4L10.59 5.41L16.17 11H4V13H16.17L10.59 18.59L12 20L20 12L12 4Z', fill: '#141413' })
  )
);

export const NotificationsIcon: React.FC = () => (
  React.createElement('svg', { width: '20', height: '20', viewBox: '0 0 24 24', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('path', { d: 'M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z', fill: '#141413' })
  )
);

export const ChatBubbleIcon: React.FC = () => (
  React.createElement('svg', { width: '20', height: '20', viewBox: '0 0 24 24', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('path', { d: 'M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z', fill: '#141413' })
  )
);

export const LoadingSpinner: React.FC = () => (
  React.createElement('svg', { width: '16', height: '16', viewBox: '0 0 24 24', fill: 'none', xmlns: 'http://www.w3.org/2000/svg', style: { animation: 'spin 1s linear infinite' } },
    React.createElement('circle', { cx: '12', cy: '12', r: '10', stroke: '#141413', strokeWidth: '3', fill: 'none', opacity: '0.25' }),
    React.createElement('path', { d: 'M12 2a10 10 0 0 1 10 10', stroke: '#141413', strokeWidth: '3', strokeLinecap: 'round', fill: 'none' })
  )
);

export const CloseIcon: React.FC = () => (
  React.createElement('svg', { width: '20', height: '20', viewBox: '0 0 20 20', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('path', { d: 'M15 5L5 15M5 5L15 15', stroke: '#141413', strokeWidth: '2', strokeLinecap: 'round' })
  )
);

export const ArrowBackIcon: React.FC = () => (
  React.createElement('svg', { width: '20', height: '20', viewBox: '0 0 24 24', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('path', { d: 'M20 11H7.83L13.42 5.41L12 4L4 12L12 20L13.41 18.59L7.83 13H20V11Z', fill: '#141413' })
  )
);

export const WidthToggleIcon: React.FC = () => (
  React.createElement('svg', { width: '20', height: '20', viewBox: '0 0 24 24', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('path', { d: 'M8 8L4 12L8 16', stroke: '#141413', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round' }),
    React.createElement('path', { d: 'M16 8L20 12L16 16', stroke: '#141413', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round' }),
    React.createElement('line', { x1: '4', y1: '12', x2: '20', y2: '12', stroke: '#141413', strokeWidth: '2', strokeLinecap: 'round' })
  )
);

// Panel docked to right side: large rectangle on left, narrow filled bar on right
export const DockRightIcon: React.FC = () => (
  React.createElement('svg', { width: '16', height: '16', viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('rect', { x: '1', y: '2', width: '9', height: '12', rx: '1', stroke: '#141413', strokeWidth: '1.5' }),
    React.createElement('rect', { x: '12', y: '2', width: '3', height: '12', rx: '1', fill: '#141413' })
  )
);

// Floating/undocked: narrow filled bar on left, large rectangle on right
export const UndockIcon: React.FC = () => (
  React.createElement('svg', { width: '16', height: '16', viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
    React.createElement('rect', { x: '1', y: '2', width: '3', height: '12', rx: '1', fill: '#141413' }),
    React.createElement('rect', { x: '6', y: '2', width: '9', height: '12', rx: '1', stroke: '#141413', strokeWidth: '1.5' })
  )
);

// ─── Styles ─────────────────────────────────────────────────────────
export const styles: { [key: string]: React.CSSProperties } = {
  container: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    borderRadius: '16px',
    overflow: 'hidden',
  },
  modal: {
    width: '100%',
    background: '#ffffff',
    borderRadius: '16px',
    border: '1px solid #ccc9bc',
    position: 'relative',
    padding: '24px',
    fontFamily: "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    height: '100%',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
  },
  titleBar: {
    display: 'flex',
    alignItems: 'center',
    height: '44px',
    // Escape the modal's 24px padding to span full width edge-to-edge
    margin: '-24px -24px 16px -24px',
    paddingLeft: '12px',
    paddingRight: '12px',
    backgroundColor: '#f5f4f0',
    borderBottom: '1px solid #e0ddd4',
    borderRadius: '16px 16px 0 0',
    flexShrink: 0,
    touchAction: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  } as React.CSSProperties,
  titleBarText: {
    flex: 1,
    textAlign: 'center',
    fontSize: '13px',
    fontWeight: 500,
    color: '#535366',
    letterSpacing: '0.01em',
  } as React.CSSProperties,
  titleBarCloseBtn: {
    width: '20px',
    height: '20px',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    borderRadius: '4px',
    flexShrink: 0,
    color: '#535366',
  },
  resizeHandle: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: '24px',
    height: '24px',
    cursor: 'ne-resize',
    zIndex: 10,
    borderTopRightRadius: '16px',
  },
  closeButton: {
    position: 'absolute',
    top: '12px',
    right: '12px',
    width: '20px',
    height: '20px',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  widthToggleButton: {
    position: 'absolute',
    top: '12px',
    right: '40px',
    width: '20px',
    height: '20px',
    border: 'none',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    paddingBottom: '12px',
  },
  sectionHeaderText: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 600,
    lineHeight: '20px',
    color: '#141413',
  },
  feedbackContent: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  reviewStatusCard: {
    backgroundColor: '#FFFFFF',
    border: '1px solid #E0E0E0',
    borderRadius: '12px',
    padding: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  reviewStatusHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  reviewStatusSpinner: {
    width: '20px',
    height: '20px',
    animation: 'spin 1s linear infinite',
    flexShrink: 0,
  },
  reviewStatusTitle: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 600,
    lineHeight: '20px',
    color: '#141413',
  },
  reviewStatusContent: {
    backgroundColor: '#EEF2F9',
    borderRadius: '8px',
    padding: '12px',
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '14px',
    lineHeight: '20px',
    color: '#141413',
  },
  reviewProgressBar: {
    width: '100%',
    height: '8px',
    backgroundColor: '#E0E0E0',
    borderRadius: '4px',
    overflow: 'hidden',
  },
  reviewProgressFill: {
    height: '100%',
    backgroundColor: '#6B7E6F',
    borderRadius: '4px',
  },
  reviewProgressFooter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  reviewProgressText: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '14px',
    fontWeight: 600,
    lineHeight: '18px',
    color: '#141413',
  },
  notificationCard: {
    backgroundColor: '#F5F3EE',
    borderRadius: '8px',
    padding: '12px',
    paddingRight: '8px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    position: 'relative',
    border: 'none',
    cursor: 'pointer',
    width: '100%',
    textAlign: 'left',
  },
  blueDot: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    backgroundColor: '#0645b1',
    position: 'absolute',
    left: '-5px',
    top: '50%',
    transform: 'translateY(-50%)',
    flexShrink: 0,
  },
  notificationContent: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  selectedTextPreview: {
    backgroundColor: '#eef2f9',
    borderRadius: '4px',
    padding: '8px',
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '14px',
    lineHeight: '18px',
    color: '#141413',
    marginBottom: '8px',
  },
  notificationTitle: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: '20px',
    color: '#141413',
  },
  notificationDate: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '14px',
    fontWeight: 400,
    lineHeight: '20px',
    color: '#6d6d7d',
  },
  viewPreviousRow: {
    backgroundColor: '#f9f8f6',
    borderRadius: '8px',
    padding: '12px',
    paddingRight: '8px',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    border: 'none',
    cursor: 'pointer',
    width: '100%',
    textAlign: 'left',
  },
  viewPreviousText: {
    flex: 1,
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: '20px',
    color: '#141413',
  },
  arrowIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  feedbackButtonsRow: {
    display: 'flex',
    flexDirection: 'row',
    gap: '12px',
  },
  feedbackButton: {
    flex: 1,
    backgroundColor: '#ffffff',
    border: '1px solid #141413',
    borderRadius: '8px',
    padding: '10px 8px 10px 12px',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    cursor: 'pointer',
    textAlign: 'left',
  },
  feedbackButtonText: {
    flex: 1,
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: '20px',
    color: '#141413',
  },
  feedbackButtonDisabled: {
    cursor: 'not-allowed',
    opacity: 0.5,
  },
  actionCard: {
    backgroundColor: '#f9f8f6',
    borderRadius: '8px',
    overflow: 'hidden',
  },
  actionRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    padding: '16px',
  },
  actionRowWithBorder: {
    borderBottom: '1px solid #dddde2',
  },
  actionRowText: {
    flex: 1,
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: '20px',
    color: '#141413',
  },
  arrowButton: {
    backgroundColor: '#ffffff',
    border: '1px solid #141413',
    borderRadius: '8px',
    width: '32px',
    height: '32px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flexShrink: 0,
    padding: 0,
  },
  arrowButtonDisabled: {
    cursor: 'not-allowed',
    opacity: 0.5,
  },
  viewPreviousLink: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '14px',
    fontWeight: 400,
    lineHeight: '20px',
    color: '#141413',
    textDecoration: 'underline',
    cursor: 'pointer',
    background: 'none',
    border: 'none',
    padding: 0,
    textAlign: 'left',
  },
  errorMessage: {
    backgroundColor: '#FEE2E2',
    borderRadius: '8px',
    padding: '12px 16px',
    color: '#DC2626',
    fontSize: '14px',
    fontFamily: "'DM Sans', sans-serif",
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  sectionWithBorder: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    paddingBottom: '24px',
    borderBottom: '1px solid #CCC9BC',
  },
  sectionText: {
    fontSize: '16px',
    fontWeight: 600,
    color: '#141413',
    lineHeight: '20px',
    margin: 0,
  },
  actionButton: {
    width: '100%',
    height: '32px',
    backgroundColor: '#ffffff',
    border: '1px solid #141413',
    borderRadius: '8px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '4px',
    padding: '4px 8px',
    transition: 'background-color 0.15s ease',
    fontFamily: 'inherit',
  },
  buttonText: {
    fontSize: '14px',
    fontWeight: 400,
    color: '#141413',
    lineHeight: '20px',
    textAlign: 'center',
  },
  errorText: {
    fontSize: '14px',
    fontWeight: 500,
    color: '#DC2626',
    lineHeight: '18px',
    margin: 0,
    textAlign: 'center' as const,
  },
  actionButtonDisabled: {
    backgroundColor: '#E5E5E5',
    borderColor: '#CCCCCC',
    cursor: 'not-allowed',
    opacity: 0.6,
  },
  buttonTextDisabled: {
    color: '#999999',
  },
  reviewHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: '16px',
  },
  backButton: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
  },
  backButtonText: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 600,
    color: '#141413',
  },
  reviewScrollArea: {
    flex: 1,
    overflowY: 'auto',
    paddingRight: '8px',
  },
  reviewTitle: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '20px',
    fontWeight: 700,
    lineHeight: '24px',
    color: '#141413',
    margin: '0 0 4px 0',
  },
  reviewDate: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: '20px',
    color: '#535366',
  },
  reviewContent: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 400,
    color: '#141413',
  },
  loadingText: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px',
    color: '#535366',
    textAlign: 'center',
    padding: '24px 0',
  },
  userMessage: {
    marginLeft: 'auto',
    marginRight: 0,
    maxWidth: '300px',
    marginBottom: '12px',
  },
  userMessageContent: {
    padding: '12px 16px',
    backgroundColor: '#e6ecf7',
    borderRadius: '8px',
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: '20px',
    color: '#141413',
  },
  assistantMessage: {
    marginBottom: '12px',
  },
  reviewFooter: {
    borderTop: '1px solid #dddde2',
    paddingTop: '24px',
    marginTop: '24px',
  },
  askFollowUpButton: {
    width: '100%',
    height: '32px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '4px',
    backgroundColor: '#ffffff',
    border: '1px solid #141413',
    borderRadius: '8px',
    cursor: 'pointer',
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '14px',
    fontWeight: 400,
    color: '#141413',
  },
  provideFeedbackLink: {
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: '20px',
    color: '#0645b1',
    textDecoration: 'underline',
    textAlign: 'center',
    width: '100%',
    display: 'block',
    marginTop: '10px',
    cursor: 'pointer',
    background: 'none',
    border: 'none',
    padding: 0,
  },
  selectedTextContainer: {
    marginTop: '16px',
    marginBottom: '16px',
  },
  selectedTextBox: {
    backgroundColor: '#EEF2F9',
    borderRadius: '8px',
    padding: '12px 16px',
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: '20px',
    color: '#141413',
  },
  selectedTextToggle: {
    backgroundColor: 'transparent',
    border: 'none',
    color: '#0645b1',
    textDecoration: 'underline',
    cursor: 'pointer',
    fontFamily: "'DM Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 400,
    padding: 0,
    marginLeft: '4px',
  },
};

// ─── Dynamic Stylesheet Injection ───────────────────────────────────
if (typeof document !== 'undefined') {
  const styleElement = document.createElement('style');
  styleElement.textContent = `
    @keyframes spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }
    .action-button:hover:not(:disabled) {
      background-color: #f5f5f5 !important;
    }
    .action-button:disabled {
      cursor: not-allowed !important;
    }
    button[aria-label="Close"]:hover {
      background-color: rgba(0, 0, 0, 0.05) !important;
    }
    .review-content p, .review-content h1, .review-content h2, .review-content h3, .review-content h4, .review-content h5, .review-content h6, .review-content ul, .review-content ol, .review-content li {
      margin: 0 0 12px 0;
    }
    .markdown-content { font-family: 'DM Sans', sans-serif; font-size: 14px; line-height: 1.5; color: #141413; }
    .markdown-content p { margin: 0 0 8px 0; }
    .markdown-content p:last-child { margin-bottom: 0; }
    .markdown-content h1, .markdown-content h2, .markdown-content h3, .markdown-content h4 { margin: 12px 0 6px 0; font-weight: 600; }
    .markdown-content h1 { font-size: 18px; }
    .markdown-content h2 { font-size: 16px; }
    .markdown-content h3 { font-size: 15px; }
    .markdown-content ul, .markdown-content ol { margin: 0 0 8px 0; padding-left: 20px; }
    .markdown-content li { margin: 2px 0; }
    .markdown-content code { background: #e8e6df; border-radius: 3px; padding: 1px 4px; font-family: monospace; font-size: 13px; }
    .markdown-content pre { background: #f5f4f0; border-radius: 6px; padding: 10px; margin: 0 0 8px 0; overflow-x: auto; }
    .markdown-content pre code { background: none; padding: 0; }
    .markdown-content blockquote { border-left: 3px solid #ccc9bc; margin: 0 0 8px 0; padding: 4px 12px; color: #535366; }
    .markdown-content strong { font-weight: 600; }
    .markdown-content a { color: #0645b1; text-decoration: underline; }
    .markdown-content table { border-collapse: collapse; margin: 0 0 8px 0; width: 100%; }
    .markdown-content th, .markdown-content td { border: 1px solid #ccc9bc; padding: 4px 8px; text-align: left; font-size: 13px; }
    .markdown-content th { background: #f5f4f0; font-weight: 600; }
  `;

  if (!document.getElementById('academia-notifications-popup-v2-styles')) {
    styleElement.id = 'academia-notifications-popup-v2-styles';
    document.head.appendChild(styleElement);
  }
}
