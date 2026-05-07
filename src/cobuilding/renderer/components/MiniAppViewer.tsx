import React, { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { ArrowLeftIcon, CodeIcon, DownloadIcon, FolderIcon, MonitorIcon, RefreshCwIcon } from 'lucide-react';
import { useComposerRuntime } from '@assistant-ui/react';
import { useKernel } from './notebook/useKernel';
import { NotebookViewer } from './notebook/NotebookViewer';
import type { CellOutput } from './notebook/types';
import { useSetupState } from '../setupStore';

interface RequestFixError {
  kind: string;
  message: string;
  stack?: string;
  source?: string;
  timestamp: number;
}

function buildFixPrompt(appName: string, err: RequestFixError): string {
  const lines: string[] = [
    `An error occurred in mini-app \`${appName}\`. Please fix or explain it.`,
    '',
    `**Error type:** ${err.kind}`,
    `**Message:** ${err.message}`,
  ];
  if (err.source) lines.push(`**Source:** ${err.source}`);
  if (err.stack) {
    lines.push('', '**Stack trace:**', '```', err.stack, '```');
  }
  lines.push(
    '',
    'Before changing any code, first determine whether this error was caused by:',
    '1. **Bad input or user action** — in which case explain the problem to me clearly without changing the app code, OR',
    '2. **A bug in the app code** — in which case fix it.',
  );
  return lines.join('\n');
}

type RebuildState =
  | { kind: 'idle' }
  | { kind: 'building' }
  | { kind: 'error'; message: string };

interface MiniAppViewerProps {
  dirName: string;
  workspacePath: string;
  reloadNonce?: number;
  preBuilt?: boolean;
  onBack?: () => void;
}

export const MiniAppViewer: FC<MiniAppViewerProps> = ({ dirName, workspacePath, reloadNonce, preBuilt, onBack }) => {
  const [viewingSource, setViewingSource] = useState(false);
  const [rebuildKey, setRebuildKey] = useState(0);
  const [rebuildState, setRebuildState] = useState<RebuildState>({ kind: 'idle' });
  const appDir = `${workspacePath}/.applications/${dirName}`;

  // For pre-built apps, resolve the webpack-served URL
  const [nativeToolUrl, setNativeToolUrl] = useState<string | null>(null);
  useEffect(() => {
    if (preBuilt) {
      window.nativeToolsAPI.getUrl(dirName).then((url) => {
        if (url) setNativeToolUrl(url);
      });
    }
  }, [preBuilt, dirName]);

  const handleRebuild = useCallback(async () => {
    setRebuildState({ kind: 'building' });
    try {
      const result = await window.containerAPI.exec([
        'esbuild',
        `.applications/${dirName}/src/index.tsx`,
        '--bundle',
        `--outfile=.applications/${dirName}/dist/bundle.js`,
        '--jsx=automatic',
        '--loader:.tsx=tsx',
        '--loader:.ts=ts',
        '--format=iife',
        '--alias:@reusable=/data/.applications/_reusable',
      ]);
      if (result.exitCode !== 0) {
        setRebuildState({
          kind: 'error',
          message: result.stderr.trim() || result.stdout.trim() || `esbuild exited with code ${result.exitCode}`,
        });
        return;
      }
      setRebuildState({ kind: 'idle' });
      setRebuildKey((k) => k + 1);
      setViewingSource(false);
    } catch (err) {
      setRebuildState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [dirName]);

  useEffect(() => {
    if (preBuilt) return;
    window.filesAPI.readFile(`${appDir}/dist/bundle.js`).then((res: any) => {
      if (res?.error) handleRebuild();
    }).catch(() => handleRebuild());
  }, [appDir, handleRebuild, preBuilt]);

  const handleShowInFinder = useCallback(async () => {
    await window.filesAPI.showInFinder(appDir);
  }, [appDir]);

  return (
    <div className="miniAppViewer">
      <MiniAppHeader
        dirName={dirName}
        viewingSource={viewingSource}
        onToggleSource={() => setViewingSource((v) => !v)}
        onRebuild={handleRebuild}
        onShowInFinder={handleShowInFinder}
        rebuildState={rebuildState}
        preBuilt={preBuilt}
        onBack={onBack}
      />
      <div className="miniAppBody">
        {preBuilt && nativeToolUrl ? (
          <MiniAppContent
            key={`prebuilt-${reloadNonce ?? 0}`}
            dirName={dirName}
            workspacePath={workspacePath}
            preBuilt
            nativeToolUrl={nativeToolUrl}
          />
        ) : preBuilt ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <div style={{ width: 24, height: 24, border: '3px solid #e0e0e0', borderTopColor: '#666', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          </div>
        ) : (
          <ContainerGate dirName={dirName}>
            {viewingSource ? (
              <SourceViewer
                appDir={appDir}
                dirName={dirName}
                rebuildState={rebuildState}
              />
            ) : (
              <MiniAppContent
                key={`${rebuildKey}-${reloadNonce ?? 0}`}
                dirName={dirName}
                workspacePath={workspacePath}
              />
            )}
          </ContainerGate>
        )}
      </div>
    </div>
  );
};

const MiniAppHeader: FC<{
  dirName: string;
  viewingSource: boolean;
  onToggleSource: () => void;
  onRebuild: () => void;
  onShowInFinder: () => void;
  rebuildState: RebuildState;
  preBuilt?: boolean;
  onBack?: () => void;
}> = ({ dirName, viewingSource, onToggleSource, onRebuild, onShowInFinder, rebuildState, preBuilt, onBack }) => {
  const handleExport = useCallback(async () => {
    await window.miniAppsAPI.exportApp(dirName);
  }, [dirName]);

  const isBuilding = rebuildState.kind === 'building';

  return (
    <div className="miniAppHeader">
      {onBack && (
        <button className="toolDetailBackBtn" onClick={onBack}>
          <ArrowLeftIcon style={{ width: 14, height: 14 }} />
          Back to tools
        </button>
      )}
      <div className="miniAppHeader__right">
        {!preBuilt && (
          <>
            <div className="miniAppHeaderIconBtn__wrapper">
              <button
                className="miniAppHeaderIconBtn"
                onClick={handleExport}
              >
                <DownloadIcon style={{ width: 16, height: 16 }} />
              </button>
              <span className="miniAppHeaderIconBtn__tooltip">Download</span>
            </div>
            <div className="miniAppHeaderIconBtn__wrapper">
              <button
                className="miniAppHeaderIconBtn"
                onClick={onRebuild}
                disabled={isBuilding}
              >
                <RefreshCwIcon style={{ width: 16, height: 16, animation: isBuilding ? 'spin 0.8s linear infinite' : 'none' }} />
              </button>
              <span className="miniAppHeaderIconBtn__tooltip">Rebuild</span>
            </div>
            <div className="miniAppHeaderIconBtn__wrapper">
              <button
                className="miniAppHeaderIconBtn"
                onClick={onShowInFinder}
              >
                <FolderIcon style={{ width: 16, height: 16 }} />
              </button>
              <span className="miniAppHeaderIconBtn__tooltip">Show in Finder</span>
            </div>
          </>
        )}
        {!preBuilt && (
          <div className="miniAppHeaderViewToggle">
            <button
              className={`miniAppHeaderViewBtn${!viewingSource ? ' miniAppHeaderViewBtn--active' : ''}`}
              onClick={() => viewingSource && onToggleSource()}
              title="View tool"
            >
              <MonitorIcon style={{ width: 14, height: 14 }} />
              Tool
            </button>
            <button
              className={`miniAppHeaderViewBtn${viewingSource ? ' miniAppHeaderViewBtn--active' : ''}`}
              onClick={() => !viewingSource && onToggleSource()}
              title="View source"
            >
              <CodeIcon style={{ width: 14, height: 14 }} />
              Code
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

interface InstallStatus {
  registry: string;
  packages: string[];
  lastLine: string;
}

const InstallingView: FC<{ message: string; installStatus?: InstallStatus | null }> = ({ message, installStatus }) => (
  <div style={{
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    height: '100%', paddingBottom: '12vh', gap: 12, color: '#666', fontSize: 14,
  }}>
    <div style={{
      width: 24, height: 24, border: '3px solid #e0e0e0', borderTopColor: '#666',
      borderRadius: '50%', animation: 'spin 0.8s linear infinite',
    }} />
    <span>{message}</span>
    {installStatus && (
      <div style={{ fontSize: 12, color: '#888', textAlign: 'center', maxWidth: 400 }}>
        <div style={{ marginBottom: 4 }}>
          <strong>{installStatus.registry}</strong>: {installStatus.packages.join(', ')}
        </div>
        {installStatus.lastLine && (
          <div style={{
            fontFamily: 'SF Mono, Menlo, Monaco, monospace', fontSize: 10,
            color: '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {installStatus.lastLine}
          </div>
        )}
      </div>
    )}
    <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
  </div>
);

const ContainerGate: FC<{ dirName: string; children: React.ReactNode }> = ({ dirName, children }) => {
  const [containerReady, setContainerReady] = useState<boolean | null>(null);
  const [depsReady, setDepsReady] = useState<boolean | null>(null);
  const setup = useSetupState();
  const statusMessage = (setup.state === 'downloading' || setup.state === 'pending')
    ? (setup.message || 'Setting up environment...')
    : 'Waiting for container...';
  const [installStatus, setInstallStatus] = useState<InstallStatus | null>(null);

  // Check container status
  useEffect(() => {
    let cancelled = false;
    window.containerAPI.status().then(({ running }) => {
      if (!cancelled) setContainerReady(running);
    });
    return () => { cancelled = true; };
  }, []);

  // Wait for container to start
  useEffect(() => {
    if (containerReady) return;

    const cleanups = [
      window.containerAPI.onProgress((progress) => {
        if (progress.stage === 'ready') {
          setContainerReady(true);
        }
      }),
      window.containerAPI.onSetupProgress((progress) => {
        if (progress.stage === 'setup-done' || progress.stage === 'ready') {
          setContainerReady(true);
        }
      }),
    ];

    const interval = setInterval(async () => {
      const { running } = await window.containerAPI.status();
      if (running) setContainerReady(true);
    }, 3000);

    return () => {
      cleanups.forEach((fn) => fn());
      clearInterval(interval);
    };
  }, [containerReady]);

  // Listen for streaming install progress for this app
  useEffect(() => {
    const cleanup = window.containerAPI.onInstallProgress((progress) => {
      if (progress.dirName !== dirName) return;
      if (progress.type === 'step' && progress.registry && progress.packages) {
        setInstallStatus({ registry: progress.registry, packages: progress.packages, lastLine: '' });
      } else if (progress.type === 'line' && progress.line) {
        // If a line arrives before any step (e.g. we subscribed mid-install
        // and the replay path didn't fire), seed a minimal placeholder so the
        // line is still surfaced rather than silently dropped.
        setInstallStatus((prev) =>
          prev
            ? { ...prev, lastLine: progress.line! }
            : { registry: 'install', packages: [], lastLine: progress.line! },
        );
      } else if (progress.type === 'done') {
        setInstallStatus(null);
      }
    });
    return cleanup;
  }, [dirName]);

  // Once container is ready, ensure app deps are installed
  useEffect(() => {
    if (!containerReady) return;
    let cancelled = false;

    window.containerAPI.appDepsReady(dirName).then((ready) => {
      if (cancelled) return;
      if (ready) {
        setDepsReady(true);
        return;
      }
      window.containerAPI.ensureAppDeps(dirName)
        .then(() => { if (!cancelled) setDepsReady(true); })
        .catch((err) => {
          console.error(`[MiniAppViewer] Failed to install deps for ${dirName}:`, err);
          // Don't set depsReady on failure — keep showing the installing indicator.
          // The user can retry by closing and reopening the app.
        });
    });

    return () => { cancelled = true; };
  }, [containerReady, dirName]);

  if (containerReady === null) return null;
  if (!containerReady) return <InstallingView message={statusMessage} />;
  if (!depsReady) return <InstallingView message="Installing software..." installStatus={installStatus} />;

  return <>{children}</>;
};

const MiniAppContent = React.forwardRef<HTMLIFrameElement, { dirName: string; workspacePath: string; preBuilt?: boolean; nativeToolUrl?: string }>(({ dirName, workspacePath, preBuilt, nativeToolUrl }, ref) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  React.useImperativeHandle(ref, () => iframeRef.current!, []);
  const [loadError, setLoadError] = useState(false);
  const appDir = `${workspacePath}/.applications/${dirName}`;
  const { connect, executeCode } = useKernel(`miniapp::${dirName}`);
  const composerRuntime = useComposerRuntime();

  const handleIframeLoad = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      // If the iframe loaded an error page or about:blank, the contentDocument may be inaccessible
      const doc = iframe.contentDocument;
      if (doc && doc.title === '') {
        // Check if the body is essentially empty (failed load)
        const bodyText = doc.body?.innerText?.trim() ?? '';
        if (bodyText === 'Not Found' || bodyText === 'Forbidden' || (bodyText === '' && !nativeToolUrl)) {
          console.warn('[MiniAppContent] Iframe loaded but content appears missing for:', dirName);
          setLoadError(true);
          return;
        }
      }
    } catch {
      // Cross-origin — content loaded from a real page, which is fine
    }
    setLoadError(false);
    iframe.contentWindow?.postMessage(
      { type: 'init', workspacePath },
      '*',
    );
  }, [workspacePath, dirName, nativeToolUrl]);

  const handleBridgeMessage = useCallback(
    async (event: MessageEvent) => {
      const iframe = iframeRef.current;
      // event.source check is the correct origin-validation mechanism for local-file:// pages.
      // event.origin is unreliable on local-file:// in Electron (reported as "null" or "file://").
      if (!iframe || event.source !== iframe.contentWindow) return;

      const { type, id, ...args } = event.data;
      if (!type || !id) return;

      let result: unknown;
      let error: string | undefined;
      let skipResponse = false;

      try {
        switch (type) {
          case 'readFile':
            result = await window.filesAPI.readFile(args.path);
            break;
          case 'writeFile':
            if (preBuilt) { error = 'Write operations are disabled for pre-built apps'; break; }
            await window.filesAPI.writeFile(args.path, args.content);
            result = { ok: true };
            break;
          case 'copyFile': {
            const copyResult = await window.filesAPI.copyToWorkspace(
              [args.sourcePath as string],
              args.destinationDir as string,
            );
            result = copyResult;
            break;
          }
          case 'deleteFile':
            if (preBuilt) { error = 'Delete operations are disabled for pre-built apps'; break; }
            await window.filesAPI.deleteFile(args.path as string);
            result = { ok: true };
            break;
          case 'selectFile':
            result = await window.filesAPI.selectFile(args.filters);
            break;
          case 'downloadFile':
            result = await window.filesAPI.downloadFile(args.filename as string, args.content as string);
            break;
          case 'showInFinder':
            result = await window.filesAPI.showInFinder(args.path as string);
            break;
          case 'selectDirectory':
            result = await window.filesAPI.selectDirectory();
            break;
          case 'readDirectory':
            result = await window.filesAPI.readDirectory(args.path);
            break;
          case 'executeCommand':
            result = await window.containerAPI.execLogged(
              [args.command as string, ...(args.args as string[])],
              { source: 'iframe', appDirName: dirName },
            );
            break;
          case 'connectKernel':
            await connect(args.kernelName as string);
            result = { ok: true };
            break;
          case 'executeCode': {
            const outputs: CellOutput[] = [];
            await executeCode(args.code as string, (output) => outputs.push(output));
            result = outputs;
            break;
          }
          case 'requestFix': {
            const prompt = buildFixPrompt(dirName, args.error as RequestFixError);
            composerRuntime.setText(prompt);
            composerRuntime.send();
            result = { ok: true };
            break;
          }
          case 'setComposerText': {
            composerRuntime.setText(args.text as string);
            result = { ok: true };
            break;
          }
          case 'openExternal': {
            await (window as any).electronAPI.invoke('shell:openExternal', args.url as string);
            result = { ok: true };
            break;
          }
          case 'academia:fetch': {
            result = await (window as any).academiaAPI.fetch(args.method, args.endpoint, args.data);
            break;
          }
          case 'anthropic:complete': {
            result = await (window as any).anthropicAPI.complete(args);
            break;
          }
          case 'anthropic:stream': {
            // streamKey is generated here (in the trusted renderer) rather than
            // using the iframe's request id. This ensures no iframe-controlled
            // string is used as an IPC routing key or channel name in the main
            // process. The iframe's original `id` is used only to route the
            // postMessage responses back to the correct pending promise.
            const streamKey = crypto.randomUUID();
            (window as any).anthropicAPI.stream(
              streamKey,
              args,
              (text: string) =>
                iframe.contentWindow?.postMessage({ type: 'anthropic:chunk', requestId: id, text }, '*'),
              (message: unknown) =>
                iframe.contentWindow?.postMessage({ type: 'anthropic:done', requestId: id, message }, '*'),
              (err: string) =>
                iframe.contentWindow?.postMessage({ type: 'anthropic:error', requestId: id, error: err }, '*'),
            );
            // skipResponse is set AFTER setup so that if anthropicAPI.stream()
            // throws synchronously, the outer catch can send the error back to
            // the iframe rather than leaving its promise hanging forever.
            skipResponse = true;
            break;
          }
          default:
            error = `Unknown bridge message type: ${type}`;
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      if (!skipResponse) {
        iframe.contentWindow?.postMessage(
          { type: 'response', id, result, error },
          '*',
        );
      }
    },
    [connect, executeCode, composerRuntime, dirName, preBuilt],
  );

  useEffect(() => {
    window.addEventListener('message', handleBridgeMessage);
    return () => window.removeEventListener('message', handleBridgeMessage);
  }, [handleBridgeMessage]);

  const iframeSrc = nativeToolUrl || `local-file://${encodeURI(appDir)}/src/index.html`;

  if (loadError) {
    return (
      <div style={{ padding: 24, color: '#888' }}>
        <p>Could not load application <strong>{dirName}</strong>.</p>
        <p style={{ fontSize: 13, marginTop: 8 }}>
          Expected: <code>{nativeToolUrl || `${appDir}/src/index.html`}</code>
        </p>
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      src={iframeSrc}
      className="miniAppIframe"
      sandbox="allow-scripts allow-same-origin allow-downloads"
      onLoad={handleIframeLoad}
      onError={() => {
        console.error('[MiniAppContent] Iframe error for:', dirName);
        setLoadError(true);
      }}
    />
  );
});

interface SourceFile {
  label: string;
  path: string;
}

const SourceViewer: FC<{
  appDir: string;
  dirName: string;
  rebuildState: RebuildState;
}> = ({ appDir, dirName, rebuildState }) => {
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Discover which source files exist
  useEffect(() => {
    let stale = false;
    const candidates: SourceFile[] = [
      { label: 'App.tsx', path: `${appDir}/src/App.tsx` },
      { label: 'index.html', path: `${appDir}/src/index.html` },
      { label: 'notebook.ipynb', path: `${appDir}/notebook.ipynb` },
    ];

    Promise.all(
      candidates.map((f) =>
        window.filesAPI.readFile(f.path).then(
          (res) => ('error' in res ? null : f),
          () => null,
        ),
      ),
    ).then((results) => {
      if (stale) return;
      const found = results.filter((f): f is SourceFile => f !== null);
      setFiles(found);
      setActiveIndex(0);
    });

    return () => { stale = true; };
  }, [appDir]);

  const activeFile = files[activeIndex] ?? null;
  const isNotebook = activeFile?.path.endsWith('.ipynb') ?? false;

  // Load content for active tab (skip for notebooks — they use NotebookViewer)
  useEffect(() => {
    if (files.length === 0 || isNotebook) return;
    let stale = false;
    setLoading(true);
    setContent(null);

    const file = files[activeIndex];
    if (!file) return;

    window.filesAPI.readFile(file.path).then((res) => {
      if (stale) return;
      setContent('error' in res ? 'File too large to display.' : res.type === 'text' ? res.content : '(binary file)');
      setLoading(false);
    });

    return () => { stale = true; };
  }, [files, activeIndex, isNotebook]);

  if (files.length === 0 && !loading) {
    return <div className="sourceViewerEmpty">No source files found.</div>;
  }

  return (
    <div className="sourceViewer">
      <div className="sourceViewerTabs">
        {files.map((f, i) => (
          <button
            key={f.path}
            className={`sourceViewerTab${i === activeIndex ? ' sourceViewerTab--active' : ''}`}
            onClick={() => setActiveIndex(i)}
          >
            {f.label}
          </button>
        ))}
      </div>
      {rebuildState.kind === 'error' && (
        <div className="sourceViewerRebuildError">
          <div className="sourceViewerRebuildErrorTitle">Build failed</div>
          <pre className="sourceViewerRebuildErrorMessage">{rebuildState.message}</pre>
        </div>
      )}
      {isNotebook && activeFile ? (
        <NotebookViewer
          filePath={activeFile.path}
        />
      ) : (
        <div className="sourceViewerContent">
          {loading ? (
            <p className="sourceViewerMessage">Loading...</p>
          ) : (
            <pre className="sourceViewerPre">{content}</pre>
          )}
        </div>
      )}
    </div>
  );
};
