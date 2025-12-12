// Main exports for @academia/shared-conversations

// CSS Styles
import './styles/conversations.css';

// Components
export { ConversationsPage } from './components/ConversationsPage';
export type { ConversationsPageProps } from './components/ConversationsPage';

export { ConversationDetail } from './components/ConversationDetail';
export { ConversationsSidebar } from './components/ConversationsSidebar';
export { ConversationMessage } from './components/ConversationMessage';
export { ToolMessageAccordion } from './components/ToolMessageAccordion';
export { default as DiffModal } from './components/DiffModal';
export { default as SplitDiffViewer } from './components/SplitDiffViewer';
export { DateDivider } from './components/DateDivider';

// Context and Provider
export { ApiProvider, useApiClient } from './context/ApiContext';

// API Hooks
export { useConversationsApi } from './api/useConversationsApi';
export { useProjectsApi } from './api/useProjectsApi';

// Custom Hooks
export { useConversationPolling } from './hooks/useConversationPolling';

// Types
export type {
  ConversationsApiClient,
  ApiCallOptions,
} from './types/api';

export type {
  Message,
  MessageContext,
  Conversation,
  DraftConversation,
  ConversationDetail as ConversationDetailType,
  ListConversationsResponse,
} from './types/conversation';

export type {
  Project,
  ProjectFile,
  LastReview,
  DiffResponse,
  AgentRun,
  ReviewData,
  ReviewSuggestion,
  ProjectStatusResponse,
} from './types/project';

// Utility functions
export { formatConversationTitle, generateDailyFeedbackTitle } from './components/utils';
