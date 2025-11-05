import React, { useState } from 'react';

interface InputDialogProps {
  title: string;
  message: string;
  placeholder?: string;
  defaultValue?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

const InputDialog: React.FC<InputDialogProps> = ({
  title,
  message,
  placeholder = '',
  defaultValue = '',
  onConfirm,
  onCancel,
}) => {
  const [value, setValue] = useState(defaultValue);

  const handleConfirm = () => {
    onConfirm(value);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleConfirm();
    } else if (e.key === 'Escape') {
      onCancel();
    }
  };

  return (
    <div className="dialogOverlay" onClick={onCancel}>
      <div className="dialogModal" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialogTitle">{title}</h3>
        <p className="dialogMessage">{message}</p>
        <input
          type="text"
          className="dialogInput"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyPress}
          placeholder={placeholder}
          autoFocus
        />
        <div className="dialogActions">
          <button className="dialogButton dialogButtonSecondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="dialogButton dialogButtonPrimary" onClick={handleConfirm}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
};

export default InputDialog;
