import React, { useState, useEffect } from 'react';
import { LocalConversationsPage } from './LocalConversationsPage';
import { Project } from '../../../../packages/shared-conversations/src';
import { getProjectFiles } from '../../services/projectsApi';

interface LocalConversationsPageWrapperProps {
  userId: number | null;
  selectedProject: Project | null;
  onBack: () => void;
}

export const LocalConversationsPageWrapper: React.FC<LocalConversationsPageWrapperProps> = ({
  selectedProject,
  onBack,
}) => {
  const [manuscriptFilePath, setManuscriptFilePath] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedProject) {
      setManuscriptFilePath(null);
      return;
    }

    getProjectFiles(selectedProject.id).then((files) => {
      const primaryManuscript = files.find((f) => f.is_primary_manuscript);
      setManuscriptFilePath(primaryManuscript?.file_path ?? null);
    }).catch(() => {
      setManuscriptFilePath(null);
    });
  }, [selectedProject]);

  return (
    <LocalConversationsPage
      onSwitchToRegularMode={onBack}
      manuscriptFilePath={manuscriptFilePath}
    />
  );
};

export default LocalConversationsPageWrapper;
