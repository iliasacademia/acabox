import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Message, MessageContext, Conversation, DraftConversation, SearchFilesMatchedFile } from '../types/conversation';
import { ProjectFile, DiffResponse } from '../types/project';
import { SupportingMaterial } from '../types/supportingMaterials';
import { useConversationsApi } from '../api/useConversationsApi';
import { useProjectsApi } from '../api/useProjectsApi';
import { useSupportingMaterialsApi } from '../api/useSupportingMaterialsApi';
import { useConversationPolling, UseConversationPollingOptions } from '../hooks/useConversationPolling';
import { useApiClient } from '../context/ApiContext';
import { ConversationMessage } from './ConversationMessage';
import { ToolMessageAccordion } from './ToolMessageAccordion';
import DiffModal from './DiffModal';
import { FilePicker } from './FilePicker';

interface AttachedFile {
  localId: string;
  name: string;
  /** Filesystem path — set in Electron, empty string in overlay */
  filePath: string;
  /** Browser File object — set in overlay when filesystem path is unavailable */
  fileObject?: File;
  /** true for files already uploaded to the project (e.g. via @ mention) */
  isProjectFile?: boolean;
  /** project file ID — only set for isProjectFile files */
  projectFileId?: number;
}

interface ConversationDetailProps {
  conversation: Conversation | DraftConversation | null;
  projectId: number | null;
  primaryManuscriptId?: number;
  /** Optional: Initial value for the message input (e.g., quoted selected text) */
  initialInputValue?: string;
  manuscriptFile?: ProjectFile | null;
  onConversationCreated?: (conversation: Conversation) => void;
  onConversationUpdate?: () => void;
  isReviewInProgress?: boolean;
  isInitialLoading?: boolean;
  /** Optional: Called when a message is sent (for analytics) */
  onMessageSent?: (projectId: number | null, conversationId: number, agentName: string) => void;
  /** Optional: Called when an assistant message is received (for analytics) */
  onMessageReceived?: (projectId: number | null, conversationId: number, agentName: string, durationSeconds?: number) => void;
  /** Optional: URL for feedback form. If provided, shows a feedback link. */
  feedbackFormUrl?: string;
  /** Optional: Options for conversation polling (e.g., event-driven updates) */
  pollingOptions?: UseConversationPollingOptions;
  /** Optional: Auto-open diff modal when conversation loads */
  initialOpenDiffModal?: boolean;
  /** Optional: Called when diff modal is auto-opened via initialOpenDiffModal */
  onDiffModalOpened?: () => void;
  /** Whether the selected conversation is archived */
  isArchived?: boolean;
}

