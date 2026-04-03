import React from 'react';
import { LocalConversationsPage } from './LocalConversationsPage';
import { Project } from '../../../../packages/shared-conversations/src';

interface LocalConversationsPageWrapperProps {
  userId: number | null;
  selectedProject: Project | null;
  onBack: () => void;
}

export const LocalConversationsPageWrapper: React.FC<LocalConversationsPageWrapperProps> = ({
  onBack,
}) => {
  return <LocalConversationsPage onSwitchToRegularMode={onBack} />;
};

export default LocalConversationsPageWrapper;
