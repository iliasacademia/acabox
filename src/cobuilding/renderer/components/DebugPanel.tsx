import React from 'react';
import { PodmanDebug } from './PodmanDebug';
import { AppsDebug } from './AppsDebug';
import { KernelsDebug } from './KernelsDebug';
import './DebugPanel.css';

export type DebugSection = 'podman' | 'apps' | 'observations' | 'kernels';

const DEBUG_SECTIONS: { id: DebugSection; label: string }[] = [
  { id: 'apps', label: 'Logs' },
  { id: 'podman', label: 'Podman' },
  { id: 'kernels', label: 'Kernels' },
];

export const DebugSidebar: React.FC<{
  activeSection: DebugSection;
  onSelect: (section: DebugSection) => void;
}> = ({ activeSection, onSelect }) => {
  return (
    <>
      <div className="debugSidebar__header">Debug</div>
      {DEBUG_SECTIONS.map((section) => (
        <button
          key={section.id}
          className={`debugSidebar__item ${activeSection === section.id ? 'debugSidebar__item--active' : ''}`}
          onClick={() => onSelect(section.id)}
        >
          {section.label}
        </button>
      ))}
    </>
  );
};

export const DebugContent: React.FC<{ activeSection: DebugSection }> = ({ activeSection }) => {
  return (
    <div className="debugContent">
      {activeSection === 'podman' && <PodmanDebug />}
      {activeSection === 'apps' && <AppsDebug />}
      {activeSection === 'kernels' && <KernelsDebug />}
    </div>
  );
};
