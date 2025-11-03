/**
 * Mock Projects API Layer
 *
 * This file serves as:
 * 1. Backend API specification (interfaces + endpoints)
 * 2. Mock implementation with dummy data for frontend development
 *
 * When backend is ready, replace these mock functions with real API calls
 * following the same interface signatures.
 */

// ============================================================================
// TYPE DEFINITIONS (Backend Data Models)
// ============================================================================

export interface Project {
  id: number;
  name: string;
  description: string;
  user_id: number;
  created_at: string;
  updated_at: string;
  file_count: number;
  folder_count: number;
  collaborator_count: number;
  primary_manuscript_id?: number;
}

export interface ProjectFile {
  id: number;
  project_id: number;
  file_name: string;
  file_type: 'manuscript' | 'data' | 'image' | 'other';
  file_path: string;
  size: number;
  created_at: string;
  updated_at: string;
  is_primary_manuscript: boolean;
}

export interface ProjectFolder {
  id: number;
  project_id: number;
  folder_name: string;
  folder_path: string;
  file_count: number;
  created_at: string;
  synced: boolean;
}

export interface Collaborator {
  id: number;
  project_id: number;
  email: string;
  name?: string;
  role: 'owner' | 'editor' | 'viewer';
  invited_at: string;
  joined_at?: string;
  status: 'pending' | 'active' | 'declined';
}

export interface Review {
  id: number;
  project_id: number;
  manuscript_id: number;
  context: string;
  suggestion: string;
  type: 'grammar' | 'clarity' | 'reference' | 'methodology' | 'other';
  location: {
    start: number;
    end: number;
  };
  created_at: string;
  status: 'pending' | 'accepted' | 'rejected';
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
  folder_ids?: number[];
  primary_manuscript_id?: number;
  collaborator_emails?: string[];
}

// ============================================================================
// DUMMY DATA
// ============================================================================

const DUMMY_PROJECTS: Project[] = [
  {
    id: 1,
    name: 'Machine Learning in Genomics',
    description: 'Applying deep learning techniques to genomic sequence analysis',
    user_id: 1,
    created_at: '2024-01-15T10:30:00Z',
    updated_at: '2024-01-20T14:45:00Z',
    file_count: 12,
    folder_count: 2,
    collaborator_count: 1,
    primary_manuscript_id: 1,
  },
  {
    id: 2,
    name: 'Protein Structure Prediction',
    description: 'Novel approaches to predicting protein folding patterns',
    user_id: 1,
    created_at: '2024-02-01T09:15:00Z',
    updated_at: '2024-02-10T16:20:00Z',
    file_count: 24,
    folder_count: 3,
    collaborator_count: 2,
    primary_manuscript_id: 4,
  },
  {
    id: 3,
    name: 'CRISPR Gene Editing Study',
    description: 'Investigating off-target effects in CRISPR-Cas9 systems',
    user_id: 1,
    created_at: '2024-03-05T11:00:00Z',
    updated_at: '2024-03-15T13:30:00Z',
    file_count: 8,
    folder_count: 1,
    collaborator_count: 0,
  },
];

const DUMMY_FILES: ProjectFile[] = [
  {
    id: 1,
    project_id: 1,
    file_name: 'draft_manuscript_v0.3',
    file_type: 'manuscript',
    file_path: '/projects/1/draft_manuscript_v0.3.docx',
    size: 2048576,
    created_at: '2024-01-15T10:35:00Z',
    updated_at: '2024-01-20T14:45:00Z',
    is_primary_manuscript: true,
  },
  {
    id: 2,
    project_id: 1,
    file_name: 'genes_expression',
    file_type: 'data',
    file_path: '/projects/1/genes_expression.csv',
    size: 5242880,
    created_at: '2024-01-16T09:20:00Z',
    updated_at: '2024-01-16T09:20:00Z',
    is_primary_manuscript: false,
  },
  {
    id: 3,
    project_id: 1,
    file_name: 'micro_analysis',
    file_type: 'data',
    file_path: '/projects/1/micro_analysis.xlsx',
    size: 3145728,
    created_at: '2024-01-17T15:10:00Z',
    updated_at: '2024-01-17T15:10:00Z',
    is_primary_manuscript: false,
  },
];

