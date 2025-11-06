import React from 'react';

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}) => {
  return (
    <div className="wizardOverlay" onClick={onCancel}>
      <div
        className="wizardModal"
        style={{ maxWidth: '500px' }}
        onClick={(e) => e.stopPropagation()}
      >
        <button className="wizardClose" onClick={onCancel}>
          ×
        </button>

        <div className="wizardContent">
          <h2 className="wizardTitle">{title}</h2>
          <p style={{ fontSize: '16px', lineHeight: '1.5', color: '#666' }}>
            {message}
          </p>

          <div className="wizardActions">
            <button className="wizardButtonSecondary" onClick={onCancel}>
              {cancelLabel}
            </button>
            <button className="wizardButtonPrimary" onClick={onConfirm}>
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDialog;