export function ConversationDetail({
  conversation,
  projectId,
  primaryManuscriptId,
  manuscriptFile,
  onConversationCreated,
  onConversationUpdate,
  isReviewInProgress,
  isInitialLoading,
  onMessageSent,
  onMessageReceived,
  feedbackFormUrl,
  pollingOptions,
  initialOpenDiffModal,
  onDiffModalOpened,
  isArchived,
  initialInputValue,
}: ConversationDetailProps) {
  const [inputValue, setInputValue] = useState(initialInputValue ?? '');

  useEffect(() => {
    setInputValue(initialInputValue ?? '');
  }, [initialInputValue]);

  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showDiffModal, setShowDiffModal] = useState(false);
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [diffData, setDiffData] = useState<DiffResponse | null>(null);
  const [isDiffLoading, setIsDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [disableMessageInput, setDisableMessageInput] = useState(false);
  const [previousManuscriptName, setPreviousManuscriptName] = useState<string | null>(null);
  const [hiddenMessageIds, setHiddenMessageIds] = useState<Set<number>>(new Set());
  const [isSelectedTextExpanded, setIsSelectedTextExpanded] = useState(false);
  const [showSelectedTextToggle, setShowSelectedTextToggle] = useState(false);
  const selectedTextRef = useRef<HTMLDivElement>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isInitialLoad = useRef(true);
  const prevConversationIdRef = useRef<number | null>(null);
  const previousMessageCount = useRef(0);
  const messageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const lastTrackedAssistantMessageId = useRef<number | null>(null);
  const lastTrackedConversationId = useRef<number | null>(null);
  const conversationViewedAt = useRef<Date | null>(null);
  const lastUserMessageTime = useRef<Date | null>(null);
  const hasOpenedInitialDiffModal = useRef(false);

  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  // @ mention state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null); // null = closed
  const [mentionAnchorIndex, setMentionAnchorIndex] = useState<number>(-1);
  const [mentionFiles, setMentionFiles] = useState<SupportingMaterial[]>([]);
  const [mentionActiveIndex, setMentionActiveIndex] = useState<number>(0);
  const mentionDropdownRef = useRef<HTMLDivElement>(null);

  const apiClient = useApiClient();
  const { createConversation, createMessage } = useConversationsApi();
  const { getSupportingMaterials } = useSupportingMaterialsApi();
  const { getFileDiff } = useProjectsApi();

  // Open feedback form in browser with conversation ID prefilled
  const handleOpenFeedback = () => {
    if (!conversation || isDraft(conversation) || !feedbackFormUrl) return;
    const conversationId = encodeURIComponent(String(conversation.id));
    const formUrl = `${feedbackFormUrl}?usp=pp_url&entry.744362453=${conversationId}`;

    if (apiClient.openExternalUrl) {
      apiClient.openExternalUrl(formUrl);
    } else {
      // Fallback for web: open in new tab
      window.open(formUrl, '_blank');
    }
  };

  // Open a search-result file — optionally jump to a specific page.
  // local PDF: shell.openExternal with #page fragment; Zotero: zotero://open-pdf?page=N deep link.
  const handleOpenFile = async (file: SearchFilesMatchedFile, page?: string) => {
    if (file.local_path) {
      await apiClient.invoke({
        method: 'POST',
        endpoint: 'open-file',
        data: { filePath: file.local_path, page: page ? parseInt(page, 10) : undefined },
      });
    } else if (file.url && apiClient.openExternalUrl) {
      const zoteroMatch = file.url.match(/api\.zotero\.org\/(users|groups)\/(\d+)\/items\/([A-Z0-9]+)/i);
      if (zoteroMatch) {
        const [, ownerType, ownerId, itemKey] = zoteroMatch;
        // Personal library uses "library"; group libraries use "groups/GROUPID"
        const libraryPath = ownerType.toLowerCase() === 'groups' ? `groups/${ownerId}` : 'library';
        // Zotero's open-pdf deep link uses 0-based page index, so subtract 1.
        const openUrl = page
          ? `zotero://open-pdf/${libraryPath}/items/${itemKey}?page=${parseInt(page, 10) - 1}`
          : `zotero://open-pdf/${libraryPath}/items/${itemKey}`;
        apiClient.openExternalUrl(openUrl);
      } else {
        apiClient.openExternalUrl(file.url);
      }
    }
  };

  // Fetch diff when Show Diff is clicked
  const handleShowDiff = async () => {
    if (!primaryManuscriptId) {
      setDiffError('No primary manuscript file found');
      setShowDiffModal(true);
      return;
    }

    if (!conversation || isDraft(conversation)) {
      setDiffError('Cannot show diff for draft conversation');
      setShowDiffModal(true);
      return;
    }

    if (!projectId) {
      setDiffError('Cannot show diff for non-project conversation');
      setShowDiffModal(true);
      return;
    }

    setIsDiffLoading(true);
    setDiffError(null);
    setShowDiffModal(true);

    try {
      const diff = await getFileDiff(projectId, primaryManuscriptId, conversation.id);
      setDiffData(diff);
    } catch (error: unknown) {
      const err = error as { message?: string };
      // Sanitize error message
      const errorMsg = String(err.message || 'Failed to load diff').substring(0, 200);
      setDiffError(errorMsg);
    } finally {
      setIsDiffLoading(false);
    }
  };

  const { messages, conversation: polledConversation, isAwaitingResponse, isLoading, error, startPolling, stopPolling, resetMessages, initializeMessages, addOptimisticMessage } =
    useConversationPolling(pollingOptions);

  // Helper to check if conversation is a draft
  const isDraft = (conv: Conversation | DraftConversation | null): conv is DraftConversation => {
    return conv !== null && 'isDraft' in conv && conv.isDraft === true;
  };

  // Load messages when conversation changes (but not for drafts)
  useEffect(() => {
    const prevId = prevConversationIdRef.current;
    prevConversationIdRef.current = conversation?.id ?? null;

    if (!conversation || isDraft(conversation)) {
      // Clear messages and stop polling when switching to a draft or no conversation
      resetMessages();
      isInitialLoad.current = true;
      previousMessageCount.current = 0;
      lastTrackedAssistantMessageId.current = null;
      lastTrackedConversationId.current = null;
      conversationViewedAt.current = null;
      lastUserMessageTime.current = null;
      return;
    }

    // Draft → real transition: polling was already started in handleSendMessage
    // and messages (including the optimistic user message) are already in state.
    // Just update tracking refs — do NOT call initializeMessages (it would wipe messages).
    if (prevId !== null && prevId < 0) {
      conversationViewedAt.current = new Date();
      lastUserMessageTime.current = null;
      return;
    }

    // Normal conversation switch: load fresh
    isInitialLoad.current = true;
    previousMessageCount.current = 0;
    lastTrackedAssistantMessageId.current = null;
    lastTrackedConversationId.current = null;
    conversationViewedAt.current = new Date();
    lastUserMessageTime.current = null;

    initializeMessages(conversation.id, projectId);
  }, [conversation?.id, projectId, initializeMessages, stopPolling]);

  // Reset the initial diff modal flag when conversation changes
  useEffect(() => {
    hasOpenedInitialDiffModal.current = false;
  }, [conversation?.id]);

  // Clear any optimistically hidden messages when the conversation changes
  useEffect(() => {
    setHiddenMessageIds(new Set());
  }, [conversation?.id]);

  // Auto-open diff modal when initialOpenDiffModal is true and conversation is loaded
  useEffect(() => {
    if (
      initialOpenDiffModal &&
      conversation &&
      !isDraft(conversation) &&
      !hasOpenedInitialDiffModal.current &&
      primaryManuscriptId &&
      !showDiffModal
    ) {
      hasOpenedInitialDiffModal.current = true;
      handleShowDiff();
      // Signal that we've consumed the initial open flag
      if (onDiffModalOpened) {
        onDiffModalOpened();
      }
    }
  }, [initialOpenDiffModal, conversation, showDiffModal, onDiffModalOpened, primaryManuscriptId]);

  // Handle scrolling: stay at top on initial load, scroll to new message when messages arrive
  useEffect(() => {
    if (messages.length === 0) return;

    if (isInitialLoad.current) {
      // On initial load, stay at the top (don't scroll)
      // The container naturally starts at the top, so we just mark it as loaded
      isInitialLoad.current = false;
      previousMessageCount.current = messages.length;
    } else if (messages.length > previousMessageCount.current) {
      // New messages arrived - scroll to the first new message
      const firstNewMessageIndex = previousMessageCount.current;
      const firstNewMessageRef = messageRefs.current.get(firstNewMessageIndex);

      if (firstNewMessageRef) {
        firstNewMessageRef.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

      previousMessageCount.current = messages.length;
    }
  }, [messages]);

  // Scroll to bottom when loading indicator appears
  useEffect(() => {
    if (isAwaitingResponse || isSending) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [isAwaitingResponse, isSending]);

  // Auto-focus textarea when a draft conversation is active
  useEffect(() => {
    if (isDraft(conversation)) {
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
          el.scrollTop = el.scrollHeight;
        }
      });
    }
  }, [conversation?.id]);

  // Detect if selected text overflows (needs show more/less toggle)
  useEffect(() => {
    const el = selectedTextRef.current;
    if (el) {
      setShowSelectedTextToggle(el.scrollHeight > el.clientHeight);
    }
  });

  // Track received assistant messages
  useEffect(() => {
    if (!conversation || isDraft(conversation) || messages.length === 0 || !onMessageReceived) return;

    // Find the latest assistant message by timestamp (not array position)
    const assistantMessages = messages.filter((m) => m.role === 'assistant');
    if (assistantMessages.length === 0) return;

    // Sort by created_at to find the truly latest message
    const latestAssistantMessage = assistantMessages.reduce((latest, current) => {
      if (!latest.created_at) return current;
      if (!current.created_at) return latest;
      return new Date(current.created_at) > new Date(latest.created_at) ? current : latest;
    });

    // If conversation has changed, reset tracking refs
    if (lastTrackedConversationId.current !== conversation.id) {
      lastTrackedAssistantMessageId.current = latestAssistantMessage.id;
      lastTrackedConversationId.current = conversation.id;
      return;
    }

    // Check if we've already tracked this message
    if (lastTrackedAssistantMessageId.current === latestAssistantMessage.id) {
      return;
    }

    // If this is the initial load (ref was reset to null when switching conversations),
    // set the ref without tracking - we only want to track NEW messages, not existing ones
    if (lastTrackedAssistantMessageId.current === null) {
      lastTrackedAssistantMessageId.current = latestAssistantMessage.id;
      lastTrackedConversationId.current = conversation.id;
      return;
    }

    // CRITICAL CHECK: Only track messages created AFTER we started viewing this conversation
    // This prevents tracking old messages when switching to an existing conversation
    if (conversationViewedAt.current && latestAssistantMessage.created_at) {
      const messageCreatedAt = new Date(latestAssistantMessage.created_at);
      const viewedAt = conversationViewedAt.current;

      if (messageCreatedAt <= viewedAt) {
        // Update ref to prevent repeated checks for this old message
        lastTrackedAssistantMessageId.current = latestAssistantMessage.id;
        return;
      }
    }

    // Calculate duration if we have a user message timestamp
    let durationSeconds: number | undefined;
    if (lastUserMessageTime.current && latestAssistantMessage.created_at) {
      const assistantTime = new Date(latestAssistantMessage.created_at);
      const userTime = lastUserMessageTime.current;
      durationSeconds = Math.round((assistantTime.getTime() - userTime.getTime()) / 1000);
    }

    // Track the received message
    onMessageReceived(
      projectId,
      conversation.id,
      conversation.agent_name,
      durationSeconds
    );

    // Update the last tracked message ID and conversation ID
    lastTrackedAssistantMessageId.current = latestAssistantMessage.id;
    lastTrackedConversationId.current = conversation.id;
  }, [messages, conversation, projectId, onMessageReceived]);

  // Calculate disableMessageInput based on manuscript context match
  useEffect(() => {
    // For draft conversations or no messages, don't disable
    if (isDraft(conversation) || messages.length === 0 || !primaryManuscriptId) {
      setDisableMessageInput(false);
      setPreviousManuscriptName(null);
      return;
    }

    // Get first message's contexts
    const firstMessage = messages[0];
    const contexts = firstMessage.contexts.filter(ctx => ctx.target_id !== null);

    // Check if manuscript ID is in the first message's contexts
    const manuscriptInContext = contexts.some(ctx => ctx.target_id === primaryManuscriptId);

    // Only disable if the message has contexts but the current manuscript isn't among them
    // (meaning the manuscript was switched after this conversation was started).
    // If there are no contexts, this is a free-form conversation — keep input enabled.
    setDisableMessageInput(contexts.length > 0 && !manuscriptInContext);

    // Store the previous manuscript name if disabled
    if (!manuscriptInContext && contexts.length > 0) {
      // Use the first context's target_name as the previous manuscript name
      setPreviousManuscriptName(contexts[0].target_name);
    } else {
      setPreviousManuscriptName(null);
    }
  }, [messages, primaryManuscriptId, conversation]);

  // Fetch supporting materials once when @ mention is first opened
  const mentionOpen = mentionQuery !== null;
  useEffect(() => {
    if (!mentionOpen || !projectId) return;
    if (mentionFiles.length > 0) return; // already loaded
    getSupportingMaterials(projectId).then(({ materials }) => {
      setMentionFiles(materials.filter(m => !m.is_primary_manuscript));
    }).catch(() => {});
  }, [mentionOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredMentionFiles = mentionQuery !== null
    ? mentionFiles.filter(m =>
        m.file_name.toLowerCase().includes(mentionQuery.toLowerCase())
      )
    : [];

  // Reset active index when list changes
  useEffect(() => {
    setMentionActiveIndex(0);
  }, [filteredMentionFiles.length, mentionQuery]);

  const handleMentionSelect = useCallback((material: SupportingMaterial) => {
    // Remove the @query text from the input
    const before = inputValue.slice(0, mentionAnchorIndex);
    const after = inputValue.slice(mentionAnchorIndex + 1 + (mentionQuery?.length ?? 0));
    setInputValue(before + after);

    // Skip if already attached
    const alreadyAttached = attachedFiles.some(f => f.projectFileId === material.id);
    if (!alreadyAttached) {
      const localId = `${Date.now()}-${Math.random()}`;
      setAttachedFiles(prev => [
        ...prev,
        {
          localId,
          name: material.file_name,
          filePath: material.file_path,
          isProjectFile: true,
          projectFileId: material.id,
        },
      ]);
    }

    setMentionQuery(null);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [inputValue, mentionAnchorIndex, mentionQuery, attachedFiles]);

  const handleFilePathsAdded = (filePaths: string[]) => {
    for (const filePath of filePaths) {
      const name = filePath.split('/').pop() || filePath;
      const localId = `${Date.now()}-${Math.random()}`;
      setAttachedFiles(prev => [...prev, { localId, name, filePath }]);
    }
  };

  const handleBrowserFilesAdded = (files: File[]) => {
    for (const file of files) {
      const localId = `${Date.now()}-${Math.random()}`;
      setAttachedFiles(prev => [...prev, { localId, name: file.name, filePath: '', fileObject: file }]);
    }
  };

  const removeAttachedFile = (localId: string) => {
    setAttachedFiles(prev => prev.filter(f => f.localId !== localId));
  };

  const manuscriptFolderPath = manuscriptFile?.file_path
    ? manuscriptFile.file_path.substring(0, manuscriptFile.file_path.lastIndexOf('/'))
    : undefined;

  const handleAttachClick = async () => {
    if (!projectId || !(window as any).electronAPI?.invoke) return;
    const filePaths = await (window as any).electronAPI.invoke('select-file', {
      defaultPath: manuscriptFolderPath,
      extensions: ['pdf', 'docx', 'doc', 'txt', 'md', 'tex', 'rtf'],
      multiSelection: true,
    });
    if (!filePaths || (Array.isArray(filePaths) && filePaths.length === 0)) return;
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    handleFilePathsAdded(paths);
  };

  const handleAttachClickOverlay = () => {
    if (!projectId) return;
    setShowFilePicker(true);
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    if (!e.dataTransfer.types.includes('Files')) return;
    dragCounterRef.current++;
    setIsDragOver(true);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDragLeave = () => {
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    const electronAPI = (window as any).electronAPI;
    if (electronAPI?.getPathForFile) {
      const paths = Array.from(e.dataTransfer.files)
        .map(f => electronAPI.getPathForFile?.(f) ?? (f as unknown as { path?: string }).path)
        .filter((p): p is string => typeof p === 'string' && p.length > 0);
      if (paths.length > 0) handleFilePathsAdded(paths);
    } else {
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) handleBrowserFilesAdded(files);
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!conversation || (!inputValue.trim() && attachedFiles.length === 0) || isSending) return;

    const content = inputValue.trim();

    // Split attached files: already-uploaded project files (@ mentions) vs local files to upload on send
    const projectFiles = attachedFiles.filter(f => f.isProjectFile && f.projectFileId !== undefined);
    const localFiles = attachedFiles.filter(f => !f.isProjectFile);
    const projectFileIds = projectFiles.map(f => f.projectFileId as number);
    // Only one local file can be sent per message (API supports a single `file` field)
    const firstLocalFile = localFiles.length > 0 ? localFiles[0] : undefined;
    const filePath = firstLocalFile?.filePath || undefined;
    const fileObject = firstLocalFile?.fileObject;

    const optimisticContexts: MessageContext[] = projectFiles.map((f, i) => ({
      id: -(i + 1),
      target_type: 'CoScientist::ProjectFile',
      target_id: f.projectFileId!,
      target_name: f.name,
      created_at: new Date().toISOString(),
    }));

    setInputValue('');
    setAttachedFiles([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setIsSending(true);
    setSendError(null);

    try {
      if (isDraft(conversation)) {
        // Show user message immediately before the API call
        addOptimisticMessage({
          id: Date.now(),
          role: 'user',
          content,
          data: null,
          contexts: optimisticContexts,
          created_at: new Date().toISOString(),
        });

        // Create conversation with the message (file sent as binary if present)
        const newConversation = await createConversation(
          content,
          conversation.agent_name,
          projectId,
          conversation.title ?? undefined,
          projectFileIds.length > 0 ? projectFileIds : undefined,
          filePath,
          fileObject
        );

        // Track conversation message sent
        if (onMessageSent) {
          onMessageSent(projectId, newConversation.id, conversation.agent_name);
        }
        const now = new Date();
        lastUserMessageTime.current = now;
        conversationViewedAt.current = now; // Update so we track the AI response

        // Notify parent to replace draft with real conversation
        onConversationCreated?.(newConversation);

        // Start polling for AI response (which will also fetch the user message)
        startPolling(newConversation.id, projectId);
      } else {
        // Add user message optimistically to UI
        const optimisticMessage: Message = {
          id: Date.now(), // Temporary ID
          role: 'user',
          content,
          data: null,
          contexts: optimisticContexts,
          created_at: new Date().toISOString(),
        };
        addOptimisticMessage(optimisticMessage);

        // Send message to backend (file sent as binary if present)
        await createMessage(
          conversation.id,
          content,
          projectId,
          projectFileIds.length > 0 ? projectFileIds : undefined,
          filePath,
          fileObject
        );

        // Track conversation message sent
        if (onMessageSent) {
          onMessageSent(projectId, conversation.id, conversation.agent_name);
        }
        const now = new Date();
        lastUserMessageTime.current = now;
        conversationViewedAt.current = now; // Update so we track the AI response

        // Notify parent to update conversation list
        onConversationUpdate?.();

        // Start polling to get AI response and sync messages
        startPolling(conversation.id, projectId);
      }
    } catch (err: unknown) {
      const error = err as { message?: string };
      setSendError(error.message || 'Failed to send message. Please try again.');
      // Restore input value on error
      setInputValue(content);
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionQuery !== null && filteredMentionFiles.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionActiveIndex(i => (i + 1) % filteredMentionFiles.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionActiveIndex(i => (i - 1 + filteredMentionFiles.length) % filteredMentionFiles.length);
        return;
      }
    }
    if (mentionQuery !== null && e.key === 'Escape') {
      e.preventDefault();
      setMentionQuery(null);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (mentionQuery !== null) {
        if (filteredMentionFiles.length > 0) {
          e.preventDefault();
          handleMentionSelect(filteredMentionFiles[mentionActiveIndex]);
        } else {
          setMentionQuery(null);
        }
        return;
      }
      e.preventDefault();
      handleSendMessage(e as unknown as React.FormEvent);
    }
  };

  // Handle question pill click - sends the question as a message
  const handleQuestionClick = async (questionText: string) => {
    if (!conversation || isSending) return;

    const content = questionText.trim();
    if (!content) return;

    setIsSending(true);
    setSendError(null);

    try {
      if (isDraft(conversation)) {
        // First message: create conversation with the message
        const newConversation = await createConversation(
          content,
          conversation.agent_name,
          projectId,
          conversation.title ?? undefined
        );

        // Track conversation message sent
        if (onMessageSent) {
          onMessageSent(projectId, newConversation.id, conversation.agent_name);
        }
        const now = new Date();
        lastUserMessageTime.current = now;
        conversationViewedAt.current = now;

        // Notify parent to replace draft with real conversation
        onConversationCreated?.(newConversation);

        // Start polling for AI response
        startPolling(newConversation.id, projectId);
      } else {
        // Add user message optimistically to UI
        const optimisticMessage: Message = {
          id: Date.now(), // Temporary ID
          role: 'user',
          content,
          data: null,
          contexts: [],
          created_at: new Date().toISOString(),
        };
        addOptimisticMessage(optimisticMessage);

        // Send message to backend
        await createMessage(conversation.id, content, projectId);

        // Track conversation message sent
        if (onMessageSent) {
          onMessageSent(projectId, conversation.id, conversation.agent_name);
        }
        const now = new Date();
        lastUserMessageTime.current = now;
        conversationViewedAt.current = now;

        // Notify parent to update conversation list
        onConversationUpdate?.();

        // Start polling to get AI response and sync messages
        startPolling(conversation.id, projectId);
      }
    } catch (err: unknown) {
      const error = err as { message?: string };
      setSendError(error.message || 'Failed to send message. Please try again.');
    } finally {
      setIsSending(false);
    }
  };

  // Find the last assistant message
  const lastAssistantMessage = messages
    .slice()
    .reverse()
    .find((m) => m.role === 'assistant');

  // Check if there's a user message after the last assistant message (for question pills)
  const lastAssistantIndex = lastAssistantMessage
    ? messages.findIndex((m) => m.id === lastAssistantMessage.id)
    : -1;

  const hasUserMessageAfterLastAssistant = lastAssistantIndex >= 0 &&
    messages.slice(lastAssistantIndex + 1).some((m) => m.role === 'user');

  // Show questions on last assistant message if no user message follows
  const shouldShowQuestions = !hasUserMessageAfterLastAssistant;

  // Extract review_id from conversation (check both polledConversation and conversation prop)
  const conversationReviewId = polledConversation?.review_id ?? conversation?.review_id ?? undefined;

  // Only keep the last search_files_progress message — each new one supersedes the previous.
  // search_files_result renders as normal HTML and is always kept.
  // Also filter out any messages optimistically hidden.
  const visibleMessages = hiddenMessageIds.size > 0
    ? messages.filter((m) => !hiddenMessageIds.has(m.id))
    : messages;
  const lastSearchProgressId = visibleMessages.reduce<number | null>((lastId, m) => {
    const mt = (m.data as { message_type?: string } | null)?.message_type;
    return mt === 'search_files_progress' ? m.id : lastId;
  }, null);
  // Search is complete when a search_files_result message exists, OR when a regular
  // assistant message with content has arrived after the last search_files_progress.
  const hasSearchResult = visibleMessages.some((m) => {
    const mt = (m.data as { message_type?: string } | null)?.message_type;
    if (mt === 'search_files_result') return true;
    if (m.role === 'assistant' && m.content && !mt && lastSearchProgressId !== null && m.id > lastSearchProgressId) return true;
    return false;
  });
  const displayMessages = visibleMessages
    .filter((m) => {
      const mt = (m.data as { message_type?: string } | null)?.message_type;
      if (mt === 'search_files_progress') return m.id === lastSearchProgressId;
      return true;
    })
    .sort((a, b) => a.id - b.id);

  // Group consecutive tool messages (no date dividers)
  const groupedMessages: Array<{ type: 'message' | 'toolGroup'; data: Message | Message[]; messageIndex: number }> = [];
  let currentToolGroup: Message[] = [];
  let messageIndex = 0;

  displayMessages.forEach((message) => {
    if (message.role === 'tool') {
      currentToolGroup.push(message);
    } else {
      // If we have accumulated tool messages, add them as a group
      if (currentToolGroup.length > 0) {
        groupedMessages.push({
          type: 'toolGroup',
          data: currentToolGroup,
          messageIndex: messageIndex,
        });
        messageIndex++;
        currentToolGroup = [];
      }

      // Add the regular message
      groupedMessages.push({
        type: 'message',
        data: message,
        messageIndex: messageIndex,
      });
      messageIndex++;
    }
  });

  // Don't forget remaining tool messages
  if (currentToolGroup.length > 0) {
    groupedMessages.push({
      type: 'toolGroup',
      data: currentToolGroup,
      messageIndex: messageIndex,
    });
  }

  if (!conversation) {
    return (
      <div className="conversationDetail empty">
        <div className="emptyState">
          {isInitialLoading ? (
            <>
              <div className="loadingSpinner"></div>
              <h3>Loading feedback...</h3>
              <p>Please wait while we load your manuscript feedback.</p>
            </>
          ) : isReviewInProgress ? (
            <>
              <div className="emptyStateIcon">⏳</div>
              <h3>Review in progress</h3>
              <p>Your manuscript is being reviewed. This may take a few minutes.</p>
            </>
          ) : (
            <>
              <div className="emptyStateIcon">📄</div>
              <h3>No feedback yet</h3>
              <p>Upload and sync your manuscript to receive AI-powered feedback.</p>
            </>
          )}
        </div>
      </div>
    );
  }

  const currentIsDraft = isDraft(conversation);

  return (
    <div className="conversationDetail" style={{ position: 'relative' }}>
      {showFilePicker && (
        <FilePicker
          initialDir={manuscriptFolderPath}
          onSelect={(file) => {
            handleBrowserFilesAdded([file]);
            setShowFilePicker(false);
          }}
          onCancel={() => setShowFilePicker(false)}
        />
      )}
      {/* Header */}
      <div className="conversationHeader">
        <div className="conversationHeaderContent">
          <div className="conversationTitleRow">
            {!currentIsDraft && conversation.created_at && (
              <p className="conversationDate">
                {new Date(conversation.created_at).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric'
                })}
              </p>
            )}
            <h2 className="conversationTitle">
              {conversation.title || 'New Conversation'}
              {isArchived && <span className="conversationArchivedBadge">Archived</span>}
            </h2>
          </div>
          {conversation.summary && (
            <p className="conversationSummary">{conversation.summary}</p>
          )}
        </div>
      </div>

      {/* Selected Text (for selection reviews) */}
      {(() => {
        // Find selected text from various sources
        const userMessageWithSelectedText = messages.find(m => m.role === 'user' && m.data?.selected_text);
        const messageSelectedText = userMessageWithSelectedText?.data?.selected_text as string | undefined;

        const selectedText = polledConversation?.selected_text ||
          conversation?.selected_text ||
          messageSelectedText;

        if (!selectedText || currentIsDraft) {
          return null;
        }

        return (
          <div className="selectedTextSection" style={{
            backgroundColor: '#EEF2F9',
            borderRadius: '8px',
            padding: '12px 16px',
            margin: '0 24px 16px 24px',
            fontSize: '16px',
            lineHeight: '20px',
            color: '#141413',
          }}>
            <div style={{
              fontSize: '12px',
              fontWeight: 600,
              color: '#6B6B6A',
              marginBottom: '4px',
            }}>
              Selected text
            </div>
            <div
              ref={selectedTextRef}
              style={{
                ...(isSelectedTextExpanded ? {
                  maxHeight: `${20 * 5}px`, // 5 lines × 20px line-height
                  overflowY: 'auto' as const,
                } : {
                  display: '-webkit-box',
                  WebkitLineClamp: 1,
                  WebkitBoxOrient: 'vertical' as const,
                  overflow: 'hidden',
                }),
              }}
            >
              {selectedText}
            </div>
            {showSelectedTextToggle && (
              <button
                onClick={() => setIsSelectedTextExpanded(prev => !prev)}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  marginTop: '4px',
                  fontSize: '14px',
                  color: '#4A6FA5',
                  textDecoration: 'underline',
                  cursor: 'pointer',
                }}
              >
                {isSelectedTextExpanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </div>
        );
      })()}

      {/* Messages */}
      <div className="conversationMessages" ref={messagesContainerRef}>
        {error && (
          <div className="conversationError">
            <span className="errorIcon">⚠️</span>
            <span>{error}</span>
          </div>
        )}

        {currentIsDraft && !isSending ? null
        : (isSending || isLoading || isAwaitingResponse) && groupedMessages.length === 0 ? (
          <div className="conversationMessage assistant">
            <div className="messageContent">
              <div className="messageLoading">
                <span className="loadingDot"></span>
                <span className="loadingDot"></span>
                <span className="loadingDot"></span>
              </div>
            </div>
          </div>
        ) : groupedMessages.length === 0 ? (
          <div className="noMessages">
            <p>No messages yet. Start the conversation below!</p>
          </div>
        ) : (
          <>
            {groupedMessages.map((item, index) => (
              <div
                key={index}
                ref={(el) => {
                  if (el) {
                    messageRefs.current.set(item.messageIndex, el);
                  } else {
                    messageRefs.current.delete(item.messageIndex);
                  }
                }}
              >
                {item.type === 'message' ? (
                  <ConversationMessage
                    message={item.data as Message}
                    onShowDiff={handleShowDiff}
                    onQuestionClick={handleQuestionClick}
                    onOpenFile={handleOpenFile}
                    isSearchComplete={hasSearchResult}
                    hideContexts={!conversationReviewId}
                    showQuestions={
                      shouldShowQuestions &&
                      lastAssistantMessage &&
                      (item.data as Message).id === lastAssistantMessage.id
                    }
                  />
                ) : (
                  <ToolMessageAccordion messages={item.data as Message[]} />
                )}
              </div>
            ))}
          </>
        )}

        {/* Show loading indicator when AI is responding */}
        {(isSending || isAwaitingResponse) && groupedMessages.length > 0 && (lastSearchProgressId === null || hasSearchResult) && (
          <div className="conversationMessage assistant">
            <div className="messageContent">
              <div className="messageLoading">
                <span className="loadingDot"></span>
                <span className="loadingDot"></span>
                <span className="loadingDot"></span>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="conversationInput">
        {sendError && (
          <div className="sendError">
            <span className="errorIcon">⚠️</span>
            <span>{sendError}</span>
          </div>
        )}

        <form onSubmit={handleSendMessage}>
          <div
            className={`inputWrapper${isDragOver ? ' dragOver' : ''}`}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div className={`messageInputContainer${isSending || disableMessageInput ? ' disabled' : ''}`}>
              {/* @ mention dropdown */}
              {mentionQuery !== null && filteredMentionFiles.length > 0 && (
                <div className="mentionDropdown" ref={mentionDropdownRef}>
                  {filteredMentionFiles.map((material, idx) => (
                    <button
                      key={material.id}
                      type="button"
                      className={`mentionDropdownItem${idx === mentionActiveIndex ? ' active' : ''}`}
                      onMouseDown={(e) => { e.preventDefault(); handleMentionSelect(material); }}
                      onMouseEnter={() => setMentionActiveIndex(idx)}
                      ref={el => {
                        if (el && idx === mentionActiveIndex) {
                          el.scrollIntoView({ block: 'nearest' });
                        }
                      }}
                    >
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="mentionDropdownItemIcon">
                        <path d="M9 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6L9 2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        <path d="M9 2v4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      <span className="mentionDropdownItemName">{material.file_name}</span>
                    </button>
                  ))}
                </div>
              )}
              {attachedFiles.length > 0 && (
                <div className="attachedFilesRow">
                  {attachedFiles.map(f => (
                    <div key={f.localId} className="fileChip fileChip--done">
                      <svg className="fileChipIcon" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M9 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6L9 2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        <path d="M9 2v4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      <span className="fileChipName">{f.name}</span>
                      <button
                        type="button"
                        className="fileChipRemove"
                        onClick={() => removeAttachedFile(f.localId)}
                        aria-label={`Remove ${f.name}`}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                ref={textareaRef}
                className="messageInput"
                value={inputValue}
                onChange={(e) => {
                  const val = e.target.value;
                  setInputValue(val);
                  const el = e.target;
                  el.style.height = 'auto';
                  el.style.height = `${el.scrollHeight}px`;
                  // Detect @ mention
                  const cursorPos = e.target.selectionStart ?? val.length;
                  const textBeforeCursor = val.slice(0, cursorPos);
                  const atMatch = textBeforeCursor.match(/@([\w.]*)$/);
                  if (atMatch) {
                    setMentionAnchorIndex(cursorPos - atMatch[0].length);
                    setMentionQuery(atMatch[1]);
                  } else {
                    setMentionQuery(null);
                  }
                }}
                onKeyDown={handleKeyDown}
                placeholder={
                  disableMessageInput && previousManuscriptName
                    ? `Input disabled because this conversation is based on a previous manuscript: ${previousManuscriptName}`
                    : "Ask anything..."
                }
                rows={1}
                disabled={isSending || disableMessageInput}
              />
              <div className="inputToolbar">
                <div className="inputToolbarLeft">
                  <button
                    type="button"
                    className="attachButton"
                    onClick={(window as any).electronAPI?.invoke ? handleAttachClick : handleAttachClickOverlay}
                    disabled={!projectId || isSending || disableMessageInput}
                    title="Attach supporting file"
                    aria-label="Attach supporting file"
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <line x1="7" y1="1" x2="7" y2="13"/>
                      <line x1="1" y1="7" x2="13" y2="7"/>
                    </svg>
                  </button>
                </div>
                <button
                  type="submit"
                  className="sendButton"
                  disabled={
                    (!inputValue.trim() && attachedFiles.length === 0) ||
                    isSending
                  }
                  aria-label={isSending ? 'Sending...' : 'Send message'}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M8 12V4M4 8l4-4 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
              </div>
            </div>
            {isDragOver && (
              <div className="dragOverlay">
                <span>Drop files to attach</span>
              </div>
            )}
          </div>
        </form>

        {/* Feedback Link */}
        {!currentIsDraft && groupedMessages.length > 0 && feedbackFormUrl && conversationReviewId && (
          <a
            href="#"
            className="feedbackLink"
            onClick={(e) => {
              e.preventDefault();
              handleOpenFeedback();
            }}
          >
            Provide feedback on this review
          </a>
        )}
      </div>

      {/* Diff Modal */}
      {showDiffModal && (
        <DiffModal
          diffData={diffData}
          isLoading={isDiffLoading}
          error={diffError}
          onClose={() => setShowDiffModal(false)}
        />
      )}
    </div>
  );
}
