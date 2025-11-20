import React, { useState, useEffect } from 'react';
import { Conversation } from '../../services/conversationsApi';
import { Project, ProjectFile, getProjectFiles } from '../../services/projectsApi';
import { ConversationsSidebar } from './ConversationsSidebar';
import { ConversationDetail } from './ConversationDetail';
import { generateDailyFeedbackTitle } from './utils';
import ManuscriptVersionCard from './ManuscriptVersionCard';
import './Conversations.css';

interface ConversationsPageProps {
  selectedProject: Project | null;
}

// Extended conversation type to support draft conversations
export interface DraftConversation extends Conversation {
  isDraft: true;
}

export function ConversationsPage({ selectedProject }: ConversationsPageProps) {
  const [selectedConversation, setSelectedConversation] =
    useState<Conversation | DraftConversation | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [manuscriptFile, setManuscriptFile] = useState<ProjectFile | null>(null);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);

  // Fetch project files when selectedProject changes
  useEffect(() => {
    const fetchManuscript = async () => {
      if (!selectedProject) {
        setManuscriptFile(null);
        return;
      }

      setIsLoadingFiles(true);
      try {
        const files = await getProjectFiles(selectedProject.id);
        // Find the primary manuscript
        const primaryManuscript = files.find(file => file.is_primary_manuscript);
        setManuscriptFile(primaryManuscript || null);
      } catch (error) {
        console.error('Failed to fetch project files:', error);
        setManuscriptFile(null);
      } finally {
        setIsLoadingFiles(false);
      }
    };

    fetchManuscript();
  }, [selectedProject]);

  const handleSelectConversation = (conversation: Conversation) => {
    setSelectedConversation(conversation);
  };

  const handleNewConversation = () => {
    // Create a draft conversation object that will be created on first message
    const draftConversation: DraftConversation = {
      id: -1, // Temporary ID to indicate draft
      agent_name: 'co_scientist',
      title: generateDailyFeedbackTitle(),
      summary: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      parent_id: selectedProject?.id || null,
      parent_type: 'Project',
      isDraft: true,
    };

    setSelectedConversation(draftConversation);
  };

  const handleConversationCreated = (newConversation: Conversation) => {
    // Replace draft with the real conversation
    setSelectedConversation(newConversation);
    // Trigger sidebar refresh
    setRefreshTrigger((prev) => prev + 1);
  };

  const handleConversationUpdate = () => {
    // Trigger sidebar refresh when a message is sent
    setRefreshTrigger((prev) => prev + 1);
  };

  if (!selectedProject) {
    return (
      <div className="conversationsPage empty">
        <div className="emptyState">
          <div className="emptyStateIcon">📁</div>
          <h3>No project selected</h3>
          <p>Please select a project to view conversations.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="conversationsPage">
      {/* Project Context Banner */}
      <div className="projectBanner">
        <div className="projectBannerContent">
          <div className="projectBannerInfo">
            <h3 className="projectBannerTitle">{selectedProject.name}</h3>
            {selectedProject.description && (
              <p className="projectBannerDescription">
                {selectedProject.description}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Manuscript Version Card */}
      {(manuscriptFile || isLoadingFiles) && (
        <ManuscriptVersionCard
          fileName={manuscriptFile?.file_name || ''}
          isLoading={isLoadingFiles}
        />
      )}

      {/* Main Content */}
      <div className="conversationsContent">
        {/* Sidebar */}
        <ConversationsSidebar
          projectId={selectedProject.id}
          selectedConversationId={selectedConversation?.id || null}
          onSelectConversation={handleSelectConversation}
          onNewConversation={handleNewConversation}
          refreshTrigger={refreshTrigger}
        />

        {/* Detail Panel */}
        <ConversationDetail
          conversation={selectedConversation}
          projectId={selectedProject.id}
          primaryManuscriptId={manuscriptFile?.id}
          onConversationCreated={handleConversationCreated}
          onConversationUpdate={handleConversationUpdate}
        />
      </div>
    </div>
  );
}
