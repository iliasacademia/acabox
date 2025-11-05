import React, { useState } from 'react';

interface AddCollaboratorModalProps {
  onClose: () => void;
  onAdd: (emails: string[]) => void;
}

const AddCollaboratorModal: React.FC<AddCollaboratorModalProps> = ({
  onClose,
  onAdd,
}) => {
  const [email, setEmail] = useState('');
  const [collaborators, setCollaborators] = useState<string[]>([]);
  const [error, setError] = useState('');

  const validateEmail = (email: string): boolean => {
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    return emailRegex.test(email.trim()) && email.trim().length <= 254;
  };

  const handleAddCollaborator = () => {
    setError('');

    if (!email.trim()) {
      setError('Please enter an email address');
      return;
    }

    if (!validateEmail(email)) {
      setError('Please enter a valid email address');
      return;
    }

    if (collaborators.includes(email.trim())) {
      setError('This collaborator has already been added');
      return;
    }

    setCollaborators([...collaborators, email.trim()]);
    setEmail('');
  };

  const handleRemoveCollaborator = (emailToRemove: string) => {
    setCollaborators(collaborators.filter((e) => e !== emailToRemove));
  };

  const handleConfirm = () => {
    // Include any email currently in the input field
    const finalEmails = [...collaborators];
    if (email.trim() && validateEmail(email) && !finalEmails.includes(email.trim())) {
      finalEmails.push(email.trim());
    }

    onAdd(finalEmails);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleAddCollaborator();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div className="wizardOverlay" onClick={onClose}>
      <div
        className="wizardModal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '728px', width: '728px' }}
      >
        <button className="wizardClose" onClick={onClose}>
          ×
        </button>

        <div className="wizardContent">
          <h2 className="wizardTitle">Invite collaborators</h2>

          <div className="wizardForm">
            <div className="wizardSection">
              <p className="wizardSectionTitle">
                Add collaborators to your project (optional)
              </p>

              {/* Email Input */}
              <div className="formGroup">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder="Email"
                  autoFocus
                />
              </div>

              {/* Error Message */}
              {error && <div className="wizardError">{error}</div>}

              {/* Add Another Collaborator Button */}
              <button
                className="wizardAddButton"
                onClick={handleAddCollaborator}
                style={{ marginTop: '16px' }}
              >
                + Add collaborator
              </button>

              {/* List of Added Collaborators */}
              {collaborators.length > 0 && (
                <div className="collaboratorsList" style={{ marginTop: '24px' }}>
                  {collaborators.map((colabEmail, index) => (
                    <div key={index} className="collaboratorItem">
                      <div className="collaboratorAvatar">
                        {colabEmail.charAt(0).toUpperCase()}
                      </div>
                      <span className="collaboratorEmail">{colabEmail}</span>
                      <button
                        className="collaboratorRemove"
                        onClick={() => handleRemoveCollaborator(colabEmail)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Action Buttons */}
          <div className="wizardActions" style={{ marginTop: '40px' }}>
            <button className="wizardButtonSecondary" onClick={onClose}>
              Cancel
            </button>
            <button
              className="wizardButtonPrimary"
              onClick={handleConfirm}
            >
              Add {collaborators.length > 0 ? `${collaborators.length} ` : ''}
              Collaborator{collaborators.length !== 1 ? 's' : ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AddCollaboratorModal;
