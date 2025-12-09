import React from 'react';
import './PermissionsBanner.css';

interface PermissionsBannerProps {
  onGrantPermission: () => void;
  onResetPermission: () => void;
  onRestartApp: () => void;
  isWorking: boolean;
  isDevelopment: boolean;
  hasUpdateBanner?: boolean;
}

export const PermissionsBanner: React.FC<PermissionsBannerProps> = ({
  onGrantPermission,
  onResetPermission,
  onRestartApp,
  isWorking,
  isDevelopment,
  hasUpdateBanner = false,
}) => {
  const className = hasUpdateBanner
    ? 'permissionsBanner permissionsBanner--withUpdateBanner'
    : 'permissionsBanner';

  return (
    <div className={className}>
      <span className="permissionsBanner__message">
        Accessibility permission required for Word integration.
      </span>
      <button
        className="permissionsBanner__button permissionsBanner__button--primary"
        onClick={onGrantPermission}
        disabled={isWorking}
      >
        Grant Permission
      </button>
      {isDevelopment && (
        <button
          className="permissionsBanner__button permissionsBanner__button--secondary"
          onClick={onResetPermission}
          disabled={isWorking}
        >
          {isWorking ? 'Resetting...' : 'Reset Permission'}
        </button>
      )}
      <button
        className="permissionsBanner__button permissionsBanner__button--secondary"
        onClick={onRestartApp}
      >
        Restart App
      </button>
    </div>
  );
};
