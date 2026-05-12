import React, { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import { ArrowLeftIcon, ChevronDownIcon, ChevronRightIcon, CodeIcon, DownloadIcon, FileIcon, FolderIcon, FolderOpenIcon, MonitorIcon, RefreshCwIcon } from 'lucide-react';
import { useComposerRuntime } from '@assistant-ui/react';
import { CodeView, languageForPath } from './CodeView';
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
      await window.containerAPI.syncOverlay().catch(() => {});
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
    window.filesAPI.fileExists(`${appDir}/dist/bundle.js`).then((exists) => {
      if (!exists) handleRebuild();
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

interface AppPackage {
  registry: PackageRegistry;
  package: string;
  state: PackageState | 'unknown';
  line: string;
}

const Spinner: FC = () => (
  <div style={{
    width: 24, height: 24, border: '3px solid #e0e0e0', borderTopColor: '#666',
    borderRadius: '50%', animation: 'spin 0.8s linear infinite',
  }} />
);

const SimpleInstallingView: FC<{ message: string }> = ({ message }) => (
  <div style={{
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    height: '100%', paddingBottom: '12vh', gap: 12, color: '#666', fontSize: 14,
  }}>
    <Spinner />
    <span>{message}</span>
    <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
  </div>
);

function displayPackageName(pkg: AppPackage): string {
  switch (pkg.registry) {
    case 'npm': return pkg.package.split('@')[0];
    case 'manual': return pkg.package.split('/').pop() ?? pkg.package;
    default: return pkg.package;
  }
}

const PackageRow: FC<{ pkg: AppPackage }> = ({ pkg }) => {
  const icon =
    pkg.state === 'installed' ? '✓'
      : pkg.state === 'installing' ? '⟳'
      : pkg.state === 'failed' ? '✗'
      : '⊘';
  const colors = {
    installed: '#1a7f37',
    installing: '#bf8700',
    failed: '#cf222e',
    queued: '#888',
    unknown: '#888',
  } as const;
  const label = pkg.state === 'installed' ? 'installed'
    : pkg.state === 'installing' ? (pkg.line || 'installing…')
    : pkg.state === 'failed' ? 'failed'
    : 'queued';
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12, marginBottom: 3 }}>
      <span style={{ color: colors[pkg.state], width: 12, textAlign: 'center' }}>{icon}</span>
      <span style={{
        color: '#666', background: '#eee', borderRadius: 3, padding: '1px 5px',
        fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3,
        flexShrink: 0,
      }}>
        {pkg.registry}
      </span>
      <code style={{ color: '#333' }}>{displayPackageName(pkg)}</code>
      <span
        style={{
          color: '#888', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap', fontFamily: pkg.state === 'installing' ? 'SF Mono, Menlo, Monaco, monospace' : undefined,
          fontSize: pkg.state === 'installing' ? 10 : 12,
        }}
        title={label}
      >
        {label}
      </span>
    </div>
  );
};

const PackageChecklistView: FC<{ packages: AppPackage[] }> = ({ packages }) => {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100%', paddingBottom: '12vh', gap: 16, color: '#666', fontSize: 14,
    }}>
      <Spinner />
      <span>Installing software...</span>
      <div style={{ width: '100%', maxWidth: 440 }}>
        {packages.map((p) => (
          <PackageRow key={`${p.registry}:${p.package}`} pkg={p} />
        ))}
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
};

