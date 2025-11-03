import React from 'react';
import { Review } from '../services/mockProjectsApi';

interface ReviewComponentProps {
  review: Review;
  onAccept: () => void;
  onReject: () => void;
}

const ReviewComponent: React.FC<ReviewComponentProps> = ({
  review,
  onAccept,
  onReject,
}) => {
  const getTypeLabel = (type: Review['type']): string => {
    const labels: Record<Review['type'], string> = {
      grammar: 'Grammar',
      clarity: 'Clarity',
      reference: 'Reference',
      methodology: 'Methodology',
      other: 'Suggestion',
    };
    return labels[type];
  };

  const getTypeColor = (type: Review['type']): string => {
    const colors: Record<Review['type'], string> = {
      grammar: '#dc3545',
      clarity: '#ffc107',
      reference: '#17a2b8',
      methodology: '#28a745',
      other: '#6c757d',
    };
    return colors[type];
  };

  return (
    <div className="reviewComponent">
      <div className="reviewHeader">
        <span
          className="reviewType"
          style={{ backgroundColor: getTypeColor(review.type) }}
        >
          {getTypeLabel(review.type)}
        </span>
        {review.status !== 'pending' && (
          <span
            className={`reviewStatus ${
              review.status === 'accepted' ? 'accepted' : 'rejected'
            }`}
          >
            {review.status === 'accepted' ? '✓ Accepted' : '✗ Rejected'}
          </span>
        )}
      </div>

      <div className="reviewContext">
        <div className="reviewContextLabel">Original text:</div>
        <div className="reviewContextText">"{review.context}"</div>
      </div>

      <div className="reviewSuggestion">
        <div className="reviewSuggestionLabel">Suggestion:</div>
        <div className="reviewSuggestionText">{review.suggestion}</div>
      </div>

      {review.status === 'pending' && (
        <div className="reviewActions">
          <button className="reviewActionReject" onClick={onReject}>
            Reject
          </button>
          <button className="reviewActionAccept" onClick={onAccept}>
            Accept
          </button>
        </div>
      )}
    </div>
  );
};

export default ReviewComponent;
