import React, { useState, useEffect } from "react";
import { Conversation, DraftConversation } from "../types/conversation";
import { Project, ProjectFile, AgentRun } from "../types/project";
import { useConversationsApi } from "../api/useConversationsApi";
import { useProjectsApi } from "../api/useProjectsApi";
import { useApiClient } from "../context/ApiContext";
import { ConversationsSidebar } from "./ConversationsSidebar";
import { ConversationDetail } from "./ConversationDetail";
import { generateDailyFeedbackTitle } from "./utils";

export interface ConversationsPageProps {
  selectedProject: Project | null;
  onBack?: () => void;
  initialConversationId?: number | null;
  onConversationNavigated?: () => void;

  // Analytics callbacks (optional)
  onProjectView?: (projectId: number) => void;
  onTriggerFullReview?: (projectId: number, fileId: number) => void;
  onTriggerDiffReview?: (projectId: number, fileId: number) => void;
  onConversationView?: (
    projectId: number,
    conversationId: number,
    agentName: string,
  ) => void;
  onMessageSent?: (
    projectId: number,
    conversationId: number,
    agentName: string,
  ) => void;
  onMessageReceived?: (
    projectId: number,
    conversationId: number,
    agentName: string,
    durationSeconds?: number,
  ) => void;

  // Customization props
  renderManuscriptIcon?: () => React.ReactNode;
  feedbackFormUrl?: string;

  // Event subscription (for file sync events)
  fileSyncEventName?: string;

  // Folder sync status (optional)
  folderSyncStatus?: "watching" | "syncing" | "error" | "idle";
}

