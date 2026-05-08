import React from 'react';
import { PodmanDebug } from './PodmanDebug';
import { AppsDebug } from './AppsDebug';
import { KernelsDebug } from './KernelsDebug';
import { ObservationsDebug } from './ObservationsDebug';
import { BrowserExtensionDebug } from './BrowserExtensionDebug';
import { FileMonitorDebug } from './FileMonitorDebug';
import { StorageDebug } from './StorageDebug';
import { TerminalDebug } from './TerminalDebug';
import { AuthDebug } from './AuthDebug';
import { OfficeAddinDebug } from './OfficeAddinDebug';
import { ExportDebug } from './ExportDebug';
import { HardResetDebug } from './HardResetDebug';
import './DebugPanel.css';

export type DebugSection = 'podman' | 'apps' | 'observations' | 'kernels' | 'browser-extension' | 'file-monitor' | 'storage' | 'terminal' | 'auth' | 'office-addin' | 'export' | 'hard-reset';

const DEBUG_SECTIONS: { id: DebugSection; label: string }[] = [
  { id: 'apps', label: 'Logs' },
  { id: 'podman', label: 'Podman' },
  { id: 'terminal', label: 'Container Terminal' },
  { id: 'kernels', label: 'Kernels' },
  { id: 'observations', label: 'Observations' },
  { id: 'browser-extension', label: 'Browser Extension' },
  { id: 'file-monitor', label: 'File Monitor' },
  { id: 'storage', label: 'Storage' },
  { id: 'auth', label: 'API Key' },
  { id: 'office-addin', label: 'Office Add-in' },
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
      {activeSection === 'podman' && <PodmanDebug />}
      {activeSection === 'apps' && <AppsDebug />}
      {activeSection === 'terminal' && <TerminalDebug />}
      {activeSection === 'kernels' && <KernelsDebug />}
      {activeSection === 'observations' && <ObservationsDebug />}
      {activeSection === 'browser-extension' && <BrowserExtensionDebug />}
      {activeSection === 'file-monitor' && <FileMonitorDebug />}
      {activeSection === 'storage' && <StorageDebug />}
      {activeSection === 'auth' && <AuthDebug />}
      {activeSection === 'office-addin' && <OfficeAddinDebug />}
      {activeSection === 'export' && <ExportDebug />}
      {activeSection === 'hard-reset' && <HardResetDebug onRestartOnboarding={onRestartOnboarding} />}
    </div>
  );
};
