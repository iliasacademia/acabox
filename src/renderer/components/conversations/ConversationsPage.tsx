import React, { useState, useEffect } from 'react';
import { Conversation } from '../../services/conversationsApi';
import { Project, ProjectFile, getProjectFiles, getProjectStatus } from '../../services/projectsApi';
import { ConversationsSidebar } from './ConversationsSidebar';
import { ConversationDetail } from './ConversationDetail';
import { generateDailyFeedbackTitle } from './utils';
import ManuscriptVersionCard from './ManuscriptVersionCard';
import { IPC_CHANNELS } from '../../../shared/types';
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
  const [isReviewInProgress, setIsReviewInProgress] = useState(false);
  const [pollInterval, setPollInterval] = useState<NodeJS.Timeout | null>(null);

  // Refresh manuscript file data
  const refreshManuscriptFile = async () => {
    if (!selectedProject) return;

    console.log('[ConversationsPage] Refreshing manuscript file data');
    try {
      const files = await getProjectFiles(selectedProject.id);
      const primaryManuscript = files.find(file => file.is_primary_manuscript);
      setManuscriptFile(primaryManuscript || null);
      console.log('[ConversationsPage] Manuscript file refreshed:', primaryManuscript);
    } catch (error) {
      console.error('Failed to refresh manuscript file:', error);
    }
  };

  // Poll for review completion
  const startPolling = (manuscriptId: number) => {
    console.log('[ConversationsPage] Starting review status polling for manuscript:', manuscriptId);
    setIsReviewInProgress(true);

    const interval = setInterval(async () => {
      try {
        const status = await getProjectStatus(selectedProject!.id, 'science_agent', manuscriptId);
        console.log('[ConversationsPage] Poll result:', status);

        // Check for recent agent runs (within last 5 minutes)
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        const recentRuns = status.agent_runs.filter(run => {
          const createdAt = new Date(run.created_at);
          return run.file_id === manuscriptId && createdAt > fiveMinutesAgo;
        });

        if (recentRuns.length === 0) {
          console.log('[ConversationsPage] No recent runs found, stopping poll');
          clearInterval(interval);
          setPollInterval(null);
          setIsReviewInProgress(false);
          return;
        }

        // Check if any runs are still processing
        const processingRuns = recentRuns.filter(run => run.status === 'processing');

        if (processingRuns.length === 0) {
          // All recent runs are completed or failed
          console.log('[ConversationsPage] All recent runs completed');
          clearInterval(interval);
          setPollInterval(null);
          setIsReviewInProgress(false);

          // Refresh manuscript file data to get updated last_review
          await refreshManuscriptFile();

          // Refresh conversation list to show new review conversation
          setRefreshTrigger(prev => prev + 1);
        } else {
          console.log('[ConversationsPage] Still processing:', processingRuns.length, 'runs');
        }
      } catch (error) {
        console.error('[ConversationsPage] Error polling review status:', error);
      }
    }, 3000); // Poll every 3 seconds

    setPollInterval(interval);
  };

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollInterval) {
        clearInterval(pollInterval);
      }
    };
  }, [pollInterval]);

  // Fetch project files when selectedProject changes
  useEffect(() => {
    const fetchManuscript = async () => {
      if (!selectedProject) {
        setManuscriptFile(null);
        return;
      }

      console.log('========================================');
      console.log('[ConversationsPage] Initial fetch for project:', selectedProject.id);
      setIsLoadingFiles(true);
      try {
        const files = await getProjectFiles(selectedProject.id);
        console.log('[ConversationsPage] Fetched', files.length, 'files');

        // Find the primary manuscript
        const primaryManuscript = files.find(file => file.is_primary_manuscript);
        console.log('[ConversationsPage] Primary manuscript:', primaryManuscript);

        if (primaryManuscript) {
          console.log('[ConversationsPage] Initial manuscript details:');
          console.log('  - File ID:', primaryManuscript.id);
          console.log('  - File name:', primaryManuscript.file_name);
          console.log('  - Updated at:', primaryManuscript.updated_at);
          console.log('  - Last review:', primaryManuscript.last_review);
        }

        setManuscriptFile(primaryManuscript || null);
        console.log('[ConversationsPage] ✓ Initial manuscript file state set');
      } catch (error) {
        console.error('[ConversationsPage] ✗ Failed to fetch project files:', error);
        setManuscriptFile(null);
      } finally {
        setIsLoadingFiles(false);
      }
      console.log('========================================');
    };

    fetchManuscript();
  }, [selectedProject]);

  // Listen for file sync events to refresh manuscript data and start polling
  useEffect(() => {
    if (!selectedProject) return;

    const handleFileSynced = (_event: any, data: any) => {
      console.log('========================================');
      console.log('[ConversationsPage] File synced event received:', JSON.stringify(data, null, 2));
      console.log('[ConversationsPage] Current project ID:', selectedProject.id);
      console.log('[ConversationsPage] Event project ID:', data.projectId);
      console.log('[ConversationsPage] Project IDs match:', data.projectId === selectedProject.id);

      // Handle file sync for this project
      if (data.projectId === selectedProject.id) {
        console.log('[ConversationsPage] ✓ Project IDs match - Refetching manuscript after file sync');
        console.log('[ConversationsPage] Current manuscript file before refresh:', manuscriptFile);

        getProjectFiles(selectedProject.id).then(files => {
          console.log('[ConversationsPage] Received files from API:', files.length, 'files');
          const primaryManuscript = files.find(file => file.is_primary_manuscript);
          console.log('[ConversationsPage] Primary manuscript found:', primaryManuscript);

          if (primaryManuscript) {
            console.log('[ConversationsPage] Manuscript details:');
            console.log('  - File ID:', primaryManuscript.id);
            console.log('  - File name:', primaryManuscript.file_name);
            console.log('  - Updated at:', primaryManuscript.updated_at);
            console.log('  - Last review:', primaryManuscript.last_review);

            // Check if the synced file is the manuscript
            const syncedFilePath = data.filePath;
            const manuscriptFileName = primaryManuscript.file_name;

            console.log('[ConversationsPage] Synced file path:', syncedFilePath);
            console.log('[ConversationsPage] Manuscript file name:', manuscriptFileName);

            if (syncedFilePath && syncedFilePath.includes(manuscriptFileName)) {
              console.log('[ConversationsPage] ✓ Synced file is the manuscript - starting review polling');
              console.log('[ConversationsPage] Event action:', data.action);
              console.log('[ConversationsPage] Has last_review:', !!primaryManuscript.last_review);

              // Always start polling when manuscript is synced
              // Backend automatically triggers review for:
              // - First time sync (no last_review): full review
              // - Subsequent syncs (has last_review): full review (we let backend decide)
              startPolling(primaryManuscript.id);
            } else {
              console.log('[ConversationsPage] Synced file is not the manuscript');
            }
          }

          setManuscriptFile(primaryManuscript || null);
          console.log('[ConversationsPage] ✓ Manuscript file state updated');
        }).catch(error => {
          console.error('[ConversationsPage] ✗ Error fetching files:', error);
        });
      } else {
        console.log('[ConversationsPage] ✗ Project IDs do not match - ignoring event');
      }
      console.log('========================================');
    };

    console.log('[ConversationsPage] Setting up file sync event listener for project:', selectedProject.id);
    window.electronAPI.on(IPC_CHANNELS.PROJECT_FILE_SYNCED, handleFileSynced);

    return () => {
      console.log('[ConversationsPage] Removing file sync event listener for project:', selectedProject.id);
      window.electronAPI.removeListener(IPC_CHANNELS.PROJECT_FILE_SYNCED, handleFileSynced);
    };
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
        <>
          <ManuscriptVersionCard
            fileName={manuscriptFile?.file_name || ''}
            isLoading={isLoadingFiles}
            projectId={selectedProject.id}
            manuscriptId={manuscriptFile?.id}
            lastReview={manuscriptFile?.last_review}
            fileUpdatedAt={manuscriptFile?.updated_at}
            onReviewComplete={refreshManuscriptFile}
          />
          {isReviewInProgress && (
            <div className="reviewingIndicator">
              <span className="reviewingDot"></span>
              <span className="reviewingText">Reviewing manuscript...</span>
            </div>
          )}
        </>
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
          manuscriptFile={manuscriptFile}
          onConversationCreated={handleConversationCreated}
          onConversationUpdate={handleConversationUpdate}
        />
      </div>
    </div>
  );
}
