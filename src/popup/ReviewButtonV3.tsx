import React from 'react';
import { createRoot } from 'react-dom/client';
import './ReviewButtonV3.css';

const urlParams = new URLSearchParams(window.location.search);
const serverUrl = window.location.origin;
const pidParam = urlParams.get('pid');
const widParam = urlParams.get('wid');
const tokenParam = urlParams.get('token');
const isV4Mode = urlParams.get('mode') === 'v4';

function postBridge(action: string, payload: Record<string, unknown> = {}, widOverride?: string | null) {
  const effectiveWid = widOverride ?? widParam;
  return fetch(`${serverUrl}/bridge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenParam}`,
    },
    body: JSON.stringify({ action, payload, pid: Number(pidParam), wid: effectiveWid }),
  });
}

const ReviewButtonV3: React.FC = () => {
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    postBridge('openReviewPanelV3').catch((err) => {
      console.error('[ReviewButtonV3] Failed to open panel:', err);
    });
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
