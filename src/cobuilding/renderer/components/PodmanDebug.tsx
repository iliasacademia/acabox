import React, { useState, useEffect, useCallback } from 'react';
import { ContainerTests } from './ContainerTests';

type BinaryMode = 'system' | 'bundled';
type ImageSource = 'registry' | 'local';

export const PodmanDebug: React.FC = () => {
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [binaryMode, setBinaryMode] = useState<BinaryMode>('bundled');
  const [bundledDownloaded, setBundledDownloaded] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [containerName, setContainerName] = useState('');
  const [imageBuilt, setImageBuilt] = useState(false);
  const [imageSource, setImageSource] = useState<ImageSource>('registry');

  const refreshStatus = useCallback(async () => {
    try {
      const [{ running: isRunning }, mode, bundled, name, imgBuilt, imgSource] = await Promise.all([
        window.containerAPI.status(),
        window.containerAPI.getBinaryMode(),
        window.containerAPI.getBundledStatus(),
        window.containerAPI.getName(),
        window.containerAPI.isImageBuilt(),
        window.containerAPI.getImageSource(),
      ]);
      setRunning(isRunning);
      setBinaryMode(mode);
      setBundledDownloaded(bundled.downloaded);
      setContainerName(name);
      setImageBuilt(imgBuilt);
      setImageSource(imgSource);
    } catch {
      setRunning(false);
    } finally {
      setInitializing(false);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    const interval = setInterval(refreshStatus, 5000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  useEffect(() => {
    const cleanup = window.containerAPI.onProgress((progress) => {
      setProgressMessage(`[${progress.stage}] ${progress.message}`);
    });
    return cleanup;
  }, []);

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
    setProgressMessage(null);
    try {
      await window.containerAPI.downloadBinaries();
      setBundledDownloaded(true);
      setProgressMessage(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  };

  const handleStart = async () => {
    setLoading(true);
    setError(null);
    setProgressMessage(null);
    try {
      await window.containerAPI.start();
      setRunning(true);
      setImageBuilt(true);
      setProgressMessage(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    setError(null);
    setProgressMessage(null);
    try {
      await window.containerAPI.stop();
      setRunning(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
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

  const handleDeleteImage = async () => {
    setError(null);
    try {
      await window.containerAPI.deleteImage();
      setImageBuilt(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
  const canStart = !loading && !running && !needsDownload;

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
                🗑︎
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
        <span className="debugSection__modeLabel">Container Image:</span>
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
        <span className="debugSection__infoLabel">Container:</span>
        <code className="debugSection__infoValue">{containerName}</code>
      </div>

      <div className="debugSection__infoRow">
        <span className="debugSection__infoLabel">Image:</span>
        <span className={imageBuilt ? 'debugSection__bundledOk' : 'debugSection__imageNotBuilt'}>
          {imageBuilt ? 'Image built' : 'Image not built'}
        </span>
        {imageBuilt && (
          <button
            className="debugSection__btnInline debugSection__btnInline--danger"
            onClick={handleDeleteImage}
            disabled={running}
            title="Remove the container image"
          >
            🗑︎
          </button>
        )}
      </div>

      <div className="debugSection__status">
        <span
          className={`debugSection__indicator ${running ? 'debugSection__indicator--running' : loading && !running ? 'debugSection__indicator--starting' : 'debugSection__indicator--stopped'}`}
        />
        <span>{running ? 'Running' : loading && !running ? 'Starting...' : 'Stopped'}</span>
      </div>

      <div className="debugSection__actions">
        <button
          className="debugSection__btn debugSection__btn--start"
          onClick={handleStart}
          disabled={!canStart}
        >
          {loading && !running ? 'Starting...' : 'Start'}
        </button>
        <button
          className="debugSection__btn debugSection__btn--stop"
          onClick={handleStop}
          disabled={loading || !running}
        >
          {loading && running ? 'Stopping...' : 'Stop'}
        </button>
      </div>

      {progressMessage && (
        <div className="debugSection__progress">{progressMessage}</div>
      )}

      {error && (
        <div className="debugSection__error">{error}</div>
      )}

      {running && <ContainerTests />}
    </div>
  );
};
