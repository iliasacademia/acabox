import React, { useEffect } from 'react';
import { Project } from '../services/projectsApi';
import ProjectCard from './ProjectCard';
import { categorizeProjects, getCategoryOrder } from '../utils/dateUtils';
import { trackProjectsView, trackNewProjectClick } from '../utils/analytics';
import { FEATURES } from '../../shared/types';

interface ProjectsListProps {
  projects: Project[];
  loading: boolean;
  onCreateProject: () => void;
  onSelectProject: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
}

const ProjectsList: React.FC<ProjectsListProps> = ({
  projects,
  loading,
  onCreateProject,
  onSelectProject,
  onDeleteProject,
}) => {
  // Track projects list view when component mounts
  useEffect(() => {
    trackProjectsView();
  }, []);

  // Categorize and sort projects
  const categorizedProjects = categorizeProjects(projects);
  const categoryOrder = getCategoryOrder();

  const handleCreateClick = () => {
    trackNewProjectClick();
    onCreateProject();
  };

  return (
    <div className="projectsList">
      {/* Header Section */}
      <div className="projectsListHeader">
        <h1 className="projectsListTitle">Research projects</h1>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <button className="createProjectButton" onClick={handleCreateClick}>
            <span className="buttonIcon">+</span>
            {FEATURES.ONBOARDING_V2_ENABLED ? 'New file to review' : 'Create new project'}
          </button>
          {FEATURES.ONBOARDING_V2_ENABLED && (
            <span className="supportedFileTypeLabel">Supported file types: Docx, Md</span>
          )}
        </div>
      </div>

      {/* Content Section */}
      <div className="projectsListContent">
        {loading ? (
          <div className="projectsLoading">Loading projects...</div>
        ) : projects.length === 0 ? (
          <div className="projectsEmpty">
            <p className="projectsEmptyText">
              {FEATURES.ONBOARDING_V2_ENABLED
                ? 'No files yet. Select a .docx or .md file to get started!'
                : 'No projects yet. Create your first project to get started!'}
            </p>
          </div>
        ) : (
          <>
            {categoryOrder.map((category) => {
              const categoryProjects = categorizedProjects[category];

              // Skip empty categories
              if (categoryProjects.length === 0) return null;

              return (
                <div className="projectsSection" key={category}>
                  <h2 className="projectsSectionHeader">{category}</h2>
                  <div className="projectsSectionGrid">
                    {categoryProjects.map((project) => (
                      <ProjectCard
                        key={project.id}
                        project={project}
                        onClick={() => onSelectProject(project)}
                        onDelete={() => onDeleteProject(project)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
};

export default ProjectsList;
