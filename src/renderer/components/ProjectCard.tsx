import React from 'react';
import { Project } from '../services/mockProjectsApi';

interface ProjectCardProps {
  project: Project;
  onClick: () => void;
  onDelete: () => void;
}

const ProjectCard: React.FC<ProjectCardProps> = ({ project, onClick, onDelete }) => {
  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent card click
    onDelete();
  };

  return (
    <div className="projectCard" onClick={onClick}>
      <div className="projectCardHeader">
        <h3 className="projectCardTitle">{project.name}</h3>
        <button
          className="projectCardDelete"
          onClick={handleDeleteClick}
          title="Delete project"
        >
          ×
        </button>
      </div>

      {project.description && (
        <p className="projectCardDescription">{project.description}</p>
      )}

      <div className="projectCardMeta">
        <div className="projectCardMetaRow">
          <span className="projectCardMetaItem">
            {project.file_count} {project.file_count === 1 ? 'file' : 'files'}
          </span>
          <span className="projectCardMetaItem">
            {project.folder_count} {project.folder_count === 1 ? 'folder' : 'folders'}
          </span>
          {project.collaborator_count > 0 && (
            <span className="projectCardMetaItem">
              {project.collaborator_count} {project.collaborator_count === 1 ? 'collaborator' : 'collaborators'}
            </span>
          )}
        </div>
        <div className="projectCardDate">
          Created: {formatDate(project.created_at)}
        </div>
      </div>
    </div>
  );
};

export default ProjectCard;
