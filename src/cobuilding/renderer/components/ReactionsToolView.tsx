import React from 'react';

interface Props {
  onBack: () => void;
}

export const ReactionsToolView: React.FC<Props> = ({ onBack }) => {
  return (
    <div style={{ padding: 24 }}>
      <button onClick={onBack}>← Back</button>
      <h2>Reactions</h2>
      <p>
        Reactions react to your file-activity timeline and surface suggestions in the Briefings panel.
        Enable in Settings → Reactions.
      </p>
    </div>
  );
};
