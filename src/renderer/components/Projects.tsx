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
  deleteProject,
} from '../services/mockProjectsApi';
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
  const [dialog, setDialog] = useState<DialogState>({
    type: null,
    title: '',
    message: '',
  });

  useEffect(() => {
    checkLoginStatus();
  }, []);

  useEffect(() => {
    if (isLoggedIn) {
      loadProjects();
    }
  }, [isLoggedIn]);

  const checkLoginStatus = async () => {
    try {
      const loggedIn = await window.electronAPI.invoke('check-login');
      setIsLoggedIn(loggedIn);
      if (!loggedIn) {
        setShowLogin(true);
        setUserId(null);
        setUserName(null);
      } else {
        // Get current user
        const user = await window.electronAPI.invoke('get-current-user');
        if (user) {
          setUserId(user.id);
          setUserName(user.first_name || user.name || null);
        }
      }
    } catch (error) {
      console.error('Error checking login status:', error);
      // Show login modal on error (same as dev window)
      setShowLogin(true);
      setUserId(null);
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

    // Get user ID after successful login
    try {
      const user = await window.electronAPI.invoke('get-current-user');
      if (user) {
        setUserId(user.id);
        setUserName(user.first_name || user.name || null);
      }
    } catch (error) {
      console.error('Error getting current user:', error);
    }
  };

  const handleLogout = async () => {
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
    try {
      const newProject = await createProject({
        name: data.name,
        description: data.description,
      });
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
          <div className="userAvatar" onClick={handleLogout} title="Logout">
            <span className="avatarInitial">
              {userName ? userName.charAt(0).toUpperCase() : (userId ? userId.toString()[0] : 'U')}
            </span>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="projectsMain">
        {currentView === 'list' ? (
          <ProjectsList
            projects={projects}
            loading={loading}
            onCreateProject={handleCreateProject}
            onSelectProject={handleSelectProject}
            onDeleteProject={handleDeleteProject}
          />
        ) : currentView === 'detail' && selectedProject ? (
          <ProjectDetail project={selectedProject} onBack={handleBackToList} />
        ) : null}
      </div>

      {/* Create Project Wizard Modal */}
      {showCreateWizard && (
        <CreateProjectWizard
          onClose={() => setShowCreateWizard(false)}
          onComplete={handleWizardComplete}
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
