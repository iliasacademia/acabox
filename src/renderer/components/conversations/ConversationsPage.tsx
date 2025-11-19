import React, { useState } from 'react';
import { Conversation, createConversation } from '../../services/conversationsApi';
import { Project } from '../../services/projectsApi';
import { ConversationsSidebar } from './ConversationsSidebar';
import { ConversationDetail } from './ConversationDetail';
import './Conversations.css';

interface ConversationsPageProps {
  selectedProject: Project | null;
}

export function ConversationsPage({ selectedProject }: ConversationsPageProps) {
  const [selectedConversation, setSelectedConversation] =
    useState<Conversation | null>(null);
  const [isDraftMode, setIsDraftMode] = useState(false);
  const [draftContent, setDraftContent] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const handleSelectConversation = (conversation: Conversation) => {
    setSelectedConversation(conversation);
    setIsDraftMode(false);
    setDraftContent('');
    setCreateError(null);
  };

  const handleNewConversation = () => {
    setIsDraftMode(true);
    setSelectedConversation(null);
    setDraftContent('');
    setCreateError(null);
  };

  const handleCreateConversation = async (content: string) => {
    if (!selectedProject || !content.trim()) return;

    setIsCreating(true);
    setCreateError(null);

    try {
      const newConversation = await createConversation(
        content.trim(),
        'co_scientist', // Default agent name
        selectedProject.id
      );

      // Switch to the new conversation
      setSelectedConversation(newConversation);
      setIsDraftMode(false);
      setDraftContent('');

      // Trigger sidebar refresh
      setRefreshTrigger((prev) => prev + 1);
    } catch (err: any) {
      console.error('Failed to create conversation:', err);
      setCreateError(err.message || 'Failed to create conversation');
    } finally {
      setIsCreating(false);
    }
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
          <span className="projectBannerIcon">📁</span>
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
        {isDraftMode ? (
          <div className="conversationDraft">
            <div className="draftHeader">
              <h2>New Conversation</h2>
              <button className="draftCancelButton" onClick={() => setIsDraftMode(false)}>
                Cancel
              </button>
            </div>

            <div className="draftContent">
              <p className="draftInstructions">
                Start a conversation with Co-Scientist. Ask questions about your
                project, request help with analysis, or explore your research.
              </p>

              {createError && (
                <div className="draftError">
                  <span className="errorIcon">⚠️</span>
                  <span>{createError}</span>
                </div>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleCreateConversation(draftContent);
                }}
              >
                <textarea
                  className="draftInput"
                  value={draftContent}
                  onChange={(e) => setDraftContent(e.target.value)}
                  placeholder="What would you like to know or work on?"
                  rows={6}
                  disabled={isCreating}
                  autoFocus
                />

                <button
                  type="submit"
                  className="draftSubmitButton"
                  disabled={!draftContent.trim() || isCreating}
                >
                  {isCreating ? 'Creating...' : 'Start Conversation'}
                </button>
              </form>
            </div>
          </div>
        ) : (
          <ConversationDetail
            conversation={selectedConversation}
            projectId={selectedProject.id}
            onConversationUpdate={handleConversationUpdate}
          />
        )}
      </div>
    </div>
  );
}
