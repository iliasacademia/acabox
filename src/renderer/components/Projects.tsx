import React, { useState, useEffect } from 'react';
import ProjectsList from './ProjectsList';
import ProjectDetail from './ProjectDetail';
import CreateProjectWizard, {
  ProjectCreationData,
} from './CreateProjectWizard';
import SupportingMaterialsModal from './SupportingMaterialsModal';
import AlertDialog from './AlertDialog';
import ConfirmDialog from './ConfirmDialog';
import { SettingsModal } from './SettingsModal';
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
import {
  trackV2FilePickerOpen,
  trackV2FileSelected,
  trackV2ProjectCreated,
  trackSupportingMaterialsView,
  trackSupportingMaterialsAdd,
  trackSupportingMaterialsSkip,
} from '../utils/analytics';
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
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [dialog, setDialog] = useState<DialogState>({
    type: null,
    title: '',
    message: '',
  });
  const [pendingConversationId, setPendingConversationId] = useState<number | null>(null);
  const [pendingDiffModal, setPendingDiffModal] = useState<boolean>(false);
  const [pendingInitialView, setPendingInitialView] = useState<'conversation' | 'supporting-materials' | undefined>(undefined);
  const [showSupportingMaterialsModal, setShowSupportingMaterialsModal] = useState(false);
  const [v2PendingFile, setV2PendingFile] = useState<{
    filePath: string;
    fileName: string;
    projectName: string;
  } | null>(null);

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

    if (pendingNavigation.page === 'conversation' || pendingNavigation.page === 'conversations') {
      // Find the project in our local state
      const targetProject = projects.find(p => p.id === pendingNavigation.projectId);

      if (targetProject) {
        console.log('[Projects] Navigating to project:', targetProject.name, 'conversation:', pendingNavigation.conversationId);
        setSelectedProject(targetProject);
        setCurrentView('detail');
        // Only set pending conversation ID for specific conversation navigation
        if (pendingNavigation.page === 'conversation' && pendingNavigation.conversationId) {
          console.log('[Projects] Setting pending conversation ID:', pendingNavigation.conversationId);
          console.log('[Projects] Setting pending diff modal:', pendingNavigation.openDiffModal ?? false);
          setPendingConversationId(pendingNavigation.conversationId);
          setPendingDiffModal(pendingNavigation.openDiffModal ?? false);
        }
        onNavigationHandled();
      } else {
        console.warn('[Projects] Project not found for navigation:', pendingNavigation.projectId);
        // Project might not be loaded yet, try to reload projects
        loadProjects().then(() => {
          const project = projects.find(p => p.id === pendingNavigation.projectId);
          if (project) {
            setSelectedProject(project);
            setCurrentView('detail');
            if (pendingNavigation.page === 'conversation' && pendingNavigation.conversationId) {
              setPendingConversationId(pendingNavigation.conversationId);
              setPendingDiffModal(pendingNavigation.openDiffModal ?? false);
            }
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

  const handleCreateProject = async () => {
    if (FEATURES.ONBOARDING_V2_ENABLED) {
      await handleV2CreateProject();
    } else {
      setShowCreateWizard(true);
    }
  };

  const handleV2CreateProject = async () => {
    trackV2FilePickerOpen();

    // 1. Open native file picker filtered to .docx
    const filePath = await window.electronAPI.invoke(
      IPC_CHANNELS.SELECT_FILE,
      { extensions: ['docx'] }
    );

    if (!filePath) return; // User cancelled

    // 2. Track file selection
    const lastSep = filePath.lastIndexOf('/');
    const fileName = lastSep >= 0 ? filePath.substring(lastSep + 1) : filePath;
    const dotIdx = fileName.lastIndexOf('.');
    const ext = dotIdx >= 0 ? fileName.substring(dotIdx + 1).toLowerCase() : '';
    trackV2FileSelected(ext);

    // 3. Derive project name from filename (strip extension)
    const projectName = dotIdx >= 0 ? fileName.substring(0, dotIdx) : fileName;

    // 4. Store file info and show modal immediately (no API calls yet)
    setV2PendingFile({ filePath, fileName, projectName });
    setShowSupportingMaterialsModal(true);
  };

  const handleSupportingMaterialsResult = async (action: 'add' | 'skip') => {
    if (!v2PendingFile) return;

    const { filePath, projectName } = v2PendingFile;

    setCreatingProject(true);
    try {
      // 1. Create the project (standalone file, no folder)
      const newProject = await createProject({
        name: projectName,
        file_path: filePath,
      });
      console.log(`[Projects-V2] Project created: ${JSON.stringify(newProject)}`);
      trackV2ProjectCreated(newProject.id);

      // 2. Track modal analytics retroactively (now we have the project ID)
      trackSupportingMaterialsView(newProject.id);
      if (action === 'add') {
        trackSupportingMaterialsAdd(newProject.id);
      } else {
        trackSupportingMaterialsSkip(newProject.id);
      }

      // 3. Start file sync (upload + watch)
      const syncResult = await window.electronAPI.invoke(
        IPC_CHANNELS.START_PROJECT_FILE_SYNC,
        newProject.id,
        filePath
      );

      if (!syncResult.success) {
        console.error(`[Projects-V2] File sync failed:`, syncResult.error);
        setDialog({
          type: 'alert',
          title: 'Sync Warning',
          message: `Project created but file sync failed: ${syncResult.error}`,
        });
      }

      // 4. Refresh manuscript paths
      await window.electronAPI.invoke(IPC_CHANNELS.REFRESH_MANUSCRIPT_PATHS);

      // 5. Update projects list and navigate to detail
      setProjects([newProject, ...projects]);
      setSelectedProject(newProject);
      setPendingInitialView(action === 'add' ? 'supporting-materials' : undefined);
      setCurrentView('detail');
    } catch (error) {
      console.error('[Projects-V2] Error creating project:', error);
      const errorMessage = extractErrorMessage(error, 'Failed to create project. Please try again.');
      setDialog({
        type: 'alert',
        title: 'Error',
        message: errorMessage,
      });
    } finally {
      setShowSupportingMaterialsModal(false);
      setV2PendingFile(null);
      setCreatingProject(false);
    }
  };

  const handleWizardComplete = async (data: ProjectCreationData) => {
    setCreatingProject(true);
    try {
      console.log('[Projects] Creating project with data:', data);

      // Standalone file path (no folder) — create project with file_path, upload + watch
      if (data.file && !data.folder) {
        const newProject = await createProject({
          name: data.name,
          description: data.description,
          file_path: data.file,
        });
        console.log(`[Projects] Project created (standalone file): ${JSON.stringify(newProject)}`);

        // Start file sync (upload + watch)
        const syncResult = await window.electronAPI.invoke(
          IPC_CHANNELS.START_PROJECT_FILE_SYNC,
          newProject.id,
          data.file
        );

        if (!syncResult.success) {
          console.error('[Projects] Failed to start file sync:', syncResult.error);
          setDialog({
            type: 'alert',
            title: 'Sync Warning',
            message: `Project created but file sync failed: ${syncResult.error}`,
          });
        }

        // Refresh manuscript paths for Word integration
        await window.electronAPI.invoke(IPC_CHANNELS.REFRESH_MANUSCRIPT_PATHS);

        // Navigate to project
        setProjects([newProject, ...projects]);
        setShowCreateWizard(false);
        setSelectedProject(newProject);
        setCurrentView('detail');
        return;
      }

      // 1. Create project atomically with single folder
      const newProject = await createProject({
        name: data.name,
        description: data.description,
        folder_path: data.folder, // Single folder (atomic)
      });
      console.log(`[Projects] Project created: ${JSON.stringify(newProject)}`);

      // 2. Start syncing the folder (if provided)
      if (data.folder) {
        console.log(`[Projects] Starting sync for folder: ${JSON.stringify(data.folder)}`);

        // Fetch the folder to get its ID
        const response = await window.electronAPI.invoke(IPC_CHANNELS.API_CALL, {
          method: 'GET',
          endpoint: `v0/co_scientist/projects/${newProject.id}/folders`,
        });
        const createdFolders = response.folders || [];
        const folder = createdFolders.find((f: any) => f.folder_path === data.folder);

        if (folder) {
          console.log(`[Projects] Retrieved folder: ${JSON.stringify(folder)}`);

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
          await window.electronAPI.invoke(IPC_CHANNELS.STOP_PROJECT_SYNC, project.id);

          const success = await deleteProject(project.id);
          if (success) {
            // Refresh manuscript paths to remove deleted project's manuscripts
            await window.electronAPI.invoke(IPC_CHANNELS.REFRESH_MANUSCRIPT_PATHS);

            // Clear notifications for deleted project
            await window.electronAPI.invoke(IPC_CHANNELS.CLEAR_NOTIFICATIONS_FOR_PROJECT, project.id);

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
    setPendingDiffModal(false);
    setPendingInitialView(undefined);
  };

  // Clear pending conversation ID after it's been used by ConversationsPage
  const handleConversationNavigated = () => {
    setPendingConversationId(null);
  };

  // Clear pending diff modal flag after ConversationDetail has opened the modal
  const handleDiffModalOpened = () => {
    setPendingDiffModal(false);
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

                {/* Settings menu item */}
                <button className="userMenuItem" onClick={() => {
                  setShowSettingsModal(true);
                  setShowUserMenu(false);
                }}>
                  <span>Settings</span>
                </button>

                {/* Logout button */}
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
                initialOpenDiffModal={pendingDiffModal}
                onDiffModalOpened={handleDiffModalOpened}
                initialView={pendingInitialView}
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

      {/* V2: Supporting Materials Modal */}
      {showSupportingMaterialsModal && v2PendingFile && (
        <SupportingMaterialsModal
          onAdd={() => handleSupportingMaterialsResult('add')}
          onSkip={() => handleSupportingMaterialsResult('skip')}
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

      {/* Settings Modal */}
      <SettingsModal
        isOpen={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
      />
    </div>
  );
};

export default Projects;
