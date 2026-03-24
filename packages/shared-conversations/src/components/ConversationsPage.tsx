import React, { useState, useEffect, useRef, useCallback } from "react";
import type { UseConversationPollingOptions } from "../hooks/useConversationPolling";
import { Conversation, DraftConversation } from "../types/conversation";
import { Project, ProjectFile, AgentRun } from "../types/project";
import { SupportingMaterial } from "../types/supportingMaterials";
import { useConversationsApi } from "../api/useConversationsApi";
import { useProjectsApi } from "../api/useProjectsApi";
import { useSupportingMaterialsApi } from "../api/useSupportingMaterialsApi";
import { useApiClient } from "../context/ApiContext";
import { ConversationsSidebar } from "./ConversationsSidebar";
import { ConversationDetail } from "./ConversationDetail";
import { SupportingMaterialsContent } from "./SupportingMaterialsContent";
import type { ZoteroStatusProps } from "./SupportingMaterialsContent";
import { useWindowSize } from "../hooks/useWindowSize";
import { useSidebarCollapse } from "../hooks/useSidebarCollapse";
import { useUserPreferences } from "../../../../src/renderer/contexts/UserPreferencesContext";
import { useCoScientistEvents } from "../../../../src/renderer/hooks/useCoScientistEvents";
import { getZoteroStatus, getZoteroAuthorizeUrl, syncZotero, disconnectZotero } from "../../../../src/renderer/services/zoteroApi";
import { IPC_CHANNELS } from "../../../../src/shared/types";

export interface ConversationsPageProps {
  selectedProject: Project | null;
  nonProjectConversations?: boolean;
  onBack?: () => void;
  initialConversationId?: number | null;
  initialView?: 'conversation' | 'supporting-materials';
  onConversationNavigated?: () => void;
  initialOpenDiffModal?: boolean;
  onDiffModalOpened?: () => void;

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
    projectId: number | null,
    conversationId: number,
    agentName: string,
  ) => void;
  onMessageReceived?: (
    projectId: number | null,
    conversationId: number,
    agentName: string,
    durationSeconds?: number,
  ) => void;

  // Customization props
  renderManuscriptIcon?: () => React.ReactNode;
  feedbackFormUrl?: string;
  hideBackButton?: boolean;
  hideOpenButton?: boolean;
  hideReviewButton?: boolean;
  hideSwitchManuscriptButton?: boolean;

  // Event subscription (for file sync events)
  fileSyncEventName?: string;

  // Folder sync status (optional)
  folderSyncStatus?: "watching" | "syncing" | "error" | "idle";

  // Polling options (for event-driven message updates)
  pollingOptions?: UseConversationPollingOptions;

  // Event-driven conversations list refresh
  onRegisterConversationsRefresh?: (refreshFn: () => void) => () => void;

  // Event-driven review state updates (for review_started, review_completed, review_failed events)
  onRegisterReviewStateUpdates?: (
    updateFn: (state: "idle" | "full-reviewing" | "diff-reviewing") => void,
  ) => () => void;
}

