import { useState, useEffect, useCallback, useRef } from 'react';
import { AgentRun, getProjectStatus } from '../services/projectsApi';

const POLL_INTERVAL = 5000; // 5 seconds
const MAX_POLL_DURATION = 10 * 60 * 1000; // 10 minutes

interface UseReviewPollingResult {
  agentRun: AgentRun | null;
  isPolling: boolean;
  error: string | null;
  startPolling: (projectId: number, fileId: number) => void;
  stopPolling: () => void;
}

export function useReviewPolling(): UseReviewPollingResult {
  const [agentRun, setAgentRun] = useState<AgentRun | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const projectIdRef = useRef<number | null>(null);
  const fileIdRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsPolling(false);
  }, []);

  const pollStatus = useCallback(async () => {
    if (!projectIdRef.current || !fileIdRef.current) return;

    try {
      // Fetch project status filtered by science_agent and specific file
      const statusData = await getProjectStatus(
        projectIdRef.current,
        'science_agent',
        fileIdRef.current
      );

      // Find the agent run for our file
      const run = statusData.agent_runs[0]; // First match since we filtered

      console.log('[ReviewPolling] Status response:', {
        projectId: projectIdRef.current,
        fileId: fileIdRef.current,
        agentRunsCount: statusData.agent_runs.length,
        run: run ? {
          status: run.status,
          running_jobs_count: run.running_jobs_count,
          has_review_data: !!run.review_data,
          suggestions_count: run.review_data?.suggestions?.length || 0,
        } : null,
      });

      if (!run) {
        // No agent run yet, keep polling
        console.log('[ReviewPolling] No agent run found yet, continuing...');
        return;
      }

      setAgentRun(run);

      // Check if completed
      if (run.status === 'completed' && run.running_jobs_count === 0) {
        console.log('[ReviewPolling] Reviews completed:', run.review_data?.suggestions?.length);
        stopPolling();
      }

      // Check if failed
      if (run.status === 'failed') {
        console.error('[ReviewPolling] Review generation failed');
        setError('Review generation failed');
        stopPolling();
      }
    } catch (err: any) {
      console.error('[ReviewPolling] Failed to fetch status:', err);
      // Don't stop polling on temporary errors
    }
  }, [stopPolling]);

  const startPolling = useCallback((projectId: number, fileId: number) => {
    // Stop any existing polling
    stopPolling();

    // Store IDs
    projectIdRef.current = projectId;
    fileIdRef.current = fileId;

    console.log('[ReviewPolling] Starting to poll for reviews:', { projectId, fileId });

    setIsPolling(true);
    setError(null);
    setAgentRun(null);

    // Initial poll
    pollStatus();

    // Set up interval
    intervalRef.current = setInterval(pollStatus, POLL_INTERVAL);

    // Set up timeout
    timeoutRef.current = setTimeout(() => {
      console.error('[ReviewPolling] Polling timed out after 10 minutes');
      setError('Review generation timed out after 10 minutes. Please try again.');
      stopPolling();
    }, MAX_POLL_DURATION);
  }, [pollStatus, stopPolling]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  return {
    agentRun,
    isPolling,
    error,
    startPolling,
    stopPolling,
  };
}
