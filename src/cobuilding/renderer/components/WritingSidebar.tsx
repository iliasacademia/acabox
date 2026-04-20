import React, { useState, useEffect, useCallback } from 'react';
import { useAssistantRuntime } from '@assistant-ui/react';
import {
  ChevronRightIcon,
  RefreshCwIcon,
  FileTextIcon,
  MessageSquareIcon,
  LinkIcon,
  Loader2Icon,
  FolderIcon,
  FolderOpenIcon,
} from 'lucide-react';

interface WritingSidebarProps {
  onContinueConversation?: () => void;
}

/** Format raw project names: replace underscores/hyphens with spaces, title case */
function formatName(name: string): string {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => {
      if (w.length <= 2) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ');
}

export const WritingSidebar: React.FC<WritingSidebarProps> = ({ onContinueConversation }) => {
  const [linked, setLinked] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<WritingAgentProject[]>([]);
  const [expandedProject, setExpandedProject] = useState<number | null>(null);
  const [projectFiles, setProjectFiles] = useState<Record<number, WritingAgentFile[]>>({});
  const [projectConversations, setProjectConversations] = useState<Record<number, WritingAgentConversation[]>>({});
  const [supportingFiles, setSupportingFiles] = useState<WritingAgentSupportingFile[]>([]);
  const [continuedConversations, setContinuedConversations] = useState<Record<number, string>>({});
  const [supportingExpanded, setSupportingExpanded] = useState(false);
  const [activeConvoId, setActiveConvoId] = useState<number | null>(null);
  const [linking, setLinking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runtime = useAssistantRuntime();

  const loadLocalSessions = useCallback(async (convos: Record<number, WritingAgentConversation[]>) => {
    const sessions = await window.sessionsAPI.list('writing_agent');
    const map: Record<number, string> = {};
    for (const [, projectConvos] of Object.entries(convos)) {
      for (const convo of projectConvos) {
        const match = sessions.find((s) => s.title === (convo.title || 'Writing Agent Chat'));
        if (match) map[convo.id] = match.id;
      }
    }
    setContinuedConversations(map);
  }, []);

  const checkLinked = useCallback(async () => {
    const isLinked = await window.writingAgentAPI.isLinked();
    setLinked(isLinked);
    if (isLinked) {
      const cachedProjects = await window.writingAgentAPI.listProjects();
      setProjects(cachedProjects);
      const sf = await window.writingAgentAPI.listSupportingFiles();
      setSupportingFiles(sf);
    }
  }, []);

  useEffect(() => { checkLinked(); }, [checkLinked]);

  const handleLink = useCallback(async () => {
    setLinking(true);
    setError(null);
    try {
      const result = await window.writingAgentAPI.link();
      if (result.success) setLinked(true);
      else setError(result.error || 'Failed to link');
    } catch (err: any) {
      setError(err.message || 'Failed to link');
    } finally {
      setLinking(false);
    }
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      await window.writingAgentAPI.refresh();
      const cachedProjects = await window.writingAgentAPI.listProjects();
      setProjects(cachedProjects);
      setProjectFiles({});
      setProjectConversations({});
      setContinuedConversations({});
      const sf = await window.writingAgentAPI.listSupportingFiles();
      setSupportingFiles(sf);
    } catch (err: any) {
      setError(err.message || 'Failed to refresh');
    } finally {
      setRefreshing(false);
    }
  }, []);

  const handleExpandProject = useCallback(async (projectId: number) => {
    if (expandedProject === projectId) { setExpandedProject(null); return; }
    setExpandedProject(projectId);
    if (!projectFiles[projectId]) {
      const files = await window.writingAgentAPI.getProjectFiles(projectId);
      setProjectFiles((prev) => ({ ...prev, [projectId]: files }));
    }
    if (!projectConversations[projectId]) {
      const convos = await window.writingAgentAPI.listConversations(projectId);
      setProjectConversations((prev) => {
        const updated = { ...prev, [projectId]: convos };
        loadLocalSessions(updated);
        return updated;
      });
    }
  }, [expandedProject, projectFiles, projectConversations, loadLocalSessions]);

  const scrollToLastMessage = useCallback(() => {
    // After switching to a continued conversation, scroll so the last message
    // is visible in the middle of the viewport instead of scrolled past
    setTimeout(() => {
      const viewport = document.querySelector('.threadViewport');
      if (!viewport) return;
      const messages = viewport.querySelectorAll('[data-role="assistant"], [data-role="user"]');
      const lastMsg = messages[messages.length - 1] as HTMLElement | undefined;
      if (lastMsg) {
        const viewportHeight = viewport.clientHeight;
        const msgTop = lastMsg.offsetTop;
        const msgHeight = lastMsg.offsetHeight;
        // Position the last message in the center of the viewport
        viewport.scrollTop = Math.max(0, msgTop - (viewportHeight / 2) + (msgHeight / 2));
      }
    }, 150);
  }, []);

  const handleContinueConversation = useCallback(async (conversationId: number, projectId: number) => {
    setActiveConvoId(conversationId);
    if (continuedConversations[conversationId]) {
      runtime.threads.switchToThread(continuedConversations[conversationId]);
      onContinueConversation?.();
      scrollToLastMessage();
      return;
    }
    try {
      const sessionId = await window.writingAgentAPI.continueConversation(conversationId, projectId);
      setContinuedConversations((prev) => ({ ...prev, [conversationId]: sessionId }));
      runtime.threads.switchToThread(sessionId);
      onContinueConversation?.();
      scrollToLastMessage();
    } catch (err: any) {
      setError(err.message || 'Failed to continue conversation');
    }
  }, [runtime, continuedConversations, onContinueConversation, scrollToLastMessage]);

  if (linked === null) {
    return (
      <div className="filesTab" style={{ padding: 16, textAlign: 'center' }}>
        <Loader2Icon style={{ width: 20, height: 20, animation: 'spin 1s linear infinite' }} />
      </div>
    );
  }

  if (!linked) {
    return (
      <div className="filesTab" style={{ padding: 16 }}>
        <div style={{ marginBottom: 12, fontSize: 13, color: '#888' }}>
          Connect to the Academia.edu Writing Agent to browse your projects and conversations.
        </div>
        <button className="gsStep__btn gsStep__btn--primary" style={{ width: '100%' }} onClick={handleLink} disabled={linking}>
          <LinkIcon style={{ width: 14, height: 14, marginRight: 6 }} />
          {linking ? 'Linking...' : 'Link Writing Agent'}
        </button>
        {error && <div style={{ color: '#c33', fontSize: 12, marginTop: 8 }}>{error}</div>}
      </div>
    );
  }

  return (
    <div className="filesTab">
      {/* Header — matches fileTreeRow--root pattern */}
      <div className="fileTreeRow" style={{ paddingLeft: 8, paddingRight: 8, marginTop: 4 }}>
        <div className="fileTreeRowMain" style={{ flex: 1 }}>
          <span className="fileTreeName fileTreeName--root">Writing Agent</span>
        </div>
        <div className="fileTreeRowActions">
          <button
            className="fileTreeRefresh"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Sync from server"
            style={refreshing ? { opacity: 1 } : undefined}
          >
            <RefreshCwIcon style={{ width: 14, height: 14, animation: refreshing ? 'spin 1s linear infinite' : 'none' }} />
          </button>
        </div>
      </div>

      {error && <div style={{ color: '#c33', fontSize: 12, padding: '0 12px 4px' }}>{error}</div>}

      <div className="filesTabTree">
        {projects.length === 0 && !refreshing && (
          <div style={{ padding: '8px 12px', fontSize: 12, color: '#888' }}>
            No projects found. Click sync to refresh.
          </div>
        )}

        {/* Projects — fileTreeRow pattern with chevron + folder icon */}
        {projects.map((project) => {
          const files = projectFiles[project.id];
          const convos = projectConversations[project.id];
          const isExpanded = expandedProject === project.id;

          return (
            <React.Fragment key={project.id}>
              {/* Project row — same as file tree folder */}
              <div
                className="fileTreeRow"
                style={{ paddingLeft: 8 }}
                onClick={() => handleExpandProject(project.id)}
              >
                <div className="fileTreeRowMain">
                  <ChevronRightIcon className={`fileTreeChevron ${isExpanded ? 'fileTreeChevron--open' : ''}`} />
                  {isExpanded
                    ? <FolderOpenIcon className="fileTreeIcon" />
                    : <FolderIcon className="fileTreeIcon" />
                  }
                  <span className="fileTreeName">{formatName(project.name)}</span>
                </div>
              </div>

              {/* Expanded content */}
              {isExpanded && (
                <>
                  {/* Manuscripts — file tree items indented */}
                  {files && files.map((file) => (
                    <div key={file.id} className="fileTreeRow" style={{ paddingLeft: 34, height: 26 }}>
                      <div className="fileTreeRowMain">
                        <span className="fileTreeChevronSpacer" />
                        <FileTextIcon className="fileTreeIcon" style={{ color: file.is_primary_manuscript ? '#4a9eff' : undefined }} />
                        <span className="fileTreeName">{file.file_name}</span>
                      </div>
                    </div>
                  ))}

                  {/* Conversations — matches chat list threadListItem pattern */}
                  <div style={{ padding: '4px 0' }}>
                    {convos && convos.map((convo) => {
                      const date = convo.server_created_at ? new Date(convo.server_created_at) : null;
                      const dateStr = date ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
                      return (
                        <div
                          key={convo.id}
                          className="threadListItem"
                          data-active={activeConvoId === convo.id ? '' : undefined}
                        >
                          <button
                            className="threadListItemTrigger"
                            style={{ paddingLeft: 34 }}
                            onClick={() => {
                              setActiveConvoId(convo.id);
                              handleContinueConversation(convo.id, project.id);
                            }}
                          >
                            <span className="threadListItemTitle">
                              <span className="threadListItemTitleText">
                                {convo.title || 'Untitled'}
                              </span>
                              {dateStr && (
                                <span className="threadListItemDate">{dateStr}</span>
                              )}
                            </span>
                          </button>
                        </div>
                      );
                    })}
                  </div>

                  {/* Loading state */}
                  {!files && !convos && (
                    <div style={{ padding: '6px 34px', fontSize: 12, color: '#999' }}>Loading...</div>
                  )}
                </>
              )}
            </React.Fragment>
          );
        })}

        {/* Supporting Files — collapsible, collapsed by default */}
        {supportingFiles.length > 0 && (
          <>
            <div
              className="fileTreeRow"
              style={{ paddingLeft: 8, marginTop: 4 }}
              onClick={() => setSupportingExpanded((v) => !v)}
            >
              <div className="fileTreeRowMain">
                <ChevronRightIcon className={`fileTreeChevron ${supportingExpanded ? 'fileTreeChevron--open' : ''}`} />
                {supportingExpanded
                  ? <FolderOpenIcon className="fileTreeIcon" />
                  : <FolderIcon className="fileTreeIcon" />
                }
                <span className="fileTreeName">Supporting Files</span>
              </div>
            </div>
            {supportingExpanded && supportingFiles.map((file) => (
              <div key={file.id} className="fileTreeRow" style={{ paddingLeft: 34, height: 26 }}>
                <div className="fileTreeRowMain">
                  <span className="fileTreeChevronSpacer" />
                  <FileTextIcon className="fileTreeIcon" />
                  <span className="fileTreeName">{file.file_name}</span>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
};
