import React from 'react';
import './UpdateBanner.css';

interface UpdateBannerProps {
  status: 'available' | 'downloading' | 'downloaded' | 'error';
  version?: string;
  progress?: number;
  errorMessage?: string;
  onDownloadClick: () => void;
  onRetryClick: () => void;
}

export const UpdateBanner: React.FC<UpdateBannerProps> = ({
  status,
  version,
  progress,
  errorMessage,
  onDownloadClick,
  onRetryClick,
}) => {
  const getMessage = () => {
    switch (status) {
      case 'available':
        return `Downloading update${version ? ` (${version})` : ''}...`;
      case 'downloading':
        return `Downloading${progress !== undefined ? `... ${Math.round(progress)}%` : '...'}`;
      case 'downloaded':
        return 'Download complete. Restarting...';
      case 'error':
        return `Update failed${errorMessage ? `: ${errorMessage}` : ''}`;
    }
  };

  return (
    <div className={`updateBanner updateBanner--${status}`}>
      <span className="updateBanner__message">{getMessage()}</span>
      {status === 'error' && (
        <button className="updateBanner__button" onClick={onRetryClick}>
          Retry
        </button>
      )}
    </div>
  );
};
