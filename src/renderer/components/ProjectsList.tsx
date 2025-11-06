import React from 'react';
import { Project } from '../services/projectsApi';
import ProjectCard from './ProjectCard';

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
  return (
    <div className="projectsList">
      {/* Header Section */}
      <div className="projectsListHeader">
        <h1 className="projectsListTitle">Research projects</h1>
        <button className="createProjectButton" onClick={onCreateProject}>
          <span className="buttonIcon">+</span>
          Create new project
        </button>
      </div>

      {/* Content Section */}
      <div className="projectsListContent">
        {loading ? (
          <div className="projectsLoading">Loading projects...</div>
        ) : projects.length === 0 ? (
          <div className="projectsEmpty">
            <p className="projectsEmptyText">
              No projects yet. Create your first project to get started!
            </p>
          </div>
        ) : (
          <div className="projectsGrid">
            {projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                onClick={() => onSelectProject(project)}
                onDelete={() => onDeleteProject(project)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default ProjectsList;
