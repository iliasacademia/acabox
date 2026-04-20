import React, { useState, useEffect, useCallback } from 'react';
import { useAssistantRuntime } from '@assistant-ui/react';
import {
  ChevronRightIcon,
  RefreshCwIcon,
  FileTextIcon,
  MessageSquareIcon,
  LinkIcon,
  Loader2Icon,
} from 'lucide-react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './ui/collapsible';

interface WritingSidebarProps {
  onContinueConversation?: () => void;
}

export const WritingSidebar: React.FC<WritingSidebarProps> = ({ onContinueConversation }) => {
  const [linked, setLinked] = useState<boolean | null>(null);
  const [projects, setProjects] = useState<WritingAgentProject[]>([]);
  const [expandedProject, setExpandedProject] = useState<number | null>(null);
  const [projectFiles, setProjectFiles] = useState<Record<number, WritingAgentFile[]>>({});
  const [projectConversations, setProjectConversations] = useState<Record<number, WritingAgentConversation[]>>({});
  const [supportingFiles, setSupportingFiles] = useState<WritingAgentSupportingFile[]>([]);
  // Maps server conversation ID → local session ID once continued
  const [continuedConversations, setContinuedConversations] = useState<Record<number, string>>({});
  const [linking, setLinking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runtime = useAssistantRuntime();

  // Build the continued conversations map from local sessions that match server conversation titles
  const loadLocalSessions = useCallback(async (convos: Record<number, WritingAgentConversation[]>) => {
    const sessions = await window.sessionsAPI.list('writing_agent');
    const map: Record<number, string> = {};
    // Match local sessions to server conversations by title
    for (const [, projectConvos] of Object.entries(convos)) {
      for (const convo of projectConvos) {
        const match = sessions.find((s) => s.title === (convo.title || 'Writing Agent Chat'));
        if (match) {
          map[convo.id] = match.id;
        }
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

  useEffect(() => {
    checkLinked();
  }, [checkLinked]);

  const handleLink = useCallback(async () => {
    setLinking(true);
    setError(null);
    try {
      const result = await window.writingAgentAPI.link();
      if (result.success) {
        setLinked(true);
      } else {
        setError(result.error || 'Failed to link');
      }
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
    if (expandedProject === projectId) {
      setExpandedProject(null);
      return;
    }
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

  const handleContinueConversation = useCallback(async (conversationId: number, projectId: number) => {
    // If already continued, just switch to the existing local session
    if (continuedConversations[conversationId]) {
      runtime.threads.switchToThread(continuedConversations[conversationId]);
      onContinueConversation?.();
      return;
    }
    try {
      const sessionId = await window.writingAgentAPI.continueConversation(conversationId, projectId);
      setContinuedConversations((prev) => ({ ...prev, [conversationId]: sessionId }));
      runtime.threads.switchToThread(sessionId);
      onContinueConversation?.();
    } catch (err: any) {
      setError(err.message || 'Failed to continue conversation');
    }
  }, [runtime, continuedConversations, onContinueConversation]);

  if (linked === null) {
    return (
      <div className="threadListRoot" style={{ padding: 16, textAlign: 'center' }}>
        <Loader2Icon style={{ width: 20, height: 20, animation: 'spin 1s linear infinite' }} />
      </div>
    );
  }

  if (!linked) {
    return (
      <div className="threadListRoot" style={{ padding: 16 }}>
        <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--text-secondary, #888)' }}>
          Connect to the Academia.edu Writing Agent to browse your projects, manuscripts, and conversations.
        </div>
        <button
          className="gsStep__btn gsStep__btn--primary"
          style={{ width: '100%' }}
          onClick={handleLink}
          disabled={linking}
        >
          <LinkIcon style={{ width: 14, height: 14, marginRight: 6 }} />
          {linking ? 'Linking...' : 'Link to Writing Agent'}
        </button>
        {error && <div style={{ color: 'var(--error, #e55)', fontSize: 12, marginTop: 8 }}>{error}</div>}
      </div>
    );
  }

  return (
    <div className="threadListRoot">
      <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-secondary, #888)' }}>
          Writing Agent
        </span>
        <button
          className="threadListItemAction"
          onClick={handleRefresh}
          disabled={refreshing}
          title="Refresh from server"
          style={{ padding: 4 }}
        >
          <RefreshCwIcon style={{ width: 14, height: 14, animation: refreshing ? 'spin 1s linear infinite' : 'none' }} />
        </button>
      </div>

      {error && <div style={{ color: 'var(--error, #e55)', fontSize: 12, padding: '0 12px 8px' }}>{error}</div>}

      {projects.length === 0 && !refreshing && (
        <div style={{ padding: '8px 12px', fontSize: 13, color: 'var(--text-secondary, #888)' }}>
          No projects found. Click refresh to sync from server.
        </div>
      )}

      {projects.map((project) => (
        <Collapsible
          key={project.id}
          open={expandedProject === project.id}
          onOpenChange={() => handleExpandProject(project.id)}
        >
          <CollapsibleTrigger className="reactionsSectionHeader">
            <ChevronRightIcon className="reactionsSectionChevron" />
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {project.name}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary, #666)', marginLeft: 4 }}>
              {project.file_count} files
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {/* Files */}
            {projectFiles[project.id] && projectFiles[project.id].length > 0 && (
              <div style={{ padding: '4px 0' }}>
                <div style={{ padding: '4px 24px', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary, #888)', textTransform: 'uppercase' }}>
                  Files
                </div>
                {projectFiles[project.id].map((file) => (
                  <div key={file.id} className="threadListItem" style={{ paddingLeft: 24 }}>
                    <div className="threadListItemTrigger" style={{ cursor: 'default' }}>
                      <FileTextIcon style={{ width: 13, height: 13, marginRight: 6, flexShrink: 0, color: file.is_primary_manuscript ? 'var(--accent, #4a9eff)' : 'inherit' }} />
                      <span className="threadListItemTitleText" style={{ fontSize: 12 }}>
                        {file.file_name}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {/* Conversations */}
            {projectConversations[project.id] && projectConversations[project.id].length > 0 && (
              <div style={{ padding: '4px 0' }}>
                <div style={{ padding: '4px 24px', fontSize: 11, fontWeight: 600, color: 'var(--text-secondary, #888)', textTransform: 'uppercase' }}>
                  Conversations
                </div>
                {projectConversations[project.id].map((convo) => {
                  return (
                    <div key={convo.id} className="threadListItem" style={{ paddingLeft: 24 }}>
                      <button
                        className="threadListItemTrigger"
                        onClick={() => handleContinueConversation(convo.id, project.id)}
                      >
                        <MessageSquareIcon style={{ width: 13, height: 13, marginRight: 6, flexShrink: 0, color: continuedConversations[convo.id] ? 'var(--accent, #4a9eff)' : 'inherit' }} />
                        <span className="threadListItemTitleText" style={{ fontSize: 12 }}>
                          {convo.title || 'Untitled conversation'}
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>
      ))}

      {/* Supporting Files (user-level) */}
      {supportingFiles.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="reactionsSectionHeader">
            <ChevronRightIcon className="reactionsSectionChevron" />
            Supporting Files
            <span style={{ fontSize: 11, color: 'var(--text-tertiary, #666)', marginLeft: 4 }}>
              {supportingFiles.length}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="threadListItems">
              {supportingFiles.map((file) => (
                <div key={file.id} className="threadListItem" style={{ paddingLeft: 12 }}>
                  <div className="threadListItemTrigger" style={{ cursor: 'default' }}>
                    <FileTextIcon style={{ width: 13, height: 13, marginRight: 6, flexShrink: 0 }} />
                    <span className="threadListItemTitleText" style={{ fontSize: 12 }}>
                      {file.file_name}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
};
