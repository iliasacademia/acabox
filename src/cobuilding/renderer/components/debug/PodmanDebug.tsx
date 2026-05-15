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
  const [baseImageDownloaded, setBaseImageDownloaded] = useState(false);
  const [imageSource, setImageSource] = useState<ImageSource>('registry');
  const [baseImageInProgress, setBaseImageInProgress] = useState(false);
  const [deletingImage, setDeletingImage] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [envInfo, setEnvInfo] = useState<EnvironmentInfoPayload | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [expandedApps, setExpandedApps] = useState<Set<string>>(new Set());
  const [bgBuildMessage, setBgBuildMessage] = useState<string | null>(null);
  type PackageStates = Record<PackageRegistry, Record<string, PackageState>>;
  const emptyPackageStates: PackageStates = { pip: {}, npm: {}, R: {}, apt: {}, manual: {} };
  const [packageStates, setPackageStates] = useState<PackageStates>(emptyPackageStates);
  // Latest streamed line per (registry, package), shown next to the active row.
  const [packageLines, setPackageLines] = useState<Record<string, string>>({});
  const [liveContainerExpanded, setLiveContainerExpanded] = useState(false);
  const [overlayEnabled, setOverlayEnabled] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [skipImageBuild, setSkipImageBuild] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [pruneResult, setPruneResult] = useState<string | null>(null);
  const [gracefulShutdownBusy, setGracefulShutdownBusy] = useState(false);
  const [gracefulShutdownDone, setGracefulShutdownDone] = useState(false);
  const [resetDownloadBusy, setResetDownloadBusy] = useState(false);
  const [downloadResetDone, setDownloadResetDone] = useState(false);

  const isDev = window.authAPI.isDev;

  const refreshStatus = useCallback(async () => {
    try {
      const [{ running: isRunning }, mode, bundled, name, baseDownloaded, imgSource, env, skipBuild] = await Promise.all([
        window.containerAPI.status(),
        window.containerAPI.getBinaryMode(),
        window.containerAPI.getBundledStatus(),
        window.containerAPI.getName(),
        window.containerAPI.isBaseImageDownloaded(),
        window.containerAPI.getImageSource(),
        window.containerAPI.getEnvironmentInfo(),
        window.containerAPI.getSkipImageBuild(),
      ]);
      setRunning(isRunning);
      setBinaryMode(mode);
      setBundledDownloaded(bundled.downloaded);
      setContainerName(name);
      setBaseImageDownloaded(baseDownloaded);
      setImageSource(imgSource);
      setEnvInfo(env);
      setSkipImageBuild(skipBuild);
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

  // Track base image download progress only. Build stages (workspace deps
  // layering on top of the base) are surfaced via the Environment section's
  // Background build row, not here.
  useEffect(() => {
    const cleanup = window.containerAPI.onProgress((progress) => {
      if (progress.stage === 'pull') {
        setBaseImageInProgress(true);
      } else if (progress.stage === 'ready' || progress.stage === 'setup-done' || progress.stage === 'run') {
        setBaseImageInProgress(false);
      }
    });
    return cleanup;
  }, []);

  // Seed package states from each envInfo poll. Reconciles every 3s in case
  // a realtime event was missed.
  useEffect(() => {
    if (!envInfo) return;
    setPackageStates(envInfo.packageStates);
  }, [envInfo]);

  // Apply realtime per-package state and line events.
  useEffect(() => {
    const cleanups = [
      window.containerAPI.onPackageState((e) => {
        setPackageStates((prev) => ({
          ...prev,
          [e.registry]: { ...prev[e.registry], [e.package]: e.state },
        }));
      }),
      window.containerAPI.onPackageLine((e) => {
        setPackageLines((prev) => ({ ...prev, [`${e.registry}:${e.package}`]: e.line }));
      }),
    ];
    return () => cleanups.forEach((fn) => fn());
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

  useEffect(() => {
    if (running) {
      setGracefulShutdownDone(false);
      setDownloadResetDone(false);
    }
  }, [running]);

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

  const handleToggleSkipImageBuild = async () => {
    const newValue = !skipImageBuild;
    setError(null);
    try {
      await window.containerAPI.setSkipImageBuild(newValue);
      setSkipImageBuild(newValue);
      await window.containerAPI.relaunchApp();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
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

  const handleGracefulShutdownPodman = async () => {
    setGracefulShutdownBusy(true);
    setError(null);
    try {
      await window.containerAPI.gracefulShutdownPodman();
      setGracefulShutdownDone(true);
      setRunning(false);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGracefulShutdownBusy(false);
    }
  };

  const handleResetImageDownload = async () => {
    setResetDownloadBusy(true);
    setError(null);
    try {
      await window.containerAPI.clearImageDownloadState();
      setDownloadResetDone(true);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setResetDownloadBusy(false);
    }
  };

  const handleRelaunchApp = () => {
    setError(null);
    void window.containerAPI.relaunchApp();
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

  const handlePruneImages = async () => {
    setPruning(true);
    setPruneResult(null);
    setError(null);
    try {
      await window.debugAPI.pruneImages();
      setPruneResult('Prune complete — check logs for details');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPruning(false);
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
      setBaseImageDownloaded(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingImage(false);
    }
  };

  // Registry-mode equivalent of "build image": pull the base then auto-start
  // so the user lands in a working state in one click.
  const handleDownloadImage = async () => {
    setError(null);
    setBaseImageInProgress(true);
    try {
      await window.containerAPI.downloadImage();
      setBaseImageDownloaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    } finally {
      setBaseImageInProgress(false);
    }
    await handleStart();
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
        <span className="debugSection__modeLabel">Base Image Source:</span>
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

      <div className="debugSection__modeToggle">
        <span className="debugSection__modeLabel">Skip Image Build:</span>
        <button
          className={`debugSection__modeBtn ${skipImageBuild ? 'debugSection__modeBtn--active' : ''}`}
          onClick={skipImageBuild ? undefined : handleToggleSkipImageBuild}
          disabled={skipImageBuild}
          title="Skip building workspace image layers — use base image directly and install deps live"
        >
          {skipImageBuild ? 'Enabled' : 'Enable & Relaunch'}
        </button>
        <button
          className={`debugSection__modeBtn ${!skipImageBuild ? 'debugSection__modeBtn--active' : ''}`}
          onClick={!skipImageBuild ? undefined : handleToggleSkipImageBuild}
          disabled={!skipImageBuild}
          title="Build workspace image layers as normal"
        >
          {!skipImageBuild ? 'Disabled' : 'Disable & Relaunch'}
        </button>
      </div>

      <div className="debugSection__infoRow">
        <span className="debugSection__infoLabel">Base Image:</span>
        {deletingImage ? (
          <span className="debugSection__imageInProgress">Deleting...</span>
        ) : baseImageInProgress ? (
          <span className="debugSection__imageInProgress">Downloading...</span>
        ) : baseImageDownloaded ? (
          <>
            <span className="debugSection__bundledOk">Downloaded</span>
            <button
              className="debugSection__btnInline debugSection__btnInline--danger"
              onClick={handleDeleteImage}
              disabled={running}
              title="Remove the base image"
            >
              <Trash2 size={14} />
            </button>
          </>
        ) : (
          <>
            <span className="debugSection__imageNotBuilt">Not downloaded</span>
            <button
              className="debugSection__btnInline"
              onClick={imageSource === 'registry' ? handleDownloadImage : handleStart}
              disabled={starting || running || needsDownload || baseImageInProgress}
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
        packageStates={packageStates}
        packageLines={packageLines}
        liveContainerExpanded={liveContainerExpanded}
        onToggleLiveContainer={() => setLiveContainerExpanded((v) => !v)}
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

      <div
        style={{
          margin: '12px 0',
          padding: '12px',
          background: '#faf6f0',
          borderRadius: 6,
          border: '1px solid #e8dcc8',
        }}
      >
        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: '#666', fontWeight: 600, marginBottom: 8 }}>
          Download reset
        </div>
        <p style={{ fontSize: 12, color: '#555', margin: '0 0 10px' }}>
          Same steps as <code>scripts/reset-downloads.sh</code>: after graceful shutdown, destroy the machine, remove bundled Podman binaries, image cache,
          isolated Podman HOME and runtime dirs, app-local podman data, and clear <code>loadedImageVersion</code> / <code>imageTier</code> in settings. Then{' '}
          {isDev ? 'quit the app (restart from your dev terminal).' : 'relaunch the app so setup can run again.'}
        </p>
        <div className="debugSection__actions" style={{ flexWrap: 'wrap', gap: 8 }}>
          <button
            type="button"
            className="debugSection__btn debugSection__btn--stop"
            onClick={handleGracefulShutdownPodman}
            disabled={gracefulShutdownBusy || !running || gracefulShutdownDone}
            title="Stop agent and container, then podman machine stop"
          >
            {gracefulShutdownBusy ? 'Shutting down…' : 'Graceful shutdown (Podman + VM)'}
          </button>
          <button
            type="button"
            className="debugSection__btn"
            onClick={handleResetImageDownload}
            disabled={!gracefulShutdownDone || resetDownloadBusy || downloadResetDone}
            title="Same as reset-downloads.sh: machine rm, binaries, caches, podman dirs, settings keys"
          >
            {resetDownloadBusy ? 'Clearing…' : 'Reset downloads'}
          </button>
          <button
            type="button"
            className="debugSection__btn debugSection__btn--start"
            onClick={handleRelaunchApp}
            disabled={!downloadResetDone}
            title={
              isDev
                ? 'Quit the app (development — relaunch is only for packaged builds)'
                : 'Quit and start the app again'
            }
          >
            {isDev ? 'Quit app' : 'Relaunch app'}
          </button>
        </div>
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
        <button
          className="debugSection__btn"
          onClick={handlePruneImages}
          disabled={pruning}
          title="Remove unused images and reclaim VM disk space"
        >
          {pruning ? 'Pruning...' : 'Prune Images'}
        </button>
      </div>
      {pruneResult && (
        <span style={{ fontSize: 12, color: '#28a745', marginTop: 4, display: 'block' }}>{pruneResult}</span>
      )}

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
  packageStates: Record<PackageRegistry, Record<string, PackageState>>;
  packageLines: Record<string, string>;
  liveContainerExpanded: boolean;
  onToggleLiveContainer: () => void;
  onRebuildEnvironment: () => void;
  onToggleApp: (name: string) => void;
}

const subBlockStyle: React.CSSProperties = {
  margin: '8px 0', padding: '10px', background: '#fff', borderRadius: 4, border: '1px solid #e8e8e8',
};

const subHeadingStyle: React.CSSProperties = {
  margin: '0 0 6px', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4, color: '#666', fontWeight: 600,
};

const EnvironmentSection: React.FC<EnvironmentSectionProps> = ({
  envInfo, rebuilding, bgBuildMessage, running,
  expandedApps, packageStates, packageLines, liveContainerExpanded,
  onToggleLiveContainer, onRebuildEnvironment, onToggleApp,
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

  // Bucket packages by registry × state for the live container view.
  const registryOrder: PackageRegistry[] = ['pip', 'apt', 'R', 'npm', 'manual'];
  const isActive = (s: PackageState) => s === 'queued' || s === 'installing' || s === 'failed';
  const activePackages = registryOrder.flatMap((r) =>
    Object.entries(packageStates[r] ?? {})
      .filter(([, s]) => isActive(s))
      .map(([pkg, state]) => ({ registry: r, package: pkg, state })),
  );
  const totalActive = activePackages.length;

  return (
    <div style={{ margin: '16px 0', padding: '12px', background: '#f8f9fa', borderRadius: 6, border: '1px solid #e0e0e0' }}>
      <h4 className="debugSection__subtitle" style={{ marginTop: 0 }}>Environment</h4>

      {/* ─── Live container ─── */}
      <div style={subBlockStyle}>
        <div style={subHeadingStyle}>Live container</div>
        <div className="debugSection__infoRow">
          <span
            className={`debugSection__indicator ${
              !running ? 'debugSection__indicator--stopped'
                : totalActive > 0 ? 'debugSection__indicator--starting'
                : 'debugSection__indicator--running'
            }`}
            style={{ display: 'inline-block', marginRight: 6 }}
          />
          {!running ? (
            <span style={{ color: '#666' }}>No container running</span>
          ) : totalActive === 0 ? (
            <span style={{ color: '#1a7f37' }}>All packages installed</span>
          ) : (
            <button
              onClick={onToggleLiveContainer}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                display: 'inline-flex', alignItems: 'center', gap: 4, color: '#bf8700', fontSize: 13,
              }}
              title={liveContainerExpanded ? 'Hide active packages' : 'Show active packages'}
            >
              {liveContainerExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              Installing {totalActive} package{totalActive !== 1 ? 's' : ''}
            </button>
          )}
        </div>
        {running && totalActive > 0 && liveContainerExpanded && (
          <div style={{ marginTop: 6, paddingLeft: 18 }}>
            {activePackages.map(({ registry, package: pkg, state }) => {
              const line = packageLines[`${registry}:${pkg}`];
              const name = registry === 'npm' ? pkg.split('@')[0] : pkg;
              const stateColor = state === 'installing' ? '#bf8700'
                : state === 'failed' ? '#cf222e' : '#888';
              const icon = state === 'installing' ? '⟳' : state === 'failed' ? '✗' : '⊘';
              return (
                <div key={`${registry}:${pkg}`} style={{ fontSize: 12, marginBottom: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ color: stateColor, width: 12, textAlign: 'center' }}>{icon}</span>
                    <span style={{ color: '#888', fontSize: 10, fontWeight: 600, minWidth: 38 }}>{registry}</span>
                    <code style={{ color: '#333' }}>{name}</code>
                    <span style={{ color: '#888', fontSize: 11 }}>{state}</span>
                  </div>
                  {state === 'installing' && line && (
                    <div style={{
                      fontFamily: 'SF Mono, Menlo, Monaco, monospace', fontSize: 10, color: '#aaa',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      marginLeft: 60,
                    }}>
                      {line}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ─── Next-session image ─── */}
      <div style={subBlockStyle}>
        <div style={subHeadingStyle}>Next-session image</div>
        <div className="debugSection__infoRow">
          <span className="debugSection__infoLabel">Type:</span>
          {envInfo.imageType === 'user' ? (
            <span className="debugSection__bundledOk">User image ({totalPkgs} extra package{totalPkgs !== 1 ? 's' : ''})</span>
          ) : (
            <span style={{ color: '#666' }}>Base image only</span>
          )}
        </div>
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
        <div className="debugSection__infoRow">
          <span className="debugSection__infoLabel">Build:</span>
          <span
            className={`debugSection__indicator ${envInfo.backgroundBuildState !== 'idle' ? 'debugSection__indicator--starting' : ''}`}
            style={{ display: 'inline-block', marginRight: 4 }}
          />
          <span>{bgBuildMessage || buildStateLabel(envInfo.backgroundBuildState)}</span>
        </div>
        <div className="debugSection__actions" style={{ marginTop: 8 }}>
          <button
            className="debugSection__btn debugSection__btn--start"
            onClick={onRebuildEnvironment}
            disabled={rebuilding || !running}
            title="Regenerate environment from dep files and rebuild image"
          >
            {rebuilding ? 'Rebuilding...' : 'Rebuild image'}
          </button>
        </div>
      </div>

      {/* ─── Installed packages ─── */}
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