const DUMMY_FOLDERS: ProjectFolder[] = [
  {
    id: 1,
    project_id: 1,
    folder_name: 'Protocols',
    folder_path: '/Users/researcher/Projects/ML-Genomics/Protocols',
    file_count: 16,
    created_at: '2024-01-15T10:30:00Z',
    synced: true,
  },
  {
    id: 2,
    project_id: 1,
    folder_name: 'Sequencing-Results-2024',
    folder_path: '/Users/researcher/Projects/ML-Genomics/Sequencing-Results-2024',
    file_count: 8,
    created_at: '2024-01-15T10:30:00Z',
    synced: true,
  },
];

const DUMMY_COLLABORATORS: Collaborator[] = [
  {
    id: 1,
    project_id: 1,
    email: 'lynn.james@harvard.edu',
    name: 'Dr. Lynn James',
    role: 'editor',
    invited_at: '2024-01-16T10:00:00Z',
    joined_at: '2024-01-16T14:30:00Z',
    status: 'active',
  },
];

const DUMMY_REVIEWS: Review[] = [
  {
    id: 1,
    project_id: 1,
    manuscript_id: 1,
    context: 'The results indicate a significant correlation...',
    suggestion: 'Consider adding statistical significance values (p-values) to support this claim.',
    type: 'methodology',
    location: { start: 1250, end: 1320 },
    created_at: '2024-01-20T14:00:00Z',
    status: 'pending',
  },
  {
    id: 2,
    project_id: 1,
    manuscript_id: 1,
    context: 'We utilized machine learning algorithms for analysis',
    suggestion: 'Specify which ML algorithms were used (e.g., Random Forest, Neural Networks, etc.)',
    type: 'clarity',
    location: { start: 850, end: 905 },
    created_at: '2024-01-20T14:05:00Z',
    status: 'pending',
  },
  {
    id: 3,
    project_id: 1,
    manuscript_id: 1,
    context: 'Previous studies have shown similar patterns',
    suggestion: 'Add citations to support this statement. Consider referencing Smith et al. (2023) or Johnson (2022).',
    type: 'reference',
    location: { start: 450, end: 495 },
    created_at: '2024-01-20T14:10:00Z',
    status: 'pending',
  },
];

// ============================================================================
// MOCK API FUNCTIONS
// (Backend should implement these endpoints)
// ============================================================================

/**
 * Get all projects for current user
 * Backend: GET /v0/projects
 */
export async function getProjects(): Promise<Project[]> {
  // Simulate API delay
  await new Promise(resolve => setTimeout(resolve, 500));
  return [...DUMMY_PROJECTS];
}

/**
 * Get single project by ID
 * Backend: GET /v0/projects/:id
 */
export async function getProject(id: number): Promise<Project | null> {
  await new Promise(resolve => setTimeout(resolve, 300));
  return DUMMY_PROJECTS.find(p => p.id === id) || null;
}

/**
 * Create new project
 * Backend: POST /v0/projects
 */
export async function createProject(data: CreateProjectRequest): Promise<Project> {
  await new Promise(resolve => setTimeout(resolve, 800));

  const newProject: Project = {
    id: Math.max(...DUMMY_PROJECTS.map(p => p.id), 0) + 1,
    name: data.name,
    description: data.description || '',
    user_id: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    file_count: 0,
    folder_count: data.folder_ids?.length || 0,
    collaborator_count: data.collaborator_emails?.length || 0,
    primary_manuscript_id: data.primary_manuscript_id,
  };

  DUMMY_PROJECTS.push(newProject);
  return newProject;
}

/**
 * Update project
 * Backend: PUT /v0/projects/:id
 */
