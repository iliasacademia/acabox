import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './ReviewButton.css';

// Get serverUrl from window.location.origin
const serverUrl = window.location.origin;

// Parse URL params
const urlParams = new URLSearchParams(window.location.search);
const pidParam = urlParams.get('pid');
const widParam = urlParams.get('wid');
const tokenParam = urlParams.get('token');

interface WordPollResponse {
  shouldShow: boolean;
}

function postBridge(action: string, payload: Record<string, unknown>) {
  fetch(`${serverUrl}/bridge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenParam}`,
    },
    body: JSON.stringify({ action, payload, pid: Number(pidParam), wid: widParam }),
  }).catch((err) => {
    console.error('[ReviewButton] Bridge post failed:', err);
  });
}

const ReviewButton: React.FC = () => {
  const [shouldShow, setShouldShow] = useState(false);

  useEffect(() => {
    if (!widParam || !tokenParam) {
      setShouldShow(false);
      return;
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${tokenParam}`,
    };

    fetch(`${serverUrl}/word/v2/${widParam}/poll`, { headers })
      .then((res) => {
        if (!res.ok) {
          setShouldShow(false);
          return;
        }
        return res.json();
      })
      .then((data: WordPollResponse | undefined) => {
        if (data) {
          setShouldShow(data.shouldShow);
        }
      })
      .catch(() => {
        setShouldShow(false);
      });
  }, []);

  const handleClick = () => {
    postBridge('reviewButtonClicked', {});
  };

  if (!shouldShow) {
    return null;
  }

  return (
    <div className="review-button-container">
      <button className="review-button" onClick={handleClick}>
        Review
      </button>
    </div>
  );
};

// Mount the component
const rootElement = document.getElementById('root');
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(<ReviewButton />);
} else {
  console.error('[ReviewButton] Root element not found');
}

export default ReviewButton;
