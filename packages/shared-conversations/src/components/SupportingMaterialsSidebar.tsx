import { SupportingMaterial } from '../types/supportingMaterials';

export interface SupportingMaterialsSidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onGetStarted: () => void;
  materials: SupportingMaterial[];
  onBackToFeedback: () => void;
}

export function SupportingMaterialsSidebar({
  collapsed,
  onToggleCollapsed,
  onGetStarted,
  materials,
  onBackToFeedback,
}: SupportingMaterialsSidebarProps) {
  const hasMaterials = materials.length > 0;

  const formatDate = (timestamp: string): string => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffDays < 1) {
      return 'Today';
    } else if (diffDays < 7) {
      return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    } else {
      return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      });
    }
  };

  // Show up to 3 most recent materials
  const recentMaterials = materials
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    .slice(0, 3);

  return (
    <div className={`supportingMaterialsSidebar ${collapsed ? 'collapsed' : ''}`}>
      {/* Header */}
      <div className="supportingMaterialsHeader">
        <h2 className="supportingMaterialsTitle">Supporting materials</h2>
        <button
          onClick={onToggleCollapsed}
          className="panelCollapseButton"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <mask
              id="mask0_2500_461"
              style={{ maskType: 'alpha' }}
              maskUnits="userSpaceOnUse"
              x="0"
              y="0"
              width="24"
              height="24"
            >
              <rect width="24" height="24" fill="#D9D9D9" />
            </mask>
            <g mask="url(#mask0_2500_461)">
              <path
                d="M12.5 8V16L16.5 12L12.5 8ZM5 21C4.45 21 3.97917 20.8042 3.5875 20.4125C3.19583 20.0208 3 19.55 3 19V5C3 4.45 3.19583 3.97917 3.5875 3.5875C3.97917 3.19583 4.45 3 5 3H19C19.55 3 20.0208 3.19583 20.4125 3.5875C20.8042 3.97917 21 4.45 21 5V19C21 19.55 20.8042 20.0208 20.4125 20.4125C20.0208 20.8042 19.55 21 19 21H5ZM8 19V5H5V19H8ZM10 19H19V5H10V19Z"
                fill="currentColor"
              />
            </g>
          </svg>
        </button>
      </div>

      {/* Empty State or Materials Preview */}
      {!hasMaterials ? (
        <div className="supportingMaterialsEmptyState">
          <p className="supportingMaterialsEmptyText">
            Improve reviews by adding supporting materials, such as references or notes.
          </p>
          <button className="supportingMaterialsGetStarted" onClick={onGetStarted}>
            Get started
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              style={{ marginLeft: '4px' }}
            >
              <path
                d="M6 12L10 8L6 4"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      ) : (
        <div className="supportingMaterialsPreview">
          <p className="supportingMaterialsCount">
            {materials.length} {materials.length === 1 ? 'file' : 'files'}
          </p>
          <ul className="supportingMaterialsPreviewList">
            {recentMaterials.map((material) => (
              <li key={material.id} className="supportingMaterialsPreviewItem">
                <p className="supportingMaterialsPreviewFileName">
                  {material.file_name}
                </p>
                <p className="supportingMaterialsPreviewDate">
                  {formatDate(material.updated_at)}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Manuscript Feedback Section */}
      <div className="supportingMaterialsSidebarSection">
        <h3 className="supportingMaterialsSidebarSectionTitle">
          Manuscript feedback
        </h3>
        <button
          className="supportingMaterialsSidebarLink"
          onClick={onBackToFeedback}
        >
          View conversations →
        </button>
      </div>
    </div>
  );
}
