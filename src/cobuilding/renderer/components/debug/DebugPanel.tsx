import React from 'react';
import { AppsDebug } from './AppsDebug';
import { KernelsDebug } from './KernelsDebug';
import { ObservationsDebug } from './ObservationsDebug';
import { FileMonitorDebug } from './FileMonitorDebug';
import { StorageDebug } from './StorageDebug';
import { AuthDebug } from './AuthDebug';
import { ExportDebug } from './ExportDebug';
import { HardResetDebug } from './HardResetDebug';
import { ScannedFilesDebug } from './ScannedFilesDebug';
import { TelemetryDebug } from './TelemetryDebug';
import './DebugPanel.css';

export type DebugSection = 'apps' | 'observations' | 'kernels' | 'file-monitor' | 'storage' | 'auth' | 'export' | 'hard-reset' | 'scanned-files' | 'telemetry';

const DEBUG_SECTIONS: { id: DebugSection; label: string }[] = [
  { id: 'apps', label: 'Logs' },
  { id: 'kernels', label: 'Kernels' },
  { id: 'observations', label: 'Observations' },
  { id: 'file-monitor', label: 'File Monitor' },
  { id: 'storage', label: 'Storage' },
  { id: 'auth', label: 'API Key' },
  { id: 'scanned-files', label: 'Scanned Files' },
  { id: 'telemetry', label: 'Telemetry' },
  { id: 'export', label: 'Export' },
  { id: 'hard-reset', label: 'Hard Reset' },
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

export const DebugContent: React.FC<{ activeSection: DebugSection; onRestartOnboarding?: () => void }> = ({ activeSection, onRestartOnboarding }) => {
  return (
    <div className="debugContent">
      {activeSection === 'apps' && <AppsDebug />}
      {activeSection === 'kernels' && <KernelsDebug />}
      {activeSection === 'observations' && <ObservationsDebug />}
      {activeSection === 'file-monitor' && <FileMonitorDebug />}
      {activeSection === 'storage' && <StorageDebug />}
      {activeSection === 'auth' && <AuthDebug />}
      {activeSection === 'scanned-files' && <ScannedFilesDebug />}
      {activeSection === 'telemetry' && <TelemetryDebug />}
      {activeSection === 'export' && <ExportDebug />}
      {activeSection === 'hard-reset' && <HardResetDebug onRestartOnboarding={onRestartOnboarding} />}
    </div>
  );
};