export function ConversationsPage({
  selectedProject,
  onBack,
  initialConversationId,
  onConversationNavigated,
  onProjectView,
  onTriggerFullReview,
  onTriggerDiffReview,
  onConversationView,
  onMessageSent,
  onMessageReceived,
  renderManuscriptIcon,
  feedbackFormUrl,
  fileSyncEventName,
  folderSyncStatus = "idle",
}: ConversationsPageProps) {
  const [selectedConversation, setSelectedConversation] = useState<
    Conversation | DraftConversation | null
  >(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [manuscriptFile, setManuscriptFile] = useState<ProjectFile | null>(
    null,
  );
  const [_isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isReviewInProgress, setIsReviewInProgress] = useState(false);
  const [pollInterval, setPollInterval] = useState<ReturnType<
    typeof setTimeout
  > | null>(null);
  const [hasConversations, setHasConversations] = useState(false);
  const [reviewingState, setReviewingState] = useState<
    "idle" | "full-reviewing" | "diff-reviewing"
  >("idle");
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [recentlySynced, setRecentlySynced] = useState(false);
  const [syncIndicatorTimeout, setSyncIndicatorTimeout] = useState<ReturnType<
    typeof setTimeout
  > | null>(null);
  const [isAutoReviewInProgress, setIsAutoReviewInProgress] = useState(false);

  const apiClient = useApiClient();
  const { getConversation } = useConversationsApi();
  const {
    getProjectFiles,
    getProjectStatus,
    triggerFullReview,
    triggerDiffReview,
  } = useProjectsApi();

  // Refresh manuscript file data
  const refreshManuscriptFile = async () => {
    if (!selectedProject) return;
    try {
      const files = await getProjectFiles(selectedProject.id);
      const primaryManuscript = files.find(
        (file) => file.is_primary_manuscript,
      );
      setManuscriptFile(primaryManuscript || null);
    } catch (error) {
      console.error("Failed to refresh manuscript file:", error);
    }
  };

  // Check if there are diffs since last review
  const hasDiffsSinceLastReview = (): boolean => {
    if (!manuscriptFile?.last_review) {
      return false;
    }
    const fileUpdate = new Date(manuscriptFile.updated_at);
    const lastReview = new Date(manuscriptFile.last_review.reviewed_at);
    const hasDiffs = fileUpdate > lastReview;
    return hasDiffs;
  };

  // Check for in-progress reviews on initial load
  useEffect(() => {
    if (!selectedProject || !manuscriptFile) return;

    const checkInitialReviewStatus = async () => {
      try {
        const status = await getProjectStatus(
          selectedProject.id,
          undefined,
          manuscriptFile.id,
        );

        // Check for any pending/processing runs
        const inProgressRuns = status.agent_runs.filter(
          (run: AgentRun) =>
            run.file_id === manuscriptFile.id &&
            (run.status === "pending" || run.status === "processing"),
        );

        if (inProgressRuns.length > 0) {
          setIsReviewInProgress(true);

          // Determine which type of review is in progress
          const hasFullReview = inProgressRuns.some((run: AgentRun) =>
            run.agent_name?.includes("full"),
          );
          const hasDiffReview = inProgressRuns.some((run: AgentRun) =>
            run.agent_name?.includes("diff"),
          );

          if (hasDiffReview) {
            setReviewingState("diff-reviewing");
          } else if (hasFullReview) {
            setReviewingState("full-reviewing");
          }

          // Start polling to track completion
          startPolling(manuscriptFile.id);
        }
      } catch (error) {
        console.error(
          "[ConversationsPage] Error checking initial review status:",
          error,
        );
      }
    };

    checkInitialReviewStatus();
  }, [selectedProject, manuscriptFile?.id]);

  // Check if review changes button should be shown
  const shouldShowReviewChangesButton = (): boolean => {
    // If we're actively reviewing (button clicked and showing "Reviewing..."), keep button visible
    if (reviewingState === "diff-reviewing") {
      return true;
    }

    // Hide if any other review is in progress (auto, full, etc)
    if (isReviewInProgress) return false;

    // Show only if there are diffs
    return hasDiffsSinceLastReview();
  };

  // Poll for review completion with exponential backoff
  const startPolling = (manuscriptId: number) => {
    setIsReviewInProgress(true);

    let pollCount = 0;
    const MAX_POLLS = 100; // Maximum 100 polls (~5 minutes with backoff)
    let currentDelay = 3000; // Start with 3 seconds

    const poll = async () => {
      if (pollCount >= MAX_POLLS) {
        setPollInterval(null);
        setIsReviewInProgress(false);
        setReviewingState("idle");
        return;
      }

      try {
        const status = await getProjectStatus(
          selectedProject!.id,
          undefined,
          manuscriptId,
        );
        // Check for recent agent runs (within last 5 minutes)
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        const recentRuns = status.agent_runs.filter((run: AgentRun) => {
          const createdAt = new Date(run.created_at);
          return run.file_id === manuscriptId && createdAt > fiveMinutesAgo;
        });

        if (recentRuns.length === 0) {
          setPollInterval(null);
          setIsReviewInProgress(false);
          setReviewingState("idle");
          return;
        }

        // Check if any runs are still in progress (pending or processing)
        const inProgressRuns = recentRuns.filter(
          (run: AgentRun) =>
            run.status === "pending" || run.status === "processing",
        );

        // Check if any in-progress runs are auto-scheduled
        const autoScheduledInProgress = inProgressRuns.some(
          (run: AgentRun) => run.review_data?.triggered_by === "auto_scheduler",
        );
        setIsAutoReviewInProgress(autoScheduledInProgress);
        if (inProgressRuns.length === 0) {
          // All recent runs are completed or failed
          setPollInterval(null);
          setIsReviewInProgress(false);
          setReviewingState("idle");
          setIsAutoReviewInProgress(false); // Reset auto review state

          // Refresh manuscript file data to get updated last_review
          await refreshManuscriptFile();
          // Refresh conversation list to show new review conversation
          setRefreshTrigger((prev) => prev + 1);
        } else {
          // Schedule next poll with exponential backoff
          pollCount++;
          currentDelay = Math.min(currentDelay * 1.5, 10000); // Max 10 seconds
          const timeoutId = setTimeout(poll, currentDelay);
          setPollInterval(timeoutId);
        }
      } catch (error) {
        console.error(
          "[ConversationsPage] Error polling review status:",
          error,
        );

        // On error, retry with backoff
        pollCount++;
        currentDelay = Math.min(currentDelay * 2, 10000);
        const timeoutId = setTimeout(poll, currentDelay);
        setPollInterval(timeoutId);
      }
    };

    // Start first poll
    poll();
  };

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollInterval) {
        clearTimeout(pollInterval);
      }
    };
  }, [pollInterval]);

  // Cleanup sync indicator timeout on unmount
  useEffect(() => {
    return () => {
      if (syncIndicatorTimeout) {
        clearTimeout(syncIndicatorTimeout);
      }
    };
  }, [syncIndicatorTimeout]);

  // Fetch project files when selectedProject changes
  useEffect(() => {
    const fetchManuscript = async () => {
      if (!selectedProject) {
        setManuscriptFile(null);
        return;
      }

      // Reset selected conversation when project changes
      setSelectedConversation(null);

      // Track analytics
      if (onProjectView) {
        onProjectView(selectedProject.id);
      }
      setIsLoadingFiles(true);
      try {
        const files = await getProjectFiles(selectedProject.id);
        // Find the primary manuscript
        const primaryManuscript = files.find(
          (file) => file.is_primary_manuscript,
        );
        if (primaryManuscript) {
          // Check if this is a newly synced manuscript with no review yet
          // If so, start polling immediately (backend auto-triggered review on first sync)
          if (!primaryManuscript.last_review) {
            startPolling(primaryManuscript.id);
          } else {
          }
        }

        setManuscriptFile(primaryManuscript || null);
      } catch (error) {
        console.error(
          "[ConversationsPage] ✗ Failed to fetch project files:",
          error,
        );
        setManuscriptFile(null);
      } finally {
        setIsLoadingFiles(false);
      }
    };

    fetchManuscript();
  }, [selectedProject]);

  // Listen for file sync events to refresh manuscript data and start polling
  useEffect(() => {
    if (
      !selectedProject ||
      !fileSyncEventName ||
      !apiClient.on ||
      !apiClient.removeListener
    )
      return;

    const handleFileSynced = (...args: unknown[]) => {
      const [_event, data] = args as [
        unknown,
        { projectId?: number; filePath?: string; action?: string },
      ];
      // Handle file sync for this project
      if (data.projectId === selectedProject.id) {
        getProjectFiles(selectedProject.id)
          .then((files) => {
            const primaryManuscript = files.find(
              (file) => file.is_primary_manuscript,
            );
            if (primaryManuscript) {
              // Compare timestamps to check if button should show
              if (
                primaryManuscript.last_review &&
                primaryManuscript.updated_at
              ) {
                const reviewDate = new Date(
                  primaryManuscript.last_review.reviewed_at,
                );
                const fileUpdateDate = new Date(primaryManuscript.updated_at);
              }

              // Check if the synced file is the manuscript
              const syncedFilePath = data.filePath;
              const manuscriptFileName = primaryManuscript.file_name;
              if (
                syncedFilePath &&
                syncedFilePath.includes(manuscriptFileName)
              ) {
                // Always start polling when manuscript is synced
                // Backend automatically triggers review for:
                // - First time sync (no last_review): full review
                // - Subsequent syncs (has last_review): full review (we let backend decide)
                startPolling(primaryManuscript.id);

                // Set recently synced indicator
                // Clear any existing timeout
                if (syncIndicatorTimeout) {
                  clearTimeout(syncIndicatorTimeout);
                }

                setRecentlySynced(true);
                // Clear indicator after 5 seconds
                const timeoutId = setTimeout(() => {
                  setRecentlySynced(false);
                  setSyncIndicatorTimeout(null);
                }, 5000);

                setSyncIndicatorTimeout(timeoutId);
              } else {
              }
            }

            setManuscriptFile(primaryManuscript || null);
          })
          .catch((error) => {
            console.error("[ConversationsPage] ✗ Error fetching files:", error);
          });
      } else {
      }
    };
    apiClient.on(fileSyncEventName, handleFileSynced);

    return () => {
      apiClient.removeListener!(fileSyncEventName, handleFileSynced);
    };
  }, [selectedProject, fileSyncEventName, apiClient]);

  // Handle initial conversation navigation from notification click
  useEffect(() => {
    if (!initialConversationId || !selectedProject) return;
    const fetchAndSelectConversation = async () => {
      try {
        const conversationDetail = await getConversation(
          initialConversationId,
          selectedProject.id,
        );
        if (conversationDetail) {
          // Convert to Conversation type (getConversation returns ConversationDetail which has messages)
          const { conversation } = conversationDetail;
          setSelectedConversation(conversation);
        } else {
          console.warn(
            "[ConversationsPage] Conversation not found:",
            initialConversationId,
          );
        }
      } catch (error) {
        console.error(
          "[ConversationsPage] Error fetching conversation for navigation:",
          error,
        );
      } finally {
        // Clear the pending navigation after handling
        if (onConversationNavigated) {
          onConversationNavigated();
        }
      }
    };

    fetchAndSelectConversation();
  }, [initialConversationId, selectedProject, onConversationNavigated]);

  const handleSelectConversation = (conversation: Conversation) => {
    setSelectedConversation(conversation);
  };

  const handleNewConversation = () => {
    // Create a draft conversation object that will be created on first message
    const draftConversation: DraftConversation = {
      id: -1, // Temporary ID to indicate draft
      agent_name: "co_scientist",
      title: generateDailyFeedbackTitle(),
      summary: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      parent_id: selectedProject?.id || null,
      parent_type: "Project",
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

  const handleConversationsLoaded = (conversations: Conversation[]) => {
    // Track if there are any conversations
    setHasConversations(conversations.length > 0);

    // Auto-select the first conversation if none is selected
    if (conversations.length > 0 && !selectedConversation) {
      setSelectedConversation(conversations[0]);
    }
  };

  const handleFullReview = async () => {
    if (!selectedProject || !manuscriptFile) {
      setReviewError("No manuscript file found");
      return;
    }

    // Track analytics
    if (onTriggerFullReview) {
      onTriggerFullReview(selectedProject.id, manuscriptFile.id);
    }
    setReviewingState("full-reviewing");
    setIsReviewInProgress(true);
    setReviewError(null);
    try {
      const response = await triggerFullReview(
        selectedProject.id,
        manuscriptFile.id,
      );
      // Start polling for completion
      startPolling(manuscriptFile.id);
    } catch (error: unknown) {
      const err = error as { message?: string };
      console.error(
        "[ConversationsPage] ❌ Error triggering full review:",
        error,
      );
      const errorMsg = err.message || "Failed to trigger full review";
      setReviewError(errorMsg);
      setReviewingState("idle");
      setIsReviewInProgress(false);
    }
  };

  const handleDiffReview = async () => {
    if (!selectedProject || !manuscriptFile) {
      setReviewError("No manuscript file found");
      return;
    }

    // Track analytics
    if (onTriggerDiffReview) {
      onTriggerDiffReview(selectedProject.id, manuscriptFile.id);
    }
    setReviewingState("diff-reviewing");
    setIsReviewInProgress(true);
    setReviewError(null);
    try {
      const response = await triggerDiffReview(
        selectedProject.id,
        manuscriptFile.id,
      );
      // Start polling for completion
      startPolling(manuscriptFile.id);
    } catch (error: unknown) {
      const err = error as { message?: string };
      console.error(
        "[ConversationsPage] ❌ Error triggering diff review:",
        error,
      );
      const errorMsg = err.message || "Failed to trigger diff review";
      setReviewError(errorMsg);
      setReviewingState("idle");
      setIsReviewInProgress(false);
    }
  };

  // Format manuscript update timestamp
  const formatManuscriptTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
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
      {/* New Header Layout */}
      <div className="conversationsHeader">
        <div className="headerLeft">
          <button className="backButton" onClick={onBack}>
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M15 18L9 12L15 6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <h1 className="projectTitle">{selectedProject.name}</h1>
        </div>
        {manuscriptFile && (
          <div className="headerManuscriptInfo">
            <div className="manuscriptInfoLeft">
              <span className="manuscriptLabel">Manuscript:</span>
              <div className="manuscriptFileIcon">
                {renderManuscriptIcon ? (
                  renderManuscriptIcon()
                ) : (
                  <span className="defaultManuscriptIcon">📄</span>
                )}
              </div>
              <div className="manuscriptFileDetails">
                <span className="manuscriptFileName">
                  {manuscriptFile.file_name}
                </span>
                <span className="manuscriptTimestamp">
                  {folderSyncStatus && folderSyncStatus !== "idle" && (
                    <span
                      className={`folderSyncIndicator folderSyncIndicator--${folderSyncStatus}`}
                      title={`Folders: ${folderSyncStatus === "watching" ? "Watching" : folderSyncStatus === "syncing" ? "Syncing" : "Error"}`}
                    />
                  )}
                  Last updated:{" "}
                  {formatManuscriptTimestamp(manuscriptFile.updated_at)}
                </span>
              </div>
            </div>
            <button
              className={`triggerFullReviewButton ${reviewingState === "full-reviewing" ? "reviewing" : ""}`}
              onClick={handleFullReview}
              disabled={reviewingState !== "idle" || isReviewInProgress}
            >
              {reviewingState === "full-reviewing"
                ? "Reviewing..."
                : "Trigger Full Review"}
            </button>
            {shouldShowReviewChangesButton() && (
              <button
                className={`reviewChangesButton ${recentlySynced ? "recently-synced" : ""} ${reviewingState === "diff-reviewing" ? "reviewing" : ""}`}
                onClick={handleDiffReview}
                disabled={reviewingState !== "idle" || isReviewInProgress}
              >
                {reviewingState === "diff-reviewing"
                  ? "Reviewing..."
                  : "Review Changes"}
                {recentlySynced && reviewingState === "idle" && (
                  <span className="sync-indicator"></span>
                )}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Review Error */}
      {reviewError && <div className="reviewErrorMessage">{reviewError}</div>}

      {/* Manuscript Feedback Section - Hide when review is in progress with no conversations */}
      {!(isReviewInProgress && !hasConversations) && (
        <div className="manuscriptFeedbackSection">
          <h2 className="manuscriptFeedbackTitle">Manuscript feedback</h2>

          <div className="conversationsContent">
            {/* Sidebar */}
            <ConversationsSidebar
              projectId={selectedProject.id}
              selectedConversationId={selectedConversation?.id || null}
              onSelectConversation={handleSelectConversation}
              onNewConversation={handleNewConversation}
              refreshTrigger={refreshTrigger}
              onConversationsLoaded={handleConversationsLoaded}
              onConversationView={onConversationView}
            />

            {/* Detail Panel */}
            <ConversationDetail
              conversation={selectedConversation}
              projectId={selectedProject.id}
              primaryManuscriptId={manuscriptFile?.id}
              manuscriptFile={manuscriptFile}
              onConversationCreated={handleConversationCreated}
              onConversationUpdate={handleConversationUpdate}
              isReviewInProgress={isReviewInProgress}
              onMessageSent={onMessageSent}
              onMessageReceived={onMessageReceived}
              feedbackFormUrl={feedbackFormUrl}
            />
          </div>
        </div>
      )}

      {/* Show review in progress message when no conversations exist */}
      {isReviewInProgress && !hasConversations && (
        <div className="emptyStateContainer">
          <div className="emptyState">
            <div className="emptyStateIcon">⏳</div>
            <h3>Review in progress</h3>
            <p>
              Your manuscript is being reviewed. This may take a few minutes.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
