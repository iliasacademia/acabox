import React from 'react';
import { ProjectFile, ProjectFolder, Collaborator } from '../services/mockProjectsApi';

interface ProjectSidebarProps {
  manuscript: ProjectFile | null;
  folders: ProjectFolder[];
  collaborators: Collaborator[];
  onAddFolder: () => void;
  onAddCollaborator: () => void;
}

const ProjectSidebar: React.FC<ProjectSidebarProps> = ({
  manuscript,
  folders,
  collaborators,
  onAddFolder,
  onAddCollaborator,
}) => {
  return (
    <div className="projectSidebar">
      {/* Manuscript Section */}
      <div className="sidebarSection">
        <div className="sidebarSectionHeader">
          <h3 className="sidebarSectionTitle">Manuscript</h3>
        </div>
        {manuscript ? (
          <div className="sidebarItem">
            <div className="sidebarItemIcon">📄</div>
            <div className="sidebarItemContent">
              <div className="sidebarItemName">{manuscript.file_name}</div>
              {manuscript.is_primary_manuscript && (
                <div className="sidebarItemBadge">
                  <span className="checkIcon">✓</span>
                  Primary
                </div>
              )}
            </div>
            <button className="sidebarItemMenu" title="More options">
              ⋮
            </button>
          </div>
        ) : (
          <div className="sidebarEmpty">No manuscript selected</div>
        )}
      </div>

      {/* Folders Section */}
      <div className="sidebarSection">
        <div className="sidebarSectionHeader">
          <h3 className="sidebarSectionTitle">Folders</h3>
          <button className="sidebarAddButton" onClick={onAddFolder} title="Add folder">
            +
          </button>
        </div>
        {folders.length > 0 ? (
          <div className="sidebarList">
            {folders.map((folder) => (
              <div key={folder.id} className="sidebarItem">
                <div className="sidebarItemIcon">📁</div>
                <div className="sidebarItemContent">
                  <div className="sidebarItemName">{folder.folder_name}</div>
                  {folder.synced && (
                    <div className="sidebarItemBadge">
                      <span className="checkIcon">✓</span>
                      Synced
                    </div>
                  )}
                </div>
                <button className="sidebarItemMenu" title="More options">
                  ⋮
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="sidebarEmpty">No folders added</div>
        )}
      </div>

      {/* Collaborators Section */}
      <div className="sidebarSection">
        <div className="sidebarSectionHeader">
          <h3 className="sidebarSectionTitle">Collaborators</h3>
          <button
            className="sidebarAddButton"
            onClick={onAddCollaborator}
            title="Add collaborator"
          >
            +
          </button>
        </div>
        {collaborators.length > 0 ? (
          <div className="sidebarList">
            {collaborators.map((collaborator) => (
              <div key={collaborator.id} className="sidebarItem">
                <div className="sidebarItemIcon">👤</div>
                <div className="sidebarItemContent">
                  <div className="sidebarItemName">
                    {collaborator.name || collaborator.email}
                  </div>
                  <div className="sidebarItemSubtext">
                    {collaborator.status === 'pending' ? 'Invited' : collaborator.role}
                  </div>
                </div>
                <button className="sidebarItemMenu" title="More options">
                  ⋮
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="sidebarEmpty">No collaborators yet</div>
        )}
      </div>
    </div>
  );
};

export default ProjectSidebar;
