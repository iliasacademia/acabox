import React from 'react';
import './DevelopmentBanner.css';

const DevelopmentBanner: React.FC = () => {
  return (
    <div className="development-banner">
      <span className="development-banner-text">
        Development Mode (port {window.location.port})
      </span>
    </div>
  );
};

export default DevelopmentBanner;
