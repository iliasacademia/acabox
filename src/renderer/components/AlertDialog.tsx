import React from 'react';

interface AlertDialogProps {
  title: string;
  message: string;
  buttonLabel?: string;
  onClose: () => void;
}

const AlertDialog: React.FC<AlertDialogProps> = ({
  title,
  message,
  buttonLabel = 'OK',
  onClose,
}) => {
  return (
    <div className="wizardOverlay" onClick={onClose}>
      <div
        className="wizardModal"
        style={{ maxWidth: '500px' }}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="wizardClose" onClick={onClose}>
          ×
        </button>

        <div className="wizardContent">
          <h2 className="wizardTitle">{title}</h2>
          <p style={{ fontSize: '16px', lineHeight: '1.5', color: '#666' }}>
            {message}
          </p>

          <div className="wizardActions">
            <button className="wizardButtonPrimary" onClick={onClose}>
              {buttonLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AlertDialog;
