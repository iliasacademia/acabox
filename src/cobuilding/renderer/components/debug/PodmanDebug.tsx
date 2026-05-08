import React, { useState, useEffect, useCallback } from 'react';
import { Trash2, ChevronRight, ChevronDown } from 'lucide-react';
import { ContainerTests } from '../ContainerTests';

type BinaryMode = 'system' | 'bundled';
type ImageSource = 'registry' | 'local';

export const PodmanDebug: React.FC = () => {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [binaryMode, setBinaryMode] = useState<BinaryMode>('bundled');
  const [bundledDownloaded, setBundledDownloaded] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [containerName, setContainerName] = useState('');
  const [imageBuilt, setImageBuilt] = useState(false);
  const [imageSource, setImageSource] = useState<ImageSource>('registry');
  const [imageInProgress, setImageInProgress] = useState(false);
  const [deletingImage, setDeletingImage] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [envInfo, setEnvInfo] = useState<EnvironmentInfoPayload | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [expandedApps, setExpandedApps] = useState<Set<string>>(new Set());
  const [bgBuildMessage, setBgBuildMessage] = useState<string | null>(null);
  const [overlayEnabled, setOverlayEnabled] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const [{ running: isRunning }, mode, bundled, name, imgBuilt, imgSource, env] = await Promise.all([
        window.containerAPI.status(),
        window.containerAPI.getBinaryMode(),
        window.containerAPI.getBundledStatus(),
        window.containerAPI.getName(),
        window.containerAPI.isImageBuilt(),
        window.containerAPI.getImageSource(),
        window.containerAPI.getEnvironmentInfo(),
      ]);
      setRunning(isRunning);
      setBinaryMode(mode);
      setBundledDownloaded(bundled.downloaded);
      setContainerName(name);
      setImageBuilt(imgBuilt);
      setImageSource(imgSource);
      setEnvInfo(env);
      const overlay = await window.debugAPI.isOverlayEnabled();
      setOverlayEnabled(overlay);
      // Clear transient states when underlying state settles
      if (isRunning) setStarting(false);
      if (!isRunning && !starting) setStopping(false);
    } catch {
      setRunning(false);
    } finally {
      setInitializing(false);
    }
  }, [starting]);

  useEffect(() => {
    refreshStatus();
    const interval = setInterval(refreshStatus, 3000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  // Track image build/download progress to show inline status
  useEffect(() => {
    const cleanup = window.containerAPI.onProgress((progress) => {
      const imageStages = ['pull', 'build', 'build-image'];
      const imageDoneStages = ['build-image-done', 'run', 'ready', 'setup-done'];
      if (imageStages.includes(progress.stage)) {
        setImageInProgress(true);
      } else if (imageDoneStages.includes(progress.stage)) {
        setImageInProgress(false);
      }
    });
    return cleanup;
  }, []);

  // Track background build progress
  useEffect(() => {
    const cleanup = window.containerAPI.onBackgroundBuild((progress) => {
      if (progress.stage === 'background-build-done') {
        setBgBuildMessage(null);
        setRebuilding(false);
        refreshStatus();
      } else if (progress.stage === 'background-build-error') {
        setBgBuildMessage(`Error: ${progress.message}`);
        setRebuilding(false);
      } else {
        setBgBuildMessage(progress.message);
      }
    });
    return cleanup;
  }, [refreshStatus]);

  const handleRebuildEnvironment = async () => {
    setRebuilding(true);
    setError(null);
    setBgBuildMessage('Starting rebuild...');
    try {
      await window.containerAPI.rebuildEnvironment();
      setBgBuildMessage(null);
      setRebuilding(false);
      refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBgBuildMessage(null);
      setRebuilding(false);
    }
  };

  const toggleApp = (name: string) => {
    setExpandedApps((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleImageSourceChange = async (source: ImageSource) => {
    setError(null);
    try {
      await window.containerAPI.setImageSource(source);
      setImageSource(source);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleModeChange = async (mode: BinaryMode) => {
    setError(null);
    try {
      await window.containerAPI.setBinaryMode(mode);
      setBinaryMode(mode);
      if (mode === 'bundled') {
        const status = await window.containerAPI.getBundledStatus();
        setBundledDownloaded(status.downloaded);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDownload = async () => {
    setDownloading(true);
    setError(null);
    try {
      await window.containerAPI.downloadBinaries();
      setBundledDownloaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  };

  const handleStart = async () => {
    setStarting(true);
    setError(null);
    try {
      await window.containerAPI.start();
      setRunning(true);
      setImageBuilt(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    setStopping(true);
    setError(null);
    try {
      await window.containerAPI.stop();
      setRunning(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  };

  const handleDeleteBinaries = async () => {
    setError(null);
    try {
      await window.containerAPI.deleteBinaries();
      setBundledDownloaded(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSyncOverlay = async () => {
    setSyncing(true);
    setSyncResult(null);
    setError(null);
    try {
      const { durationMs } = await window.debugAPI.syncOverlay();
      setSyncResult(`Synced in ${durationMs}ms`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  };

  const handleDeleteImage = async () => {
    setError(null);
    setDeletingImage(true);
    try {
      await window.containerAPI.deleteImage();
      setImageBuilt(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingImage(false);
    }
  };

  if (initializing) {
    return (
      <div className="debugSection">
        <h3 className="debugSection__title">Podman Container</h3>
        <div className="debugSection__status"><span>Loading...</span></div>
      </div>
    );
  }

  const needsDownload = binaryMode === 'bundled' && !bundledDownloaded;
  const canStart = !starting && !running && !needsDownload;

  return (
    <div className="debugSection">
      <h3 className="debugSection__title">Podman Container</h3>

      <div className="debugSection__modeToggle">
        <span className="debugSection__modeLabel">Binary:</span>
        <button
          className={`debugSection__modeBtn ${binaryMode === 'bundled' ? 'debugSection__modeBtn--active' : ''}`}
          onClick={() => handleModeChange('bundled')}
          disabled={running}
          title="Use a bundled podman binary (downloaded separately)"
        >
          Bundled
        </button>
        <button
          className={`debugSection__modeBtn ${binaryMode === 'system' ? 'debugSection__modeBtn--active' : ''}`}
          onClick={() => handleModeChange('system')}
          disabled={running}
          title="Use podman installed on the system PATH"
        >
          System
        </button>
        {running && <span className="debugSection__modeLock">locked while running</span>}
      </div>

      {binaryMode === 'bundled' && (
        <div className="debugSection__bundledStatus">
          {bundledDownloaded ? (
            <div className="debugSection__bundledRow">
              <span className="debugSection__bundledOk">✓ Bundled binaries present</span>
              <button
                className="debugSection__btnInline debugSection__btnInline--danger"
                onClick={handleDeleteBinaries}
                disabled={running}
                title="Remove downloaded Podman binaries"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ) : (
            <div className="debugSection__bundledMissing">
              <span>Bundled binaries not found</span>
              <button
                className="debugSection__btn debugSection__btn--download"
                onClick={handleDownload}
                disabled={downloading}
              >
                {downloading ? 'Downloading...' : 'Download Binaries'}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="debugSection__modeToggle">
        <span className="debugSection__modeLabel">Image Source:</span>
        <button
          className={`debugSection__modeBtn ${imageSource === 'registry' ? 'debugSection__modeBtn--active' : ''}`}
          onClick={() => handleImageSourceChange('registry')}
          disabled={running}
          title="Pull prebuilt base image from GitHub Container Registry"
        >
          From Registry
        </button>
        <button
          className={`debugSection__modeBtn ${imageSource === 'local' ? 'debugSection__modeBtn--active' : ''}`}
          onClick={() => handleImageSourceChange('local')}
          disabled={running}
          title="Build the base image locally from Dockerfile.base (slow)"
        >
          Build Locally
        </button>
        {running && <span className="debugSection__modeLock">locked while running</span>}
      </div>

      <div className="debugSection__infoRow">
        <span className="debugSection__infoLabel">Image:</span>
        {deletingImage ? (
          <span className="debugSection__imageInProgress">Deleting...</span>
        ) : imageInProgress ? (
          <span className="debugSection__imageInProgress">
            {imageSource === 'registry' ? 'Downloading...' : 'Building...'}
          </span>
        ) : imageBuilt ? (
          <>
            <span className="debugSection__bundledOk">
              {imageSource === 'registry' ? 'Image downloaded' : 'Ready'}
            </span>
            <button
              className="debugSection__btnInline debugSection__btnInline--danger"
              onClick={handleDeleteImage}
              disabled={running}
              title="Remove the container image"
            >
              <Trash2 size={14} />
            </button>
          </>
        ) : (
          <>
            <span className="debugSection__imageNotBuilt">
              {imageSource === 'registry' ? 'Not downloaded' : 'Not built'}
            </span>
            <button
              className="debugSection__btnInline"
              onClick={handleStart}
              disabled={starting || running || needsDownload}
            >
              {imageSource === 'local' ? 'Build image' : 'Download image'}
            </button>
          </>
        )}
      </div>

      {/* ─── Environment Section ─── */}
      {envInfo && <EnvironmentSection
        envInfo={envInfo}
        rebuilding={rebuilding}
        bgBuildMessage={bgBuildMessage}
        running={running}
        expandedApps={expandedApps}
        onRebuildEnvironment={handleRebuildEnvironment}
        onToggleApp={toggleApp}
      />}

      <div className="debugSection__infoRow">
        <span className="debugSection__infoLabel">Container Name:</span>
        <code className="debugSection__infoValue">{containerName}</code>
      </div>

      <div className="debugSection__status">
        <span
          className={`debugSection__indicator ${running ? 'debugSection__indicator--running' : starting ? 'debugSection__indicator--starting' : 'debugSection__indicator--stopped'}`}
        />
        <span>{running ? 'Running' : starting ? 'Starting...' : stopping ? 'Stopping...' : 'Stopped'}</span>
      </div>

      <div className="debugSection__actions">
        <button
          className="debugSection__btn debugSection__btn--start"
          onClick={handleStart}
          disabled={!canStart}
        >
          {starting ? 'Starting...' : 'Start'}
        </button>
        <button
          className="debugSection__btn debugSection__btn--stop"
          onClick={handleStop}
          disabled={stopping || !running}
        >
          {stopping ? 'Stopping...' : 'Stop'}
        </button>
      </div>

      {running && overlayEnabled && (
        <div style={{ margin: '12px 0', padding: '12px', background: '#f0f7ff', borderRadius: 6, border: '1px solid #b3d4fc' }}>
          <div className="debugSection__infoRow">
            <span className="debugSection__infoLabel">OverlayFS:</span>
            <span className="debugSection__bundledOk">Active</span>
          </div>
          <p style={{ fontSize: 12, color: '#555', margin: '4px 0 8px' }}>
            Writes go to container-local storage. Sync to push changes back to host.
          </p>
          <div className="debugSection__actions">
            <button
              className="debugSection__btn debugSection__btn--start"
              onClick={handleSyncOverlay}
              disabled={syncing}
            >
              {syncing ? 'Syncing...' : 'Sync Files'}
            </button>
          </div>
          {syncResult && (
            <span style={{ fontSize: 12, color: '#28a745', marginTop: 4, display: 'block' }}>{syncResult}</span>
          )}
        </div>
      )}

      {error && (
        <div className="debugSection__error">{error}</div>
      )}

      {running && <ContainerTests />}
    </div>
  );
};

// ─── Environment Sub-component ────────────────────────────────

interface EnvironmentSectionProps {
  envInfo: EnvironmentInfoPayload;
  rebuilding: boolean;
  bgBuildMessage: string | null;
  running: boolean;
  expandedApps: Set<string>;
  onRebuildEnvironment: () => void;
  onToggleApp: (name: string) => void;
}

const EnvironmentSection: React.FC<EnvironmentSectionProps> = ({
  envInfo, rebuilding, bgBuildMessage, running,
  expandedApps, onRebuildEnvironment, onToggleApp,
}) => {
  const totalPkgs = envInfo.totalPip.length + envInfo.totalNpm.length +
    envInfo.totalR.length + envInfo.totalApt.length + envInfo.totalSetup.length;

  const buildStateLabel = (state: string) => {
    switch (state) {
      case 'building': return 'Building...';
      case 'building-pending': return 'Building (another queued)...';
      default: return 'Idle';
    }
  };

  const appsWithDeps = envInfo.apps.filter(
    (a) => a.pip.length > 0 || Object.keys(a.npm).length > 0 ||
      a.r.length > 0 || a.apt.length > 0 || a.setup.length > 0,
  );

  return (
    <div style={{ margin: '16px 0', padding: '12px', background: '#f8f9fa', borderRadius: 6, border: '1px solid #e0e0e0' }}>
      <h4 className="debugSection__subtitle" style={{ marginTop: 0 }}>Environment</h4>

      {/* Image type */}
      <div className="debugSection__infoRow">
        <span className="debugSection__infoLabel">Image type:</span>
        {envInfo.imageType === 'user' ? (
          <span className="debugSection__bundledOk">User image ({totalPkgs} extra package{totalPkgs !== 1 ? 's' : ''})</span>
        ) : (
          <span style={{ color: '#666' }}>Base image only</span>
        )}
      </div>

      {/* Hash / sync status */}
      <div className="debugSection__infoRow">
        <span className="debugSection__infoLabel">Sync:</span>
        {envInfo.inSync ? (
          <span className="debugSection__bundledOk">In sync</span>
        ) : envInfo.environmentHash ? (
          <span style={{ color: '#bf8700' }}>Rebuild needed</span>
        ) : (
          <span style={{ color: '#666' }}>Not yet built</span>
        )}
        {envInfo.imageHash && (
          <code className="debugSection__mono" style={{ marginLeft: 8 }} title="Image hash">
            {envInfo.imageHash}
          </code>
        )}
      </div>

      {/* Background build status */}
      <div className="debugSection__infoRow">
        <span className="debugSection__infoLabel">Background build:</span>
        <span className={`debugSection__indicator ${envInfo.backgroundBuildState !== 'idle' ? 'debugSection__indicator--starting' : ''}`}
          style={{ display: 'inline-block', marginRight: 4 }} />
        <span>{bgBuildMessage || buildStateLabel(envInfo.backgroundBuildState)}</span>
      </div>

      {/* Actions */}
      <div className="debugSection__actions" style={{ marginTop: 8 }}>
        <button
          className="debugSection__btn debugSection__btn--start"
          onClick={onRebuildEnvironment}
          disabled={rebuilding || !running}
          title="Regenerate environment from dep files and rebuild image"
        >
          {rebuilding ? 'Rebuilding...' : 'Rebuild Environment'}
        </button>
      </div>

      {/* Package totals */}
      {totalPkgs > 0 && (
        <>
          <h4 className="debugSection__subtitle">Installed packages (total)</h4>
          <PackageTable rows={[
            ...envInfo.totalPip.map((p) => ({ registry: 'pip', pkg: p })),
            ...envInfo.totalNpm.map((p) => ({ registry: 'npm', pkg: p })),
            ...envInfo.totalR.map((p) => ({ registry: 'R', pkg: p })),
            ...envInfo.totalApt.map((p) => ({ registry: 'apt', pkg: p })),
            ...envInfo.totalSetup.map((p) => ({ registry: 'manual', pkg: p })),
          ]} />
        </>
      )}

      {/* Per-app breakdown */}
      {appsWithDeps.length > 0 && (
        <>
          <h4 className="debugSection__subtitle">Per-app breakdown</h4>
          {appsWithDeps.map((app) => {
            const expanded = expandedApps.has(app.name);
            const npmEntries = Object.entries(app.npm);
            const count = app.pip.length + npmEntries.length + app.r.length + app.apt.length + app.setup.length;
            return (
              <div key={app.name} style={{ marginBottom: 4 }}>
                <button
                  onClick={() => onToggleApp(app.name)}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0',
                    display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#333', fontWeight: 500,
                  }}
                >
                  {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <code>{app.name}</code>
                  <span style={{ color: '#888', fontWeight: 400 }}>({count} package{count !== 1 ? 's' : ''})</span>
                </button>
                {expanded && (
                  <div>
                    <PackageTable rows={[
                      ...app.pip.map((p) => ({ registry: 'pip', pkg: p })),
                      ...npmEntries.map(([n, v]) => ({ registry: 'npm', pkg: `${n}@${v}` })),
                      ...app.r.map((p) => ({ registry: 'R', pkg: p })),
                      ...app.apt.map((p) => ({ registry: 'apt', pkg: p })),
                      ...app.setup.map((p) => ({ registry: 'manual', pkg: p })),
                    ]} />
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      {totalPkgs === 0 && (
        <p style={{ fontSize: 12, color: '#888', margin: '8px 0 0' }}>
          No extra packages installed. Use <code>.applications/install</code> to add packages.
        </p>
      )}
    </div>
  );
};

const PackageTable: React.FC<{ rows: { registry: string; pkg: string }[] }> = ({ rows }) => {
  if (rows.length === 0) return null;
  return (
    <div className="debugSection__tableWrap">
      <table className="debugSection__table">
        <thead>
          <tr>
            <th>Registry</th>
            <th>Package</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={`${row.registry}-${row.pkg}-${i}`}>
              <td style={{ width: 50 }}>{row.registry}</td>
              <td className="debugSection__mono">{row.pkg}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
