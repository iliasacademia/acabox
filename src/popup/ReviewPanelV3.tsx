import React, { useState, useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationDetail, ApiProvider } from '../../packages/shared-conversations/src';
import type { Conversation, DraftConversation } from '../../packages/shared-conversations/src/types/conversation';
import type { ProjectFile } from '../../packages/shared-conversations/src/types/project';
import '../../packages/shared-conversations/src/styles/conversations.css';
import { PopupApiClient } from './popupV2/PopupApiClient';
import { FEEDBACK_FORM_URL } from '../shared/constants';
import './ReviewPanelV3.css';

// Inject CSS overrides for ConversationDetail in this panel context
if (typeof document !== 'undefined' && !document.getElementById('review-panel-v3-overrides')) {
  const style = document.createElement('style');
  style.id = 'review-panel-v3-overrides';
  style.textContent = `
    .conversationDetail {
      position: relative;
      overflow: hidden;
      padding: 0;
      height: 100%;
    }
    .conversationMessages {
      overflow-y: auto;
      padding-bottom: 16px;
    }
    .conversationInput {
      position: sticky;
      bottom: 0;
      background-color: #ffffff;
      padding-top: 8px;
      padding-bottom: 12px;
      z-index: 1;
    }
  `;
  document.head.appendChild(style);
}

const urlParams = new URLSearchParams(window.location.search);
const serverUrl = window.location.origin;
const widParam = urlParams.get('wid');
const tokenParam = urlParams.get('token');
const pidParam = urlParams.get('pid');

function postBridge(action: string, payload: Record<string, unknown> = {}) {
  return fetch(`${serverUrl}/bridge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenParam}`,
    },
    body: JSON.stringify({ action, payload, pid: Number(pidParam), wid: widParam }),
  });
}

interface PanelContext {
  selectedText: string | null;
  projectId: number | null;
}

let draftIdCounter = -1;

const ReviewPanelV3: React.FC = () => {
  const [context, setContext] = useState<PanelContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [conversation, setConversation] = useState<Conversation | DraftConversation | null>(null);
  const [manuscriptFile, setManuscriptFile] = useState<ProjectFile | null>(null);

  const popupApiClient = useMemo(
    () => new PopupApiClient(serverUrl, tokenParam),
    []
  );

  // Fetch context on mount
  useEffect(() => {
    if (!widParam) {
      setLoading(false);
      return;
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (tokenParam) {
      headers['Authorization'] = `Bearer ${tokenParam}`;
    }

    fetch(`${serverUrl}/api/review-panel-v3/${widParam}/context`, { headers })
      .then((res) => res.json())
      .then((data: PanelContext) => {
        setContext(data);

        const now = new Date().toISOString();
        const draft: DraftConversation = {
          id: draftIdCounter--,
          agent_name: 'science_agent',
          title: null,
          summary: null,
          created_at: now,
          updated_at: now,
          parent_id: data.projectId ?? null,
          parent_type: 'Project',
          selected_text: data.selectedText,
          isDraft: true,
        };
        setConversation(draft);
      })
      .catch((err) => {
        console.error('[ReviewPanelV3] Failed to fetch context:', err);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  // Re-fetch context when panel becomes visible again (hidden, not destroyed, on close)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && widParam) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (tokenParam) {
          headers['Authorization'] = `Bearer ${tokenParam}`;
        }

        fetch(`${serverUrl}/api/review-panel-v3/${widParam}/context`, { headers })
          .then((res) => res.json())
          .then((data: PanelContext) => {
            setContext(data);
            const now = new Date().toISOString();
            const draft: DraftConversation = {
              id: draftIdCounter--,
              agent_name: 'science_agent',
              title: null,
              summary: null,
              created_at: now,
              updated_at: now,
              parent_id: data.projectId ?? null,
              parent_type: 'Project',
              selected_text: data.selectedText,
              isDraft: true,
            };
            setConversation(draft);
          })
          .catch((err) => {
            console.error('[ReviewPanelV3] Failed to re-fetch context:', err);
          });
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // Fetch primary manuscript file when projectId is available
  useEffect(() => {
    const projectId = context?.projectId;
    if (!projectId) return;
    let cancelled = false;
    popupApiClient.invoke<{ files?: ProjectFile[] }>({
      method: 'GET',
      endpoint: `v0/co_scientist/projects/${projectId}/files`,
    }).then((res) => {
      if (cancelled) return;
      const primary = (res.files || []).find((f) => f.is_primary_manuscript);
      if (primary) setManuscriptFile(primary);
    }).catch((err) => {
      console.error('[ReviewPanelV3] Failed to fetch project files:', err);
    });
    return () => { cancelled = true; };
  }, [context?.projectId, popupApiClient]);

  const handleClose = () => {
    postBridge('closeReviewPanelV3').catch((err) => {
      console.error('[ReviewPanelV3] Failed to close panel:', err);
    });
  };

  const handleConversationCreated = (newConversation: Conversation) => {
    setConversation(newConversation);
  };

  if (loading) {
    return (
      <div className="review-panel-container">
        <div className="review-panel-loading">
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  const projectId = context?.projectId ?? null;

  return (
    <div className="review-panel-container">
      <div className="review-panel-header">
        <h3 className="review-panel-title">Review</h3>
        <button className="review-panel-close-btn" onClick={handleClose} aria-label="Close">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M15 5L5 15M5 5L15 15" stroke="#141413" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="review-panel-body">
        <ApiProvider client={popupApiClient}>
          <ConversationDetail
            conversation={conversation}
            projectId={projectId}
            manuscriptFile={manuscriptFile}
            onConversationCreated={handleConversationCreated}
            feedbackFormUrl={FEEDBACK_FORM_URL}
            initialInputValue={context?.selectedText ? `"${context.selectedText}"\n\n` : undefined}
          />
        </ApiProvider>
      </div>
    </div>
  );
};

const rootElement = document.getElementById('root');
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(<ReviewPanelV3 />);
} else {
  console.error('[ReviewPanelV3] Root element not found');
}

export default ReviewPanelV3;