export function ConversationsPage({
  selectedProject,
  nonProjectConversations,
  onBack,
  initialConversationId,
  onConversationNavigated,
  initialOpenDiffModal,
  onDiffModalOpened,
  onProjectView,
  onTriggerFullReview,
  onTriggerDiffReview,
  onConversationView,
  onMessageSent,
  onMessageReceived,
  renderManuscriptIcon,
  feedbackFormUrl,
  hideBackButton,
  hideOpenButton,
  hideReviewButton,
  hideSwitchManuscriptButton,
  fileSyncEventName,
  folderSyncStatus = "idle",
  pollingOptions,
  onRegisterConversationsRefresh,
  onRegisterReviewStateUpdates,
  initialView,
}: ConversationsPageProps) {
  // Selected view type: conversation or supporting-materials
  const [selectedView, setSelectedView] = useState<'conversation' | 'supporting-materials'>(initialView ?? 'conversation');
  const [supportingMaterials, setSupportingMaterials] = useState<SupportingMaterial[]>([]);
  const [supportingMaterialsLoading, setSupportingMaterialsLoading] = useState(false);
  const [fileUploadEvent, setFileUploadEvent] = useState<{ file: any; timestamp: number } | null>(null);
  const [zoteroSyncEvent, setZoteroSyncEvent] = useState<{ timestamp: number } | null>(null);
  const [supportingMaterialsTotalCount, setSupportingMaterialsTotalCount] = useState(0);

  const [selectedConversation, setSelectedConversation] = useState<
    Conversation | DraftConversation | null
  >(null);
  const [isSelectedConversationArchived, setIsSelectedConversationArchived] = useState(false);
  const [draftConversation, setDraftConversation] = useState<DraftConversation | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [manuscriptFile, setManuscriptFile] = useState<ProjectFile | null>(
    null,
  );
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isReviewInProgress, setIsReviewInProgress] = useState(false);
  const [pollInterval, setPollInterval] = useState<ReturnType<
    typeof setTimeout
  > | null>(null);
  const [hasConversations, setHasConversations] = useState(false);
  const [reviewingState, setReviewingState] = useState<
    "idle" | "full-reviewing" | "diff-reviewing" | "pending-scheduled"
  >("idle");
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [recentlySynced, setRecentlySynced] = useState(false);
  const [syncIndicatorTimeout, setSyncIndicatorTimeout] = useState<ReturnType<
    typeof setTimeout
  > | null>(null);
  const [isAutoReviewInProgress, setIsAutoReviewInProgress] = useState(false);
  const [scheduledReviewTime, setScheduledReviewTime] = useState<Date | null>(
    null,
  );
  const [showOpenDropdown, setShowOpenDropdown] = useState(false);
  const [showReviewDropdown, setShowReviewDropdown] = useState(false);
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [fileExistsLocally, setFileExistsLocally] = useState(true);
  const [isSwitchingManuscript, setIsSwitchingManuscript] = useState(false);
  const [switchSuccessMessage, setSwitchSuccessMessage] = useState<string | null>(null);
  const [pendingConversationId, setPendingConversationId] = useState<number | null>(null);

  // Zotero state
  const [zoteroStatus, setZoteroStatus] = useState<ZoteroStatusProps | null>(null);
  const [isZoteroStatusLoading, setIsZoteroStatusLoading] = useState(false);
  const [isZoteroPolling, setIsZoteroPolling] = useState(false);
  const [isZoteroSyncing, setIsZoteroSyncing] = useState(false);
  const [isZoteroDisconnecting, setIsZoteroDisconnecting] = useState(false);
  const zoteroPollerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoteroPollingStartRef = useRef<number>(0);

  const apiClient = useApiClient();

  // Get user preferences for auto diff review
  const { preferences } = useUserPreferences();

  // Responsive sidebar collapse
  const windowSize = useWindowSize();
  const { collapsed, toggleCollapsed } = useSidebarCollapse(windowSize.width);
  const {
    getProjectFiles,
    getProjectStatus,
    triggerFullReview,
    triggerDiffReview,
    switchManuscript,
  } = useProjectsApi();

  const { getSupportingMaterials } = useSupportingMaterialsApi();

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

  // Fetch supporting materials
  const refreshSupportingMaterials = async () => {
    if (!selectedProject) return;
    setSupportingMaterialsLoading(true);
    try {
      const { materials, totalCount } = await getSupportingMaterials(selectedProject.id);
      setSupportingMaterials(materials);
      setSupportingMaterialsTotalCount(totalCount);
    } catch (error) {
      console.error("Failed to refresh supporting materials:", error);
    } finally {
      setSupportingMaterialsLoading(false);
    }
  };

  // Fetch supporting materials when project changes
  useEffect(() => {
    if (selectedProject) {
      refreshSupportingMaterials();
    }
  }, [selectedProject]);

  // Fetch Zotero status on mount
  useEffect(() => {
    setIsZoteroStatusLoading(true);
    getZoteroStatus().then(setZoteroStatus).finally(() => setIsZoteroStatusLoading(false));
  }, []);

  const stopZoteroPolling = useCallback(() => {
    if (zoteroPollerRef.current) {
      clearTimeout(zoteroPollerRef.current);
      zoteroPollerRef.current = null;
    }
    setIsZoteroPolling(false);
  }, []);

  const startZoteroPolling = useCallback(() => {
    const MAX_POLL_DURATION_MS = 5 * 60 * 1000;
    const POLL_INTERVAL_MS = 3000;
    setIsZoteroPolling(true);
    zoteroPollingStartRef.current = Date.now();

    const poll = async () => {
      if (Date.now() - zoteroPollingStartRef.current > MAX_POLL_DURATION_MS) {
        stopZoteroPolling();
        return;
      }
      const status = await getZoteroStatus();
      setZoteroStatus(status);
      if (status.connected) {
        stopZoteroPolling();
        return;
      }
      zoteroPollerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
    };

    zoteroPollerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
  }, [stopZoteroPolling]);

  const handleConnectZotero = useCallback(() => {
    const url = getZoteroAuthorizeUrl();
    window.electronAPI.invoke(IPC_CHANNELS.OPEN_EXTERNAL_URL, url);
    startZoteroPolling();
  }, [startZoteroPolling]);

  const handleSyncZotero = useCallback(async () => {
    setIsZoteroSyncing(true);
    const previousSyncedAt = zoteroStatus?.last_synced_at ?? null;
    try {
      await syncZotero();
      const pollStart = Date.now();
      const MAX_POLL = 5 * 60 * 1000;
      const INTERVAL = 3000;
      const pollForSync = async () => {
        const status = await getZoteroStatus();
        setZoteroStatus(status);
        if (status.last_synced_at !== previousSyncedAt || Date.now() - pollStart > MAX_POLL) {
          setIsZoteroSyncing(false);
          return;
        }
        setTimeout(pollForSync, INTERVAL);
      };
      setTimeout(pollForSync, INTERVAL);
    } catch {
      setIsZoteroSyncing(false);
    }
  }, [zoteroStatus]);

  const handleDisconnectZotero = useCallback(async () => {
    setIsZoteroDisconnecting(true);
    try {
      await disconnectZotero();
      const status = await getZoteroStatus();
      setZoteroStatus(status);
    } finally {
      setIsZoteroDisconnecting(false);
    }
  }, []);

  // Listen for file upload events to refresh materials
  useCoScientistEvents({
    onFileUploadCompleted: (event) => {
      console.log('[ConversationsPage] File upload completed:', event.data);
      // Pass the file data to SupportingMaterialsContent to update in-place
      if (event.data?.file) {
        setFileUploadEvent({
          file: event.data.file,
          timestamp: Date.now(),
        });
      }
      // Each completed file event increments the count — correct for multiple files
      setSupportingMaterialsTotalCount((prev) => prev + 1);
    },
    onFileUploadFailed: (event) => {
      console.log('[ConversationsPage] File upload failed:', event.data);
      // Pass the failure event to SupportingMaterialsContent
      if (event.data?.file_id) {
        setFileUploadEvent({
          file: { id: event.data.file_id, status: 'failed' },
          timestamp: Date.now(),
        });
      }
    },
    onZoteroFileSynced: (event) => {
      console.log('[ConversationsPage] Zotero file synced:', event.data);
      setZoteroSyncEvent({ timestamp: Date.now() });
      refreshSupportingMaterials();
    },
    onZoteroDisconnected: () => {
      console.log('[ConversationsPage] Zotero disconnected');
      getZoteroStatus().then(setZoteroStatus);
      setZoteroSyncEvent({ timestamp: Date.now() });
      refreshSupportingMaterials();
    },
  });

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

          // Separate pending from processing runs
          const pendingRuns = inProgressRuns.filter(
            (run: AgentRun) => run.status === "pending",
          );

          // Check if there are pending auto-scheduled diff reviews
          // (only auto-scheduled reviews have a delay; manual reviews are immediate)
          const pendingAutoScheduledReviews = pendingRuns.filter(
            (run: AgentRun) =>
              (run.agent_name?.includes("diff") ||
                run.agent_name === "science_agent") &&
              run.review_data?.triggered_by === "auto_scheduler",
          );

          if (pendingAutoScheduledReviews.length > 0) {
            // Auto-scheduled diff review is waiting for its scheduled time - show pending state
            const pendingRun = pendingAutoScheduledReviews[0];
            setReviewingState("pending-scheduled");
            setScheduledReviewTime(new Date(pendingRun.created_at));
          } else {
            // Job is currently processing or is a full review - determine type
            const hasFullReview = inProgressRuns.some((run: AgentRun) =>
              run.agent_name?.includes("full"),
            );
            const hasDiffReview = inProgressRuns.some(
              (run: AgentRun) =>
                run.agent_name?.includes("diff") ||
                run.agent_name === "science_agent",
            );

            if (hasDiffReview) {
              setReviewingState("diff-reviewing");
            } else if (hasFullReview) {
              setReviewingState("full-reviewing");
            }
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

    // Show if review is pending (scheduled but not yet started)
    if (reviewingState === "pending-scheduled") {
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

        // Separate pending from processing runs
        const pendingRuns = inProgressRuns.filter(
          (run: AgentRun) => run.status === "pending",
        );

        const processingRuns = inProgressRuns.filter(
          (run: AgentRun) => run.status === "processing",
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
          setScheduledReviewTime(null);
          setIsAutoReviewInProgress(false); // Reset auto review state

          // Refresh manuscript file data to get updated last_review
          await refreshManuscriptFile();
          // Refresh conversation list to show new review conversation
          setRefreshTrigger((prev) => prev + 1);
        } else if (pendingRuns.length > 0) {
          // Check if pending run is an auto-scheduled diff review
          // (only auto-scheduled reviews have a delay; manual reviews are immediate)
          const pendingAutoScheduledReviews = pendingRuns.filter(
            (run: AgentRun) =>
              (run.agent_name?.includes("diff") ||
                run.agent_name === "science_agent") &&
              run.review_data?.triggered_by === "auto_scheduler",
          );

          if (pendingAutoScheduledReviews.length > 0) {
            // Auto-scheduled diff review is still waiting - update scheduled time if needed
            const pendingRun = pendingAutoScheduledReviews[0];
            if (reviewingState !== "pending-scheduled") {
              setReviewingState("pending-scheduled");
              setScheduledReviewTime(new Date(pendingRun.created_at));
            }
          } else {
            // Manual review or full review - determine type and set to reviewing
            const hasFullReview = pendingRuns.some((run: AgentRun) =>
              run.agent_name?.includes("full"),
            );
            const hasDiffReview = pendingRuns.some(
              (run: AgentRun) =>
                run.agent_name?.includes("diff") ||
                run.agent_name === "science_agent",
            );

            if (hasDiffReview) {
              setReviewingState("diff-reviewing");
            } else if (hasFullReview) {
              setReviewingState("full-reviewing");
            }
          }

          // Schedule next poll with exponential backoff
          pollCount++;
          currentDelay = Math.min(currentDelay * 1.5, 10000); // Max 10 seconds
          const timeoutId = setTimeout(poll, currentDelay);
          setPollInterval(timeoutId);
        } else if (processingRuns.length > 0) {
          // Transitioned to processing - clear scheduled time
          if (reviewingState === "pending-scheduled") {
            setScheduledReviewTime(null);
          }

          // Determine which type of review is processing
          const hasFullReview = processingRuns.some((run: AgentRun) =>
            run.agent_name?.includes("full"),
          );
          const hasDiffReview = processingRuns.some(
            (run: AgentRun) =>
              run.agent_name?.includes("diff") ||
              run.agent_name === "science_agent",
          );

          if (hasDiffReview) {
            setReviewingState("diff-reviewing");
          } else if (hasFullReview) {
            setReviewingState("full-reviewing");
          }

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

  // Countdown timer for pending scheduled reviews
  useEffect(() => {
    if (reviewingState !== "pending-scheduled" || !scheduledReviewTime) {
      return;
    }

    // Update every 30 seconds
    const intervalId = setInterval(() => {
      // Force re-render to update countdown display
      setScheduledReviewTime(new Date(scheduledReviewTime));
    }, 30000);

    return () => clearInterval(intervalId);
  }, [reviewingState, scheduledReviewTime]);

  // Register event-driven review state updates
  useEffect(() => {
    if (!onRegisterReviewStateUpdates) return;

    console.log("[ConversationsPage] Registering review state updates");
    const cleanup = onRegisterReviewStateUpdates((state) => {
      console.log("[ConversationsPage] Review state updated via event:", state);
      setReviewingState(state);
      if (state === "idle") {
        setIsReviewInProgress(false);
      } else {
        setIsReviewInProgress(true);
      }
    });

    return cleanup;
  }, [onRegisterReviewStateUpdates]);

  // Close dropdowns when clicking outside
  useEffect(() => {
    if (!showOpenDropdown && !showReviewDropdown) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.dropdownContainer')) {
        setShowOpenDropdown(false);
        setShowReviewDropdown(false);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [showOpenDropdown, showReviewDropdown]);

  // Check if manuscript file exists locally
  useEffect(() => {
    if (manuscriptFile?.file_path) {
      checkFileExists(manuscriptFile.file_path);
    } else {
      setFileExistsLocally(false);
    }
  }, [manuscriptFile?.file_path]);

  // Fetch project files when selectedProject changes
  useEffect(() => {
    const fetchManuscript = async () => {
      if (!selectedProject) {
        setManuscriptFile(null);
        return;
      }

      // Reset selected conversation when project changes
      setSelectedConversation(null);
      setConversationsLoaded(false);

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
                // Check user preference before starting auto diff review
                if (preferences.auto_diff_review) {
                  // Start polling when manuscript is synced
                  // Backend automatically triggers review for:
                  // - First time sync (no last_review): full review
                  // - Subsequent syncs (has last_review): full review (we let backend decide)
                  startPolling(primaryManuscript.id);
                } else {
                  console.log('[ConversationsPage] Auto diff review disabled by user preference');
                }

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
  // Store the ID to select once conversations are loaded
  useEffect(() => {
    if (initialConversationId) {
      setPendingConversationId(initialConversationId);
    }
  }, [initialConversationId]);

  const handleSelectConversation = (conversation: Conversation) => {
    setSelectedConversation(conversation);
  };

  const handleNewConversation = () => {
    const draft: DraftConversation = {
      id: -1,
      agent_name: "co_scientist",
      title: "New Conversation",
      summary: null,
      created_at: '',
      updated_at: '',
      parent_id: selectedProject?.id || null,
      parent_type: selectedProject ? "Project" : null,
      isDraft: true,
    };
    setDraftConversation(draft);
    setSelectedConversation(draft);
  };

  const handleConversationCreated = (newConversation: Conversation) => {
    // Switch selection to real conversation but keep draft in sidebar
    // until the refresh completes — update draft with server timestamp so it appears now
    setSelectedConversation(newConversation);
    setDraftConversation((prev) =>
      prev ? { ...prev, created_at: newConversation.created_at } : null
    );
    setRefreshTrigger((prev) => prev + 1);
  };

  const handleSidebarRefreshComplete = (conversations: Conversation[]) => {
    // Once the refreshed list is loaded, the real conversation is in the sidebar — clear draft
    setDraftConversation(null);
    setHasConversations(conversations.length > 0);
  };

  const handleConversationUpdate = () => {
    // Trigger sidebar refresh when a message is sent
    setRefreshTrigger((prev) => prev + 1);
  };

  const handleConversationsLoaded = (conversations: Conversation[]) => {
    // Track if there are any conversations
    setHasConversations(conversations.length > 0);
    setConversationsLoaded(true);

    // If we have a pending conversation ID (from notification), select it from the list
    if (pendingConversationId && conversations.length > 0) {
      const targetConversation = conversations.find(c => c.id === pendingConversationId);
      if (targetConversation) {
        setSelectedConversation(targetConversation);
        setPendingConversationId(null);
        // Clear the pending navigation after handling
        if (onConversationNavigated) {
          onConversationNavigated();
        }
      } else {
        console.warn(
          "[ConversationsPage] Conversation not found in list:",
          pendingConversationId,
        );
      }
      return;
    }

    // Auto-select the first conversation if none is selected
    if (conversations.length > 0 && !selectedConversation) {
      setSelectedConversation(prev => prev || conversations[0]);
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

  const checkFileExists = async (filePath: string) => {
    if (!filePath) {
      setFileExistsLocally(false);
      return false;
    }

    try {
      // Check if file exists via IPC
      if (!window.electronAPI?.invoke) {
        // If electronAPI is not available, default to true
        setFileExistsLocally(true);
        return true;
      }

      const result = await window.electronAPI.invoke('check-file-exists', filePath);
      const exists = result?.exists ?? true; // Default to true if check fails
      setFileExistsLocally(exists);
      console.log('[ConversationsPage] File exists check:', { filePath, exists });
      return exists;
    } catch (error) {
      console.error("[ConversationsPage] Failed to check file existence:", error);
      // Default to true so buttons aren't unnecessarily disabled
      setFileExistsLocally(true);
      return true;
    }
  };

  const handleOpenFile = async (filePath: string) => {
    if (!filePath) return;

    try {
      // Call IPC through the API client
      await apiClient.invoke({
        method: "POST",
        endpoint: "open-file",
        data: { filePath },
      });
    } catch (error) {
      console.error("[ConversationsPage] Failed to open file:", error);
    }
  };

  const handleOpenFolder = async (filePath: string) => {
    if (!filePath) return;

    try {
      // Call IPC through the API client
      await apiClient.invoke({
        method: "POST",
        endpoint: "show-file-in-folder",
        data: { filePath },
      });
    } catch (error) {
      console.error("[ConversationsPage] Failed to open folder:", error);
    }
  };

  const handleSwitchManuscript = async () => {
    if (!selectedProject) return;

    // Default to current manuscript's directory
    const defaultDir = manuscriptFile?.file_path
      ? manuscriptFile.file_path.substring(0, manuscriptFile.file_path.lastIndexOf('/'))
      : undefined;

    const filePath = await window.electronAPI?.invoke('select-file', { defaultPath: defaultDir, extensions: ['docx'] });
    if (!filePath) return; // User cancelled

    setIsSwitchingManuscript(true);
    setSwitchSuccessMessage(null); // Clear any previous success message

    try {
      // Check if file is already tracked in the project
      const existingFiles = await getProjectFiles(selectedProject.id);
      const isFileTracked = existingFiles.some((file) => file.file_path === filePath);

      // If NOT tracked, upload it first as a non-manuscript file
      if (!isFileTracked) {
        const syncResult = await window.electronAPI?.invoke('sync-project-file-once', selectedProject.id, filePath);
        if (!syncResult?.success) {
          throw new Error(syncResult?.error || 'Failed to sync file to project');
        }
      }

      await switchManuscript(selectedProject.id, filePath);
      // Refresh manuscript file data after switch
      const files = await getProjectFiles(selectedProject.id);
      const newManuscript = files.find((file) => file.is_primary_manuscript);
      setManuscriptFile(newManuscript || null);

      // Update ProjectSyncService cache with new manuscript path
      if (newManuscript?.file_path) {
        await window.electronAPI?.invoke('update-project-manuscript-path', selectedProject.id, newManuscript.file_path);
      }

      // If file was not previously tracked, start watching it for ongoing changes
      if (!isFileTracked) {
        await window.electronAPI?.invoke('start-project-file-sync', selectedProject.id, filePath);
      }

      // Trigger full review if new manuscript exists
      if (newManuscript) {
        setReviewingState('full-reviewing');
        setIsReviewInProgress(true);
        await triggerFullReview(selectedProject.id, newManuscript.id);
        startPolling(newManuscript.id);

        // Show success message
        setSwitchSuccessMessage('Manuscript switched successfully. Reviewing new manuscript...');
        // Auto-dismiss after 5 seconds
        setTimeout(() => {
          setSwitchSuccessMessage(null);
        }, 5000);
      }
    } catch (error) {
      console.error('Failed to switch manuscript:', error);
    } finally {
      setIsSwitchingManuscript(false);
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

  // Calculate remaining time until scheduled review
  const calculateRemainingTime = (createdAt: string): number => {
    const scheduledTime = new Date(createdAt);
    const targetTime = new Date(scheduledTime.getTime() + 10 * 60 * 1000);
    const now = new Date();
    const remainingMs = targetTime.getTime() - now.getTime();
    return Math.max(0, remainingMs);
  };

  // Format countdown time for display
  const formatCountdownTime = (remainingMs: number): string => {
    const minutes = Math.floor(remainingMs / (60 * 1000));
    if (minutes >= 1) return `~${minutes} min`;
    if (remainingMs > 0) return "< 1 min";
    return "starting...";
  };

  if (!selectedProject && !nonProjectConversations) {
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
      {/* Clean Top Bar matching Figma design */}
      <div className="conversationsTopBar">
        <div className="topBarLeft">
          {!hideBackButton && (
            <button className="backButton" onClick={onBack}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path
                  d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"
                  fill="currentColor"
                />
              </svg>
            </button>
          )}
          {manuscriptFile ? (
            <>
              <h2 className="docName">
                <span className="docNameText">{manuscriptFile.file_name}</span>
                <span className="statusDotContainer">
                  <span className="statusDot"></span>
                  <div className="timestampBadge">
                    Updated: {formatManuscriptTimestamp(manuscriptFile.updated_at)}
                  </div>
                </span>
              </h2>
            </>
          ) : nonProjectConversations ? (
            <h2 className="docName">
              <span className="docNameText">All Conversations</span>
            </h2>
          ) : null}
        </div>
        <div className="topBarRight">
          {manuscriptFile && (
            <>
              {/* Switch Manuscript Button */}
              {!hideSwitchManuscriptButton && (
                <button
                  className="secondaryButton"
                  onClick={handleSwitchManuscript}
                  disabled={isSwitchingManuscript}
                >
                  {isSwitchingManuscript ? 'Switching...' : 'Switch manuscript'}
                </button>
              )}

              {/* Open Button with Dropdown */}
              {!hideOpenButton && (
                <div className="dropdownContainer">
                  <button
                    className="secondaryButton"
                    onClick={() => { setShowOpenDropdown(!showOpenDropdown); setShowReviewDropdown(false); }}
                    disabled={!fileExistsLocally}
                  >
                    Open
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 20 20"
                      fill="none"
                      style={{ marginLeft: "4px" }}
                    >
                      <path
                        d="M5 7.5L10 12.5L15 7.5"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  {showOpenDropdown && (
                    <div className="dropdownMenu">
                      <button
                        className="dropdownItem"
                        onClick={() => {
                          setShowOpenDropdown(false);
                          handleOpenFile(manuscriptFile.file_path);
                        }}
                        disabled={!fileExistsLocally}
                      >
                        Open file
                      </button>
                      <button
                        className="dropdownItem"
                        onClick={() => {
                          setShowOpenDropdown(false);
                          handleOpenFolder(manuscriptFile.file_path);
                        }}
                        disabled={!fileExistsLocally}
                      >
                        Open folder
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Review Button with Dropdown */}
              {!hideReviewButton && (
                <div className="dropdownContainer">
                  <button
                    className={`primaryButton ${reviewingState === "full-reviewing" || reviewingState === "diff-reviewing" ? "reviewing" : ""}`}
                    onClick={() => { setShowReviewDropdown(!showReviewDropdown); setShowOpenDropdown(false); }}
                    disabled={reviewingState !== "idle" && reviewingState !== "pending-scheduled"}
                  >
                    {reviewingState === "full-reviewing" || reviewingState === "diff-reviewing"
                      ? "Reviewing..."
                      : "Review"}
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 20 20"
                      fill="none"
                      style={{ marginLeft: "4px" }}
                    >
                      <path
                        d="M5 7.5L10 12.5L15 7.5"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  {showReviewDropdown && (
                    <div className="dropdownMenu">
                      <button
                        className="dropdownItem"
                        onClick={() => {
                          setShowReviewDropdown(false);
                          handleFullReview();
                        }}
                        disabled={reviewingState !== "idle" || isReviewInProgress}
                      >
                        Full review
                      </button>
                      {shouldShowReviewChangesButton() && (
                        <button
                          className="dropdownItem"
                          onClick={() => {
                            setShowReviewDropdown(false);
                            handleDiffReview();
                          }}
                          disabled={
                            (reviewingState !== "idle" &&
                              reviewingState !== "pending-scheduled") ||
                            (isReviewInProgress &&
                              reviewingState !== "pending-scheduled")
                          }
                        >
                          {reviewingState === "pending-scheduled" && scheduledReviewTime
                            ? `Review scheduled (${formatCountdownTime(
                                calculateRemainingTime(
                                  scheduledReviewTime.toISOString(),
                                ),
                              )})`
                            : "Review changes"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Review Error */}
      {reviewError && <div className="reviewErrorMessage">{reviewError}</div>}
      {switchSuccessMessage && <div className="switchSuccessMessage">{switchSuccessMessage}</div>}

      {/* Manuscript Feedback Section - always visible so sidebar is always accessible */}
      <div className="manuscriptFeedbackSection">
        <div className="conversationsContent">
          {/* Unified Sidebar */}
          <div
            className={`sidebarWithHeader ${collapsed ? "collapsed" : ""}`}
          >
            <div className="manuscriptFeedbackHeader">
              <button
                onClick={toggleCollapsed}
                className="panelCollapseButton"
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <mask id="mask0_2500_461" style={{ maskType: "alpha" }} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
                    <rect width="24" height="24" fill="#D9D9D9"/>
                  </mask>
                  <g mask="url(#mask0_2500_461)">
                    <path d="M12.5 8V16L16.5 12L12.5 8ZM5 21C4.45 21 3.97917 20.8042 3.5875 20.4125C3.19583 20.0208 3 19.55 3 19V5C3 4.45 3.19583 3.97917 3.5875 3.5875C3.97917 3.19583 4.45 3 5 3H19C19.55 3 20.0208 3.19583 20.4125 3.5875C20.8042 3.97917 21 4.45 21 5V19C21 19.55 20.8042 20.0208 20.4125 20.4125C20.0208 20.8042 19.55 21 19 21H5ZM8 19V5H5V19H8ZM10 19H19V5H10V19Z" fill="currentColor"/>
                  </g>
                </svg>
              </button>
            </div>
            <ConversationsSidebar
              projectId={nonProjectConversations ? undefined : selectedProject!.id}
              selectedConversationId={selectedConversation?.id || null}
              onSelectConversation={(conv, isArchived) => {
                handleSelectConversation(conv);
                setIsSelectedConversationArchived(isArchived ?? false);
                setSelectedView('conversation');
              }}
              onNewConversation={handleNewConversation}
              draftConversation={draftConversation}
              refreshTrigger={refreshTrigger}
              onConversationsLoaded={handleConversationsLoaded}
              onRefreshComplete={handleSidebarRefreshComplete}
              onConversationView={onConversationView}
              onRegisterRefresh={onRegisterConversationsRefresh}
              collapsed={collapsed}
              onToggleCollapsed={toggleCollapsed}
              supportingMaterialsCount={nonProjectConversations ? 0 : supportingMaterialsTotalCount}
              supportingMaterialsLoading={nonProjectConversations ? false : supportingMaterialsLoading}
              selectedView={selectedView}
              onSelectSupportingMaterials={nonProjectConversations ? undefined : () => { setSelectedConversation(null); setSelectedView('supporting-materials'); }}
              isReviewInProgress={isReviewInProgress}
            />
          </div>

          {/* Main Content - supporting materials, review-in-progress placeholder, or conversation */}
          {selectedView === 'supporting-materials' && !nonProjectConversations ? (
            <SupportingMaterialsContent
              projectId={selectedProject!.id}
              onMaterialsChange={refreshSupportingMaterials}
              fileUploadEvent={fileUploadEvent}
              zoteroSyncEvent={zoteroSyncEvent}
              zoteroStatus={zoteroStatus}
              isZoteroStatusLoading={isZoteroStatusLoading}
              isZoteroPolling={isZoteroPolling}
              isZoteroSyncing={isZoteroSyncing}
              isZoteroDisconnecting={isZoteroDisconnecting}
              onConnectZotero={handleConnectZotero}
              onSyncZotero={handleSyncZotero}
              onDisconnectZotero={handleDisconnectZotero}
            />
          ) : isReviewInProgress && !hasConversations ? (
            <div className="emptyStateContainer">
              <div className="emptyState">
                <div className="emptyStateIcon">⏳</div>
                <h3>Review in progress</h3>
                <p>Your manuscript is being reviewed. This may take a few minutes.</p>
              </div>
            </div>
          ) : (
            <ConversationDetail
              conversation={selectedConversation}
              projectId={nonProjectConversations ? null : selectedProject!.id}
              primaryManuscriptId={manuscriptFile?.id}
              manuscriptFile={manuscriptFile}
              onConversationCreated={handleConversationCreated}
              onConversationUpdate={handleConversationUpdate}
              isReviewInProgress={isReviewInProgress}
              isInitialLoading={selectedConversation !== null && (isLoadingFiles || !conversationsLoaded)}
              onMessageSent={onMessageSent}
              onMessageReceived={onMessageReceived}
              feedbackFormUrl={feedbackFormUrl}
              pollingOptions={pollingOptions}
              initialOpenDiffModal={initialOpenDiffModal}
              onDiffModalOpened={onDiffModalOpened}
              isArchived={isSelectedConversationArchived}
            />
          )}
        </div>
      </div>
    </div>
  );
}