export async function updateProject(id: number, data: Partial<CreateProjectRequest>): Promise<Project | null> {
  await new Promise(resolve => setTimeout(resolve, 500));

  const project = DUMMY_PROJECTS.find(p => p.id === id);
  if (!project) return null;

  if (data.name) project.name = data.name;
  if (data.description !== undefined) project.description = data.description;
  project.updated_at = new Date().toISOString();

  return project;
}

/**
 * Delete project
 * Backend: DELETE /v0/projects/:id
 */
export async function deleteProject(id: number): Promise<boolean> {
  await new Promise(resolve => setTimeout(resolve, 400));

  const index = DUMMY_PROJECTS.findIndex(p => p.id === id);
  if (index === -1) return false;

  DUMMY_PROJECTS.splice(index, 1);
  return true;
}

/**
 * Get files in project
 * Backend: GET /v0/projects/:id/files
 */
export async function getProjectFiles(projectId: number): Promise<ProjectFile[]> {
  await new Promise(resolve => setTimeout(resolve, 300));
  return DUMMY_FILES.filter(f => f.project_id === projectId);
}

/**
 * Get folders in project
 * Backend: GET /v0/projects/:id/folders
 */
export async function getProjectFolders(projectId: number): Promise<ProjectFolder[]> {
  await new Promise(resolve => setTimeout(resolve, 300));
  return DUMMY_FOLDERS.filter(f => f.project_id === projectId);
}

/**
 * Add folder to project
 * Backend: POST /v0/projects/:id/folders
 */
export async function addFolderToProject(projectId: number, folderPath: string): Promise<ProjectFolder> {
  await new Promise(resolve => setTimeout(resolve, 500));

  const folderName = folderPath.split('/').pop() || 'Unnamed Folder';
  const newFolder: ProjectFolder = {
    id: Math.max(...DUMMY_FOLDERS.map(f => f.id), 0) + 1,
    project_id: projectId,
    folder_name: folderName,
    folder_path: folderPath,
    file_count: 0,
    created_at: new Date().toISOString(),
    synced: false,
  };

  DUMMY_FOLDERS.push(newFolder);
  return newFolder;
}

/**
 * Get collaborators in project
 * Backend: GET /v0/projects/:id/collaborators
 */
export async function getProjectCollaborators(projectId: number): Promise<Collaborator[]> {
  await new Promise(resolve => setTimeout(resolve, 300));
  return DUMMY_COLLABORATORS.filter(c => c.project_id === projectId);
}

/**
 * Add collaborator to project
 * Backend: POST /v0/projects/:id/collaborators
 */
export async function addCollaborator(projectId: number, email: string): Promise<Collaborator> {
  await new Promise(resolve => setTimeout(resolve, 500));

  const newCollaborator: Collaborator = {
    id: Math.max(...DUMMY_COLLABORATORS.map(c => c.id), 0) + 1,
    project_id: projectId,
    email: email,
    role: 'editor',
    invited_at: new Date().toISOString(),
    status: 'pending',
  };

  DUMMY_COLLABORATORS.push(newCollaborator);
  return newCollaborator;
}

/**
 * Get reviews/suggestions for project
 * Backend: GET /v0/projects/:id/reviews
 */
export async function getProjectReviews(projectId: number): Promise<Review[]> {
  await new Promise(resolve => setTimeout(resolve, 600));
  return DUMMY_REVIEWS.filter(r => r.project_id === projectId);
}

/**
 * Update review status
 * Backend: PUT /v0/projects/:projectId/reviews/:reviewId
 */
export async function updateReviewStatus(
  projectId: number,
  reviewId: number,
  status: 'accepted' | 'rejected'
): Promise<Review | null> {
  await new Promise(resolve => setTimeout(resolve, 300));

  const review = DUMMY_REVIEWS.find(r => r.id === reviewId && r.project_id === projectId);
  if (!review) return null;

  review.status = status;
  return review;
}