const ContainerGate: FC<{ dirName: string; children: React.ReactNode }> = ({ dirName, children }) => {
  const [containerReady, setContainerReady] = useState<boolean | null>(null);
  const [depsReady, setDepsReady] = useState<boolean | null>(null);
  const setup = useSetupState();
  const statusMessage = (setup.state === 'downloading' || setup.state === 'pending')
    ? (setup.message || 'Setting up environment...')
    : 'Waiting for container...';

  // The tool's package list + each one's current state/line, used for the
  // per-package checklist while deps are installing.
  const [packages, setPackages] = useState<AppPackage[] | null>(null);

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

  // Fetch this app's install requests so we know which packages to track.
  // Subscribe to per-package state/line events filtered to those packages.
  // Seed initial state from the installer's snapshot so mid-wave opens don't
  // show stale `queued` for packages that already transitioned.
  useEffect(() => {
    if (!containerReady) return;
    let cancelled = false;

    Promise.all([
      window.containerAPI.getAppInstallRequests(dirName),
      window.containerAPI.getEnvironmentInfo(),
    ]).then(([requests, envInfo]) => {
      if (cancelled) return;
      const stateSnapshot = envInfo?.packageStates;
      const lineSnapshot = envInfo?.packageLines;
      const initial: AppPackage[] = [];
      for (const r of requests) {
        for (const p of r.packages) {
          const state = (stateSnapshot?.[r.registry]?.[p] as PackageState | undefined) ?? 'unknown';
          const line = lineSnapshot?.[r.registry]?.[p] ?? '';
          initial.push({ registry: r.registry, package: p, state, line });
        }
      }
      setPackages(initial);
    });

    return () => { cancelled = true; };
  }, [containerReady, dirName]);

  // Live updates: when a package this app cares about changes state or
  // streams a line, update the matching row. The subscriptions only need to
  // attach once per (containerReady, dirName); per-package filtering reads
  // from the latest `packages` via setState's updater.
  useEffect(() => {
    if (!containerReady) return;
    const cleanups = [
      window.containerAPI.onPackageState((e) => {
        setPackages((prev) => {
          if (!prev) return prev;
          let changed = false;
          const next = prev.map((p) => {
            if (p.registry === e.registry && p.package === e.package) {
              changed = true;
              return { ...p, state: e.state };
            }
            return p;
          });
          return changed ? next : prev;
        });
      }),
      window.containerAPI.onPackageLine((e) => {
        setPackages((prev) => {
          if (!prev) return prev;
          let changed = false;
          const next = prev.map((p) => {
            if (p.registry === e.registry && p.package === e.package) {
              changed = true;
              return { ...p, line: e.line };
            }
            return p;
          });
          return changed ? next : prev;
        });
      }),
    ];
    return () => cleanups.forEach((fn) => fn());
  }, [containerReady]);

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
      // Flip from `null` to `false` so the gate renders the install checklist
      // instead of a blank screen during the install wait.
      setDepsReady(false);
      window.containerAPI.ensureAppDeps(dirName)
        .then(() => { if (!cancelled) setDepsReady(true); })
        .catch((err) => {
          console.error(`[MiniAppViewer] Failed to install deps for ${dirName}:`, err);
          // Leave depsReady=false so the install indicator stays visible.
          // The user can retry by closing and reopening the app.
        });
    });

    return () => { cancelled = true; };
  }, [containerReady, dirName]);

  if (containerReady === null) return null;
  if (!containerReady) return <SimpleInstallingView message={statusMessage} />;
  if (depsReady === null) return null;
  if (!depsReady) {
    if (packages === null) return null;  // still fetching the install plan
    if (packages.length === 0) return <SimpleInstallingView message="Installing software..." />;
    return <PackageChecklistView packages={packages} />;
  }

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

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: TreeNode[];
}

const SOURCE_TREE_SKIP_DIRS = new Set(['node_modules', '__pycache__', '.git']);

async function loadAppTree(dirPath: string): Promise<TreeNode[]> {
  const entries = await window.filesAPI.readDirectory(dirPath);
  const nodes: TreeNode[] = [];
  for (const e of entries) {
    if (e.isDirectory) {
      if (SOURCE_TREE_SKIP_DIRS.has(e.name)) continue;
      const children = await loadAppTree(e.path).catch(() => []);
      nodes.push({ name: e.name, path: e.path, isDirectory: true, children });
    } else {
      nodes.push({ name: e.name, path: e.path, isDirectory: false });
    }
  }
  return nodes;
}

function collectAllDirPaths(nodes: TreeNode[], out: Set<string> = new Set()): Set<string> {
  for (const n of nodes) {
    if (n.isDirectory) {
      out.add(n.path);
      if (n.children) collectAllDirPaths(n.children, out);
    }
  }
  return out;
}

