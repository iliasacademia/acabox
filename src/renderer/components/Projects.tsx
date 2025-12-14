import React, { useState, useEffect } from 'react';
import ProjectsList from './ProjectsList';
import ProjectDetail from './ProjectDetail';
import CreateProjectWizard, {
  ProjectCreationData,
} from './CreateProjectWizard';
import AlertDialog from './AlertDialog';
import ConfirmDialog from './ConfirmDialog';
import {
  Project,
  getProjects,
  createProject,
  deleteProject,
  addFolderToProject,
  addCollaborator,
  extractErrorMessage,
} from '../services/projectsApi';
import { FEATURES, IPC_CHANNELS, NavigateToPagePayload } from '../../shared/types';
import { ConversationsPageWrapper } from './conversations/ConversationsPageWrapper';
import './Projects.css';

type View = 'list' | 'detail';

interface DialogState {
  type: 'alert' | 'confirm' | null;
  title: string;
  message: string;
  onConfirm?: () => void;
}

interface ProjectsProps {
  userId: number | null;
  userName: string | null;
  onLogout: () => void;
  onLoginRequired: () => void;
  pendingNavigation: NavigateToPagePayload | null;
  onNavigationHandled: () => void;
}

const Projects: React.FC<ProjectsProps> = ({ userId, userName, onLogout, onLoginRequired, pendingNavigation, onNavigationHandled }) => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentView, setCurrentView] = useState<View>('list');
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [showCreateWizard, setShowCreateWizard] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [dialog, setDialog] = useState<DialogState>({
    type: null,
    title: '',
    message: '',
  });
  const [pendingConversationId, setPendingConversationId] = useState<number | null>(null);

  // Derive isLoggedIn from userId prop
  const isLoggedIn = !!userId;

  // Load projects when logged in
  useEffect(() => {
    if (isLoggedIn) {
      loadProjects();
    } else {
      // Clear state when logged out
      setProjects([]);
      setLoading(false);
    }
  }, [isLoggedIn]);

  // Close user menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (showUserMenu && !target.closest('.projectsUserMenu')) {
        setShowUserMenu(false);
      }
    };

    if (showUserMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showUserMenu]);

  // Handle navigation from App (triggered by notification clicks)
  useEffect(() => {
    if (!pendingNavigation) return;

    console.log('[Projects] Handling pending navigation:', pendingNavigation);

    if (pendingNavigation.page === 'conversation') {
      // Find the project in our local state
      const targetProject = projects.find(p => p.id === pendingNavigation.projectId);

      if (targetProject) {
        console.log('[Projects] Navigating to project:', targetProject.name, 'conversation:', pendingNavigation.conversationId);
        setSelectedProject(targetProject);
        setCurrentView('detail');
        setPendingConversationId(pendingNavigation.conversationId);
        onNavigationHandled();
      } else {
        console.warn('[Projects] Project not found for navigation:', pendingNavigation.projectId);
        // Project might not be loaded yet, try to reload projects
        loadProjects().then(() => {
          const project = projects.find(p => p.id === pendingNavigation.projectId);
          if (project) {
            setSelectedProject(project);
            setCurrentView('detail');
            setPendingConversationId(pendingNavigation.conversationId);
          }
          onNavigationHandled();
        });
      }
    } else {
      onNavigationHandled();
    }
  }, [pendingNavigation, projects, onNavigationHandled]);

  const loadProjects = async () => {
    try {
      setLoading(true);
      const projectsData = await getProjects();
      setProjects(projectsData);
    } catch (error) {
      console.error('Error loading projects:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleLogoutClick = () => {
    setShowUserMenu(false);
    setProjects([]);
    setCurrentView('list');
    setSelectedProject(null);
    onLogout();
  };

  const handleCreateProject = () => {
    setShowCreateWizard(true);
  };

  const handleWizardComplete = async (data: ProjectCreationData) => {
    setCreatingProject(true);
    try {
      console.log('[Projects] Creating project with data:', data);

      // 1. Create project atomically with single folder
      const newProject = await createProject({
        name: data.name,
        description: data.description,
        folder_path: data.folder, // Single folder (atomic)
      });
      console.log('[Projects] Project created:', newProject);

      // 2. Start syncing the folder (if provided)
      if (data.folder) {
        console.log('[Projects] Starting sync for folder:', data.folder);

        // Fetch the folder to get its ID
        const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
          method: 'GET',
          endpoint: `v0/co_scientist/projects/${newProject.id}/folders`,
        });
        const createdFolders = response.folders || [];
        const folder = createdFolders.find((f: any) => f.folder_path === data.folder);

        if (folder) {
          console.log('[Projects] Retrieved folder:', folder);

          // Check if manuscript is in this folder
          const manuscriptInThisFolder = data.primaryManuscriptPath?.startsWith(data.folder)
            ? data.primaryManuscriptPath
            : undefined;

          if (manuscriptInThisFolder) {
            console.log('[Projects] Manuscript will be tagged during sync:', manuscriptInThisFolder);
          }

          // Start syncing files from this folder
          const syncResult = await window.electronAPI.invoke(
            'start-project-folder-sync',
            newProject.id,
            folder.id,
            data.folder,
            manuscriptInThisFolder
          );

          if (!syncResult.success) {
            console.error(`[Projects] Failed to start sync:`, syncResult.error);
            setDialog({
              type: 'alert',
              title: 'Sync Warning',
              message: `Folder created but sync failed: ${syncResult.error}`,
            });
          } else {
            console.log(`[Projects] Successfully started syncing folder`);
          }
        } else {
          console.error(`[Projects] Could not find folder ID for path: ${data.folder}`);
        }
      } else {
        console.log('[Projects] No folder to sync');
      }

      // 3. Add collaborators to the project
      if (data.collaboratorEmails && data.collaboratorEmails.length > 0) {
        for (const email of data.collaboratorEmails) {
          try {
            await addCollaborator(newProject.id, email);
          } catch (error) {
            console.error(`Failed to add collaborator ${email}:`, error);
          }
        }
      }

      // 4. Primary manuscript is now handled during folder sync above
      // The manuscript file is tagged with 'manuscript' when uploaded
      if (data.primaryManuscriptPath) {
        console.log('[Projects] Primary manuscript tagged during sync:', data.primaryManuscriptPath);
      }

      setProjects([newProject, ...projects]);
      setShowCreateWizard(false);

      // Refresh manuscript paths to include new project's manuscripts
      await window.electronAPI.invoke(IPC_CHANNELS.REFRESH_MANUSCRIPT_PATHS);

      // Navigate to the new project
      setSelectedProject(newProject);
      setCurrentView('detail');
    } catch (error) {
      console.error('Error creating project:', error);

      // Extract user-friendly error message (includes folder validation errors)
      const errorMessage = extractErrorMessage(error, 'Failed to create project. Please try again.');

      setDialog({
        type: 'alert',
        title: 'Error',
        message: errorMessage,
      });
    } finally {
      setCreatingProject(false);
    }
  };

  const handleSelectProject = (project: Project) => {
    setSelectedProject(project);
    setCurrentView('detail');
  };

  const handleDeleteProject = async (project: Project) => {
    setDialog({
      type: 'confirm',
      title: 'Delete Project',
      message: `Are you sure you want to delete "${project.name}"?`,
      onConfirm: async () => {
        setDialog({ type: null, title: '', message: '' });
        try {
          // Clean up local sync state before deleting from backend
          await window.electronAPI.invoke('stop-project-sync', project.id);

          const success = await deleteProject(project.id);
          if (success) {
            // Refresh manuscript paths to remove deleted project's manuscripts
            await window.electronAPI.invoke('refresh-manuscript-paths');

            // Clear notifications for deleted project
            await window.electronAPI.invoke('clear-notifications-for-project', project.id);

            setProjects(projects.filter((p) => p.id !== project.id));

            // If we're viewing the deleted project, go back to list
            if (selectedProject?.id === project.id) {
              setCurrentView('list');
              setSelectedProject(null);
            }
          }
        } catch (error) {
          console.error('Error deleting project:', error);
          setDialog({
            type: 'alert',
            title: 'Error',
            message: 'Failed to delete project. Please try again.',
          });
        }
      },
    });
  };

  const handleBackToList = () => {
    setCurrentView('list');
    setSelectedProject(null);
    setPendingConversationId(null);
  };

  // Clear pending conversation ID after it's been used by ConversationsPage
  const handleConversationNavigated = () => {
    setPendingConversationId(null);
  };

  // Request login if not logged in
  useEffect(() => {
    if (!isLoggedIn) {
      onLoginRequired();
    }
  }, [isLoggedIn, onLoginRequired]);

  // Main projects UI
  return (
    <div className="projectsContainer">
      {/* Header with logo and avatar - only show on list view */}
      {currentView === 'list' && (
        <div className="projectsHeader">
          <div className="projectsLogo">
            <span className="logoText">A</span>
          </div>
          <div className="projectsUserMenu">
            <div className="userAvatar" onClick={() => setShowUserMenu(!showUserMenu)}>
              <span className="avatarInitial">
                {userName ? userName.charAt(0).toUpperCase() : (userId ? userId.toString()[0] : 'U')}
              </span>
            </div>
            {showUserMenu && (
              <div className="userMenuDropdown">
                <div className="userMenuHeader">
                  <div className="userMenuName">{userName || `User ${userId}`}</div>
                </div>
                <div className="userMenuDivider"></div>
                <button className="userMenuItem" onClick={handleLogoutClick}>
                  <span>Logout</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="projectsMain">
        <>
          {currentView === 'list' ? (
            <ProjectsList
              projects={projects}
              loading={loading}
              onCreateProject={handleCreateProject}
              onSelectProject={handleSelectProject}
              onDeleteProject={handleDeleteProject}
            />
          ) : currentView === 'detail' && selectedProject ? (
            FEATURES.CONVERSATIONS_ENABLED ? (
              <ConversationsPageWrapper
                selectedProject={selectedProject}
                onBack={handleBackToList}
                initialConversationId={pendingConversationId}
                onConversationNavigated={handleConversationNavigated}
              />
            ) : (
              <ProjectDetail project={selectedProject} onBack={handleBackToList} />
            )
          ) : null}
        </>
      </div>

      {/* Create Project Wizard Modal */}
      {showCreateWizard && (
        <CreateProjectWizard
          onClose={() => !creatingProject && setShowCreateWizard(false)}
          onComplete={handleWizardComplete}
          isCreating={creatingProject}
        />
      )}

      {/* Alert Dialog */}
      {dialog.type === 'alert' && (
        <AlertDialog
          title={dialog.title}
          message={dialog.message}
          onClose={() => setDialog({ type: null, title: '', message: '' })}
        />
      )}

      {/* Confirm Dialog */}
      {dialog.type === 'confirm' && dialog.onConfirm && (
        <ConfirmDialog
          title={dialog.title}
          message={dialog.message}
          onConfirm={dialog.onConfirm}
          onCancel={() => setDialog({ type: null, title: '', message: '' })}
        />
      )}
    </div>
  );
};

export default Projects;
