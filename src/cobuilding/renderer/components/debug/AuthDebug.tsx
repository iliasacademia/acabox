import React from 'react';
import ApiKeySettings from '../ApiKeySettings';

export const AuthDebug: React.FC = () => {
  return (
    <div className="debugSection">
      <h3 className="debugSection__title">API Key</h3>
      <ApiKeySettings />
    </div>
  );
};