const SourceViewer: FC<{
  appDir: string;
  dirName: string;
  rebuildState: RebuildState;
}> = ({ appDir, rebuildState }) => {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [treeLoaded, setTreeLoaded] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activePath, setActivePath] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Load the full app directory tree once
  useEffect(() => {
    let stale = false;
    setTreeLoaded(false);
    loadAppTree(appDir).then((nodes) => {
      if (stale) return;
      setTree(nodes);
      setExpanded(collectAllDirPaths(nodes));
      setTreeLoaded(true);
      setActivePath((current) => current ?? `${appDir}/src/App.tsx`);
    }).catch(() => {
      if (stale) return;
      setTree([]);
      setTreeLoaded(true);
    });
    return () => { stale = true; };
  }, [appDir]);

  const isNotebook = activePath?.endsWith('.ipynb') ?? false;

  // Load content for the active file (skip for notebooks — NotebookViewer handles them)
  useEffect(() => {
    if (!activePath || isNotebook) {
      setContent(null);
      return;
    }
    let stale = false;
    setLoading(true);
    setContent(null);

    window.filesAPI.readFile(activePath).then((res) => {
      if (stale) return;
      if ('error' in res) {
        setContent('File too large to display.');
      } else if ('content' in res) {
        setContent(res.content);
      } else {
        setContent('(binary file)');
      }
      setLoading(false);
    }).catch(() => {
      if (stale) return;
      setContent('Could not read file.');
      setLoading(false);
    });

    return () => { stale = true; };
  }, [activePath, isNotebook]);

  const toggleDir = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const activeFileName = useMemo(() => activePath?.split('/').pop() ?? null, [activePath]);
  const activeLanguage = useMemo(() => (activePath ? languageForPath(activePath) : null), [activePath]);

  return (
    <div className="sourceViewer">
      {rebuildState.kind === 'error' && (
        <div className="sourceViewerRebuildError">
          <div className="sourceViewerRebuildErrorTitle">Build failed</div>
          <pre className="sourceViewerRebuildErrorMessage">{rebuildState.message}</pre>
        </div>
      )}
      <div className="sourceViewerSplit">
        <div className="sourceViewerTree">
          {!treeLoaded ? (
            <div className="sourceViewerTreeMessage">Loading…</div>
          ) : tree.length === 0 ? (
            <div className="sourceViewerTreeMessage">Empty directory.</div>
          ) : (
            <SourceTree
              nodes={tree}
              depth={0}
              expanded={expanded}
              activePath={activePath}
              onToggle={toggleDir}
              onSelect={setActivePath}
            />
          )}
        </div>
        <div className="sourceViewerPane">
          {!activePath ? (
            <div className="sourceViewerMessage">Select a file to view its contents.</div>
          ) : isNotebook ? (
            <NotebookViewer filePath={activePath} />
          ) : (
            <>
              <div className="sourceViewerPaneHeader">{activeFileName}</div>
              <div className="sourceViewerContent">
                {loading ? (
                  <p className="sourceViewerMessage">Loading...</p>
                ) : (
                  <CodeView
                    content={content ?? ''}
                    language={activeLanguage}
                    fallbackClassName="sourceViewerPre"
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const SourceTree: FC<{
  nodes: TreeNode[];
  depth: number;
  expanded: Set<string>;
  activePath: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}> = ({ nodes, depth, expanded, activePath, onToggle, onSelect }) => (
  <>
    {nodes.map((node) => (
      <SourceTreeNode
        key={node.path}
        node={node}
        depth={depth}
        expanded={expanded}
        activePath={activePath}
        onToggle={onToggle}
        onSelect={onSelect}
      />
    ))}
  </>
);

const SourceTreeNode: FC<{
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  activePath: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}> = ({ node, depth, expanded, activePath, onToggle, onSelect }) => {
  const paddingLeft = 8 + depth * 12;
  if (node.isDirectory) {
    const isOpen = expanded.has(node.path);
    return (
      <>
        <button
          className="sourceViewerTreeRow sourceViewerTreeRow--dir"
          style={{ paddingLeft }}
          onClick={() => onToggle(node.path)}
        >
          {isOpen ? (
            <ChevronDownIcon className="sourceViewerTreeChevron" />
          ) : (
            <ChevronRightIcon className="sourceViewerTreeChevron" />
          )}
          {isOpen ? (
            <FolderOpenIcon className="sourceViewerTreeIcon" />
          ) : (
            <FolderIcon className="sourceViewerTreeIcon" />
          )}
          <span className="sourceViewerTreeLabel">{node.name}</span>
        </button>
        {isOpen && node.children && (
          <SourceTree
            nodes={node.children}
            depth={depth + 1}
            expanded={expanded}
            activePath={activePath}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        )}
      </>
    );
  }
  const isActive = activePath === node.path;
  return (
    <button
      className={`sourceViewerTreeRow${isActive ? ' sourceViewerTreeRow--active' : ''}`}
      style={{ paddingLeft }}
      onClick={() => onSelect(node.path)}
    >
      <span className="sourceViewerTreeChevron" />
      <FileIcon className="sourceViewerTreeIcon" />
      <span className="sourceViewerTreeLabel">{node.name}</span>
    </button>
  );
};
