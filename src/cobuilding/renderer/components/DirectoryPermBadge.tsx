import React from 'react';
import { LockIcon, LockOpenIcon, Loader2Icon } from 'lucide-react';

interface DirectoryPermBadgeProps {
  readOnly: boolean;
  isToggling: boolean;
  disabled?: boolean;
  onToggle: (e: React.MouseEvent) => void;
}

const DirectoryPermBadge: React.FC<DirectoryPermBadgeProps> = ({ readOnly, isToggling, disabled, onToggle }) => (
  <button
    type="button"
    className={`fileTreeDirPermBtn${readOnly ? ' fileTreeDirPermBtn--locked' : ''}`}
    disabled={disabled ?? isToggling}
    onClick={(e) => { e.stopPropagation(); onToggle(e); }}
  >
    {isToggling
      ? <Loader2Icon style={{ width: 12, height: 12 }} className="fileTreeSpinner" />
      : readOnly
        ? <LockIcon style={{ width: 12, height: 12 }} />
        : <LockOpenIcon style={{ width: 12, height: 12 }} />}
    <span className="fileTreeDirPermBtn__label">
      {isToggling ? 'Applying…' : readOnly ? 'Read only' : 'Editable'}
    </span>
  </button>
);

export default DirectoryPermBadge;
