import React, { useState, useEffect } from 'react';
import LoginModal from './LoginModal';
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
  updateProject,
  deleteProject,
  addFolderToProject,
  addCollaborator,
} from '../services/projectsApi';
import { FEATURES } from '../../shared/types';
import { ConversationsPage } from './conversations/ConversationsPage';
import './Projects.css';

type View = 'list' | 'detail';

interface DialogState {
  type: 'alert' | 'confirm' | null;
  title: string;
  message: string;
  onConfirm?: () => void;
}

interface UserData {
  id: number;
  first_name?: string;
  name?: string;
}

const Projects: React.FC = () => {
  const [showLogin, setShowLogin] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [userId, setUserId] = useState<number | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
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

  useEffect(() => {
    checkLoginStatus();

    // Listen for API logs from main process
    const handleApiLog = (_event: any, logData: any) => {
      if (logData.type === 'request') {
        console.log(
          `%c[API REQUEST] ${logData.method} ${logData.endpoint}`,
          'color: #0645b1; font-weight: bold',
          logData.data || ''
        );
      } else if (logData.type === 'response') {
        console.log(
          `%c[API RESPONSE] ${logData.method} ${logData.endpoint} - ${logData.status} ${logData.statusText}`,
          'color: #28a745; font-weight: bold'
        );
      } else if (logData.type === 'error') {
        console.error(
          `%c[API ERROR] ${logData.method} ${logData.endpoint} - ${logData.status || 'No status'}`,
          'color: #dc3545; font-weight: bold',
          {
            url: logData.url,
            message: logData.message,
            data: logData.data,
          }
        );
      }
    };

    window.electronAPI.on('api-log', handleApiLog);

    return () => {
      window.electronAPI.removeListener('api-log', handleApiLog);
    };
  }, []);

  useEffect(() => {
    if (isLoggedIn) {
      loadProjects();
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

  const checkLoginStatus = async () => {
    try {
      const loggedIn = await window.electronAPI.invoke('check-login');

      // Validate response
      if (typeof loggedIn !== 'boolean') {
        throw new Error('Invalid login status response');
      }

      setIsLoggedIn(loggedIn);
      if (!loggedIn) {
        setShowLogin(true);
        setUserId(null);
        setUserName(null);
      } else {
        // Get current user with validation
        const user = await window.electronAPI.invoke('get-current-user');

        // Validate user object
        if (!user || typeof user !== 'object') {
          throw new Error('Invalid user data received');
        }

        if (typeof user.id !== 'number') {
          throw new Error('Invalid user ID');
        }

        setUserId(user.id);
        setUserName(user.first_name || user.name || null);
      }
    } catch (error) {
      console.error('Error checking login status:', error);
      // Force logout on authentication errors
      setIsLoggedIn(false);
      setShowLogin(true);
      setUserId(null);
      setUserName(null);

      // Show error to user
      setDialog({
        type: 'alert',
        title: 'Authentication Error',
        message: 'Unable to verify login status. Please log in again.',
      });
    } finally {
      setLoading(false);
    }
  };

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

  const handleLoginSuccess = async () => {
    setShowLogin(false);
    setIsLoggedIn(true);

    // Get user ID after successful login with validation
    try {
      const user = await window.electronAPI.invoke('get-current-user');

      // Validate user object
      if (!user || typeof user !== 'object') {
        throw new Error('Invalid user data received after login');
      }

      if (typeof user.id !== 'number') {
        throw new Error('Invalid user ID received after login');
      }

      setUserId(user.id);
      setUserName(user.first_name || user.name || null);
    } catch (error) {
      console.error('Error getting current user:', error);
      // Reset authentication state on error
      setIsLoggedIn(false);
      setShowLogin(true);
      setUserId(null);
      setUserName(null);

      setDialog({
        type: 'alert',
        title: 'Login Error',
        message: 'Login succeeded but failed to retrieve user information. Please try again.',
      });
    }
  };

  const handleLogout = async () => {
    setShowUserMenu(false);
    try {
      const result = await window.electronAPI.invoke('logout');
      if (result.success) {
        setIsLoggedIn(false);
        setShowLogin(true);
        setUserId(null);
        setUserName(null);
        setProjects([]);
        setCurrentView('list');
        setSelectedProject(null);
      }
    } catch (error) {
      console.error('Error logging out:', error);
    }
  };

  const handleCreateProject = () => {
    setShowCreateWizard(true);
  };

  const handleWizardComplete = async (data: ProjectCreationData) => {
    setCreatingProject(true);
    try {
      console.log('[Projects] Creating project with data:', data);

      // 1. Create the project
      const newProject = await createProject({
        name: data.name,
        description: data.description,
      });
      console.log('[Projects] Project created:', newProject);

      // 2. Add folders to the project and start syncing
      if (data.folders && data.folders.length > 0) {
        console.log('[Projects] Adding and syncing', data.folders.length, 'folders');

        for (const folderPath of data.folders) {
          try {
            console.log('[Projects] Adding folder to project:', folderPath);

            // Add folder to project (returns folder with ID)
            const folder = await addFolderToProject(newProject.id, folderPath);
            console.log('[Projects] Folder added to project:', folder);

            // Check if manuscript is in this folder
            const manuscriptInThisFolder = data.primaryManuscriptPath?.startsWith(folderPath)
              ? data.primaryManuscriptPath
              : undefined;

            if (manuscriptInThisFolder) {
              console.log('[Projects] Manuscript will be tagged during sync:', manuscriptInThisFolder);
            }

            // Start syncing files from this folder
            console.log('[Projects] Starting sync for folder:', folderPath);
            const syncResult = await window.electronAPI.invoke(
              'start-project-folder-sync',
              newProject.id,
              folder.id,
              folderPath,
              manuscriptInThisFolder
            );

            if (!syncResult.success) {
              console.error(`[Projects] Failed to start sync for folder ${folderPath}:`, syncResult.error);
              setDialog({
                type: 'alert',
                title: 'Sync Warning',
                message: `Folder added but sync failed: ${syncResult.error}`,
              });
            } else {
              console.log(`[Projects] Successfully started syncing folder ${folderPath}`);
            }
          } catch (error) {
            console.error(`[Projects] Failed to add folder ${folderPath}:`, error);
            setDialog({
              type: 'alert',
              title: 'Error',
              message: `Failed to add folder: ${folderPath}`,
            });
          }
        }
      } else {
        console.log('[Projects] No folders to add');
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

      // Navigate to the new project
      setSelectedProject(newProject);
      setCurrentView('detail');
    } catch (error) {
      console.error('Error creating project:', error);
      setDialog({
        type: 'alert',
        title: 'Error',
        message: 'Failed to create project. Please try again.',
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
          const success = await deleteProject(project.id);
          if (success) {
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
  };

  // Show login modal if not logged in
  if (showLogin) {
    return <LoginModal onSuccess={handleLoginSuccess} />;
  }

  // Main projects UI
  return (
    <div className="projectsContainer">
      {/* Header with logo and avatar */}
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
              <button className="userMenuItem" onClick={handleLogout}>
                <span>Logout</span>
              </button>
            </div>
          )}
        </div>
      </div>

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
              <ConversationsPage selectedProject={selectedProject} onBack={handleBackToList} />
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
