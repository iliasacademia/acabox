import React from 'react';

interface SupportingMaterialsBottomBarProps {
  uploadingCount: number;
  totalFiles: number;
  isUploading: boolean;
  onStartReview: () => void;
}

export function SupportingMaterialsBottomBar({
  uploadingCount,
  totalFiles,
  isUploading,
  onStartReview,
}: SupportingMaterialsBottomBarProps) {
  // Don't show if no files are being uploaded or have been uploaded
  if (totalFiles === 0) {
    return null;
  }

  // Calculate completion percentage
  const completionPercentage = totalFiles > 0 ? (uploadingCount / totalFiles) * 100 : 0;

  return (
    <div className="supportingMaterialsBottomBar">
      <div className="bottomBarContent">
        {isUploading ? (
          <>
            <div className="bottomBarStatus">
              <div className="bottomBarSpinner" />
              <span className="bottomBarText">
                Processing {uploadingCount}/{totalFiles} files...
              </span>
            </div>
            <div className="bottomBarProgress">
              <div
                className="bottomBarProgressFill"
                style={{
                  width: `${completionPercentage}%`,
                }}
              />
            </div>
          </>
        ) : (
          <>
            <div className="bottomBarCompleted">
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <circle cx="10" cy="10" r="10" fill="#22C55E" />
                <path
                  d="M6 10L8.5 12.5L14 7"
                  stroke="white"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="bottomBarText">
                {totalFiles} {totalFiles === 1 ? 'file' : 'files'} uploaded
              </span>
            </div>
            <button className="bottomBarReviewButton" onClick={onStartReview}>
              Start Review
            </button>
          </>
        )}
      </div>
    </div>
  );
}
