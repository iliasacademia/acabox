import React, { useState, useEffect } from 'react';
import {
  Project,
  ProjectFile,
  ProjectFolder,
  Collaborator,
  Review,
  getProjectFiles,
  getProjectFolders,
  getProjectCollaborators,
  getProjectReviews,
  updateReviewStatus,
} from '../services/mockProjectsApi';
import ProjectSidebar from './ProjectSidebar';
import ReviewComponent from './ReviewComponent';

interface ProjectDetailProps {
  project: Project;
  onBack: () => void;
}

const ProjectDetail: React.FC<ProjectDetailProps> = ({ project, onBack }) => {
  const [manuscript, setManuscript] = useState<ProjectFile | null>(null);
  const [folders, setFolders] = useState<ProjectFolder[]>([]);
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadProjectData();
  }, [project.id]);

  const loadProjectData = async () => {
    setLoading(true);
    try {
      const [filesData, foldersData, collaboratorsData, reviewsData] =
        await Promise.all([
          getProjectFiles(project.id),
          getProjectFolders(project.id),
          getProjectCollaborators(project.id),
          getProjectReviews(project.id),
        ]);

      // Find primary manuscript
      const primaryManuscript =
        filesData.find((f) => f.is_primary_manuscript) || filesData[0] || null;

      setManuscript(primaryManuscript);
      setFolders(foldersData);
      setCollaborators(collaboratorsData);
      setReviews(reviewsData);
    } catch (error) {
      console.error('Error loading project data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAddFolder = () => {
    // TODO: Implement folder selection
    alert('Add folder functionality - to be implemented');
  };

  const handleAddCollaborator = () => {
    // TODO: Implement collaborator invitation
    alert('Add collaborator functionality - to be implemented');
  };

  const handleAcceptReview = async (review: Review) => {
    try {
      await updateReviewStatus(project.id, review.id, 'accepted');
      setReviews(
        reviews.map((r) =>
          r.id === review.id ? { ...r, status: 'accepted' } : r
        )
      );
    } catch (error) {
      console.error('Error accepting review:', error);
    }
  };

  const handleRejectReview = async (review: Review) => {
    try {
      await updateReviewStatus(project.id, review.id, 'rejected');
      setReviews(
        reviews.map((r) =>
          r.id === review.id ? { ...r, status: 'rejected' } : r
        )
      );
    } catch (error) {
      console.error('Error rejecting review:', error);
    }
  };

  if (loading) {
    return (
      <div className="projectDetail">
        <div className="projectDetailLoading">
          <div className="loadingSpinner"></div>
          <p>Loading project...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="projectDetail">
      {/* Header */}
      <div className="projectDetailHeader">
        <button className="projectDetailBack" onClick={onBack}>
          ← Back
        </button>
        <h2 className="projectDetailTitle">{project.name}</h2>
      </div>

      {/* Main Content Area */}
      <div className="projectDetailContent">
        {/* Sidebar */}
        <ProjectSidebar
          manuscript={manuscript}
          folders={folders}
          collaborators={collaborators}
          onAddFolder={handleAddFolder}
          onAddCollaborator={handleAddCollaborator}
        />

        {/* Main Panel with Reviews */}
        <div className="projectDetailMain">
          <div className="projectDetailMainHeader">
            <h3 className="projectDetailMainTitle">
              {manuscript
                ? `Reviews for "${manuscript.file_name}"`
                : 'Reviews'}
            </h3>
          </div>

          <div className="projectDetailReviews">
            {reviews.length === 0 ? (
              <div className="projectDetailEmpty">
                <div className="loadingSpinner"></div>
                <p>Analyzing manuscript... This may take a few minutes.</p>
              </div>
            ) : (
              <>
                <div className="reviewsStatusBar">
                  <span className="reviewsCount">
                    {reviews.filter((r) => r.status === 'pending').length}{' '}
                    pending reviews
                  </span>
                </div>
                {reviews.map((review) => (
                  <ReviewComponent
                    key={review.id}
                    review={review}
                    onAccept={() => handleAcceptReview(review)}
                    onReject={() => handleRejectReview(review)}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ProjectDetail;
