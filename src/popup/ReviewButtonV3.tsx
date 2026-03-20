import React from 'react';
import { createRoot } from 'react-dom/client';
import './ReviewButtonV3.css';

const ReviewButtonV3: React.FC = () => {
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('ReviewButtonV3 clicked');
  };

  return (
    <div className="review-button-container">
      <button
        className="review-button"
        onMouseDown={handleClick}
      >
        Review
      </button>
    </div>
  );
};

const rootElement = document.getElementById('root');
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(<ReviewButtonV3 />);
} else {
  console.error('[ReviewButtonV3] Root element not found');
}

export default ReviewButtonV3;
