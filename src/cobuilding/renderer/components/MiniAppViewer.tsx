import React, { useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import { ChevronDownIcon, ChevronRightIcon, FileIcon, FolderIcon, FolderOpenIcon } from 'lucide-react';
import { useComposerRuntime } from '@assistant-ui/react';
import { CodeView, languageForPath } from './CodeView';
import { useKernel } from './notebook/useKernel';
import { NotebookViewer } from './notebook/NotebookViewer';
import type { CellOutput } from './notebook/types';
import { useSetupState } from '../setupStore';
import { track as trackAnalytics } from '../coscientistAnalytics';
import { captureError } from '../../shared/telemetry';
import { MSymbol } from './command-desk/MSymbol';
import { resolveToolIcon } from './command-desk/toolIcon';
import { setToolStatus, clearToolStatus, useToolStatus } from '../toolStatusStore';

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
  | { kind: 'error'; message: string; at: number };

interface MiniAppViewerProps {
  dirName: string;
  workspacePath: string;
  reloadNonce?: number;
  preBuilt?: boolean;
  /** Display name from the app's manifest; falls back to dirName. */
  appName?: string | null;
  /** Lucide icon name from the app's manifest. */
  appIcon?: string | null;
  /** Whether the chat side panel is currently open (header toggle state). */
  chatOpen?: boolean;
  onToggleChat?: () => void;
  onBack?: () => void;
}

export const MiniAppViewer: FC<MiniAppViewerProps> = ({ dirName, workspacePath, reloadNonce, preBuilt, appName, appIcon, chatOpen, onToggleChat, onBack }) => {
  const [viewingSource, setViewingSource] = useState(false);
  const [rebuildKey, setRebuildKey] = useState(0);
  const [rebuildState, setRebuildState] = useState<RebuildState>({ kind: 'idle' });
  const appDir = `${workspacePath}/.applications/${dirName}`;
  const composerRuntime = useComposerRuntime();

  // Surface build state to the shared tool-status store (tab dots, etc.).
  useEffect(() => {
    if (rebuildState.kind === 'building') {
      setToolStatus(dirName, { kind: 'building' });
    } else if (rebuildState.kind === 'error') {
      setToolStatus(dirName, { kind: 'buildFailed', message: rebuildState.message, at: rebuildState.at });
    } else {
      setToolStatus(dirName, { kind: 'running' });
    }
  }, [dirName, rebuildState]);
  useEffect(() => () => clearToolStatus(dirName), [dirName]);

  // Telemetry: register the open with main (which mints tool_id if missing,
  // increments open_count, and fires tool.created / tool.opened events).
  // Stash the resolved tool_id in a ref so subsequent build events can attach it.
  const toolIdRef = useRef<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.toolAnalyticsAPI
      .opened(dirName)
      .then((info) => {
        if (cancelled) return;
        if (info?.tool_id) toolIdRef.current = info.tool_id;
      })
      .catch(() => {
        // Analytics failures are non-blocking — silently ignore.
      });
    return () => {
      cancelled = true;
    };
  }, [dirName]);

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
    const buildStartMs = Date.now();
    const toolIdForBuild = toolIdRef.current;
    if (toolIdForBuild) {
      trackAnalytics({
        name: 'tool.build_started',
        metadata: { tool_id: toolIdForBuild },
      });
    }
    try {
      const result = await window.miniAppsAPI.build(dirName);
      if (!result.ok) {
        const errorMsg = (result.error || `esbuild exited with code ${result.exitCode}`).trim();
        if (toolIdForBuild) {
          trackAnalytics({
            name: 'tool.build_failed',
            metadata: {
              tool_id: toolIdForBuild,
              duration_ms: Date.now() - buildStartMs,
              error_class: 'esbuild_exit_nonzero',
              error_message: errorMsg.slice(0, 500),
            },
          });
        }
        captureError(new Error(`tool build failed: ${errorMsg}`), {
          subsystem: 'tool_build',
          extra: {
            tool_id: toolIdForBuild,
            dirName,
            error_class: 'esbuild_exit_nonzero',
            exit_code: result.exitCode,
            duration_ms: Date.now() - buildStartMs,
          },
        });
        setRebuildState({ kind: 'error', message: errorMsg, at: Date.now() });
        return;
      }
      if (toolIdForBuild) {
        trackAnalytics({
          name: 'tool.build_completed',
          metadata: {
            tool_id: toolIdForBuild,
            duration_ms: Date.now() - buildStartMs,
          },
        });
      }
      setRebuildState({ kind: 'idle' });
      setRebuildKey((k) => k + 1);
      setViewingSource(false);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorClass = err instanceof Error ? err.constructor.name : 'unknown';
      if (toolIdForBuild) {
        trackAnalytics({
          name: 'tool.build_failed',
          metadata: {
            tool_id: toolIdForBuild,
            duration_ms: Date.now() - buildStartMs,
            error_class: errorClass,
            error_message: errorMessage.slice(0, 500),
          },
        });
      }
      captureError(err, {
        subsystem: 'tool_build',
        extra: {
          tool_id: toolIdForBuild,
          dirName,
          error_class: errorClass,
          duration_ms: Date.now() - buildStartMs,
        },
      });
      setRebuildState({ kind: 'error', message: errorMessage, at: Date.now() });
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

  // "Send to chat — let it fix itself": opens the panel and posts the build
  // output as a user message in the tool's chat.
  const handleSendErrorToChat = useCallback(() => {
    if (rebuildState.kind !== 'error') return;
    if (!chatOpen) onToggleChat?.();
    composerRuntime.setText(
      `The build for \`${dirName}\` failed. Diagnose and fix it.\n\nBuild output:\n\`\`\`\n${rebuildState.message}\n\`\`\``,
    );
    composerRuntime.send();
  }, [rebuildState, chatOpen, onToggleChat, composerRuntime, dirName]);

  const showBuildError = rebuildState.kind === 'error' && !viewingSource;

  return (
    <div className="miniAppViewer">
      <MiniAppHeader
        dirName={dirName}
        appName={appName ?? dirName}
        appIcon={appIcon ?? null}
        viewingSource={viewingSource}
        onToggleSource={() => setViewingSource((v) => !v)}
        onRebuild={handleRebuild}
        onShowInFinder={handleShowInFinder}
        rebuildState={rebuildState}
        preBuilt={preBuilt}
        chatOpen={chatOpen}
        onToggleChat={onToggleChat}
        nativeToolUrl={nativeToolUrl}
        onBack={onBack}
      />
      <div className="miniAppBody">
        {showBuildError ? (
          <BuildErrorView
            message={rebuildState.kind === 'error' ? rebuildState.message : ''}
            at={rebuildState.kind === 'error' ? rebuildState.at : Date.now()}
            onRebuild={handleRebuild}
            onSendToChat={handleSendErrorToChat}
          />
        ) : preBuilt && nativeToolUrl ? (
          <MiniAppContent
            key={`prebuilt-${reloadNonce ?? 0}`}
            dirName={dirName}
            workspacePath={workspacePath}
            preBuilt
            nativeToolUrl={nativeToolUrl}
          />
        ) : preBuilt ? (
          <CenteredMonoStatus label="STARTING" />
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
  appName: string;
  appIcon: string | null;
  viewingSource: boolean;
  onToggleSource: () => void;
  onRebuild: () => void;
  onShowInFinder: () => void;
  rebuildState: RebuildState;
  preBuilt?: boolean;
  chatOpen?: boolean;
  onToggleChat?: () => void;
  nativeToolUrl: string | null;
  onBack?: () => void;
}> = ({ dirName, appName, appIcon, viewingSource, onToggleSource, onRebuild, onShowInFinder, rebuildState, preBuilt, chatOpen, onToggleChat, nativeToolUrl, onBack }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const handleExport = useCallback(async () => {
    setMenuOpen(false);
    await window.miniAppsAPI.exportApp(dirName);
  }, [dirName]);

  const status = useToolStatus(dirName);
  const isBuilding = rebuildState.kind === 'building';
  const failed = rebuildState.kind === 'error';
  const installing = status.kind === 'installing';
  const ToolIcon = resolveToolIcon(appIcon);

  return (
    <div className="cdToolHeader">
      {onBack && (
        <button type="button" className="cdIconBtn" title="Back to Tools" onClick={onBack}>
          <MSymbol name="arrow_back" size={18} />
        </button>
      )}
      {failed ? (
        <MSymbol name="error" size={18} className="cdToolHeader__icon cdToolHeader__icon--error" />
      ) : (
        <ToolIcon className="cdToolHeader__icon" style={{ width: 18, height: 18 }} />
      )}
      <span className="cdToolHeader__name">{appName}</span>
      {failed ? (
        <span className="cdStatusChip cdStatusChip--error">
          <span className="cdDot cdDot--error" />
          BUILD FAILED
        </span>
      ) : isBuilding ? (
        <span className="cdStatusChip">
          <span className="cdDot cdDot--busy cdDot--pulse" />
          BUILDING
        </span>
      ) : installing ? (
        <span className="cdStatusChip">
          <span className="cdDot cdDot--busy cdDot--pulse" />
          FIRST BOOT
        </span>
      ) : (
        <span className="cdStatusChip">
          <span className="cdDot cdDot--running" />
          RUNNING
        </span>
      )}
      <span className="cdToolHeader__spacer" />
      {!preBuilt && (
        <button
          type="button"
          className="cdBtnXs cdBtnXs--sm"
          onClick={onRebuild}
          disabled={isBuilding || installing}
        >
          <MSymbol name="refresh" size={15} />
          Rebuild
        </button>
      )}
      {onToggleChat && (
        <button
          type="button"
          className={`cdIconBtn cdIconBtn--30${chatOpen ? ' cdIconBtn--active' : ''}`}
          title="Chat panel"
          onClick={onToggleChat}
        >
          <MSymbol name="forum" size={18} />
        </button>
      )}
      {preBuilt && nativeToolUrl && (
        <button
          type="button"
          className="cdIconBtn cdIconBtn--30"
          title="Open in browser"
          onClick={() => (window as any).electronAPI.invoke('shell:openExternal', nativeToolUrl)}
        >
          <MSymbol name="open_in_new" size={18} />
        </button>
      )}
      {!preBuilt && (
        <div className="cdMenuWrap" ref={menuRef}>
          <button
            type="button"
            className={`cdIconBtn cdIconBtn--30${menuOpen ? ' cdIconBtn--active' : ''}`}
            title="More"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <MSymbol name="more_horiz" size={18} />
          </button>
          {menuOpen && (
            <div className="cdMenu">
              <button
                type="button"
                className="cdMenu__item"
                onClick={() => { setMenuOpen(false); onToggleSource(); }}
              >
                <MSymbol name="code" size={16} />
                {viewingSource ? 'View tool' : 'View source'}
              </button>
              <button
                type="button"
                className="cdMenu__item"
                onClick={() => { setMenuOpen(false); onShowInFinder(); }}
              >
                <MSymbol name="folder_open" size={16} />
                Reveal in Finder
              </button>
              <button type="button" className="cdMenu__item" onClick={handleExport}>
                <MSymbol name="download" size={16} />
                Download
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/** Centered mono placeholder line (pre-boot / waiting states). */
const CenteredMonoStatus: FC<{ label: string; pulse?: boolean }> = ({ label, pulse = true }) => (
  <div className="cdInstallWrap">
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span className={`cdDot cdDot--busy${pulse ? ' cdDot--pulse' : ''}`} />
      <span className="cdWorking__label">{label}</span>
    </div>
  </div>
);

/** Build error state — replaces the iframe content (Phase B spec). */
const BuildErrorView: FC<{
  message: string;
  at: number;
  onRebuild: () => void;
  onSendToChat: () => void;
}> = ({ message, at, onRebuild, onSendToChat }) => {
  const time = new Date(at);
  const hh = String(time.getHours()).padStart(2, '0');
  const mm = String(time.getMinutes()).padStart(2, '0');
  return (
    <div className="cdBuildErr">
      <div className="cdBuildErr__col">
        <span className="cdBuildErr__eyebrow">BUILD FAILED · {hh}:{mm}</span>
        <span className="cdBuildErr__title">Build failed.</span>
        <span className="cdBuildErr__sub">The rebundle didn't come up. Full output:</span>
        <pre className="cdBuildErr__out">{message}</pre>
        <div className="cdBuildErr__actions">
          <button type="button" className="cdBtnPrimary cdBtnPrimary--36" onClick={onRebuild}>
            <MSymbol name="refresh" size={16} />
            Rebuild
          </button>
          <button type="button" className="cdBtnXs cdBtnXs--sm" onClick={onSendToChat}>
            <MSymbol name="forum" size={15} />
            Send to chat — let it fix itself
          </button>
          <button
            type="button"
            className="cdTextLink"
            onClick={() => navigator.clipboard.writeText(message)}
          >
            Copy output
          </button>
        </div>
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

/** "pandas==2.2.3" / "left-pad@1.3.0" → name + version for the install rows. */
function splitPackageSpec(pkg: AppPackage): { name: string; version: string } {
  switch (pkg.registry) {
    case 'npm': {
      const at = pkg.package.lastIndexOf('@');
      if (at > 0) return { name: pkg.package.slice(0, at), version: pkg.package.slice(at + 1) };
      return { name: pkg.package, version: '' };
    }
    case 'manual':
      return { name: pkg.package.split('/').pop() ?? pkg.package, version: '' };
    default: {
      const m = pkg.package.match(/^([^=<>~!\s]+)\s*(?:(?:==|>=|<=|~=|!=)\s*(.+))?$/);
      return { name: m?.[1] ?? pkg.package, version: m?.[2] ?? '' };
    }
  }
}

const InstallPackageRow: FC<{ pkg: AppPackage }> = ({ pkg }) => {
  const { name, version } = splitPackageSpec(pkg);
  const state = pkg.state;
  const rowClass =
    state === 'failed' ? ' cdInstall__row--failed'
      : state === 'queued' || state === 'unknown' ? ' cdInstall__row--queued'
      : '';
  return (
    <div className={`cdInstall__row${rowClass}`}>
      <span className="cdInstall__pkg">{name}</span>
      {version && <span className="cdInstall__ver">{version}</span>}
      <span className="cdInstall__rowSpacer" />
      {state === 'installed' && (
        <>
          <span className="cdDot cdDot--running" />
          <span className="cdInstall__state">DONE</span>
        </>
      )}
      {state === 'installing' && (
        <>
          <span className="cdDot cdDot--busy cdDot--pulse" />
          <span className="cdInstall__state">INSTALLING…</span>
        </>
      )}
      {(state === 'queued' || state === 'unknown') && (
        <>
          <span className="cdDot cdDot--sleeping" />
          <span className="cdInstall__state cdInstall__state--queued">QUEUED</span>
        </>
      )}
      {state === 'failed' && (
        <>
          <span className="cdDot cdDot--error" />
          <span className="cdInstall__state cdInstall__state--failed">FAILED</span>
        </>
      )}
    </div>
  );
};

/** First-boot dependency interstitial — replaces the iframe (Phase B spec). */
const PackageChecklistView: FC<{ packages: AppPackage[] }> = ({ packages }) => {
  const total = packages.length;
  const done = packages.filter((p) => p.state === 'installed').length;
  const liveLine = packages.find((p) => p.state === 'installing')?.line ?? '';
  return (
    <div className="cdInstallWrap">
      <div className="cdInstall">
        <div className="cdInstall__header">
          <span className="cdInstall__title">FIRST BOOT — INSTALLING {total} PACKAGE{total === 1 ? '' : 'S'}</span>
          <span className="cdInstall__count">{done}/{total}</span>
        </div>
        {packages.map((p) => (
          <InstallPackageRow key={`${p.registry}:${p.package}`} pkg={p} />
        ))}
        <div className="cdInstall__footer">
          <div className="cdProgress">
            <div className="cdProgress__fill" style={{ width: `${total > 0 ? Math.round((done / total) * 100) : 0}%` }} />
          </div>
          <span className="cdInstall__footerCount">{done}/{total}</span>
        </div>
      </div>
      {liveLine && <span className="cdInstall__log">▸ {liveLine}</span>}
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
        // Only react to 'ready' — 'setup-done' fires before container.start(),
        // so the container isn't running yet.
        if (progress.stage === 'ready') {
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

    const attemptEnsureDeps = () => {
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
            if (!cancelled) setTimeout(attemptEnsureDeps, 3000);
          });
      });
    };
    attemptEnsureDeps();

    return () => { cancelled = true; };
  }, [containerReady, dirName]);

  // Surface first-boot progress to the shared status store (tab dots, header).
  useEffect(() => {
    if (depsReady === false) {
      const done = packages?.filter((p) => p.state === 'installed').length ?? 0;
      const total = packages?.length ?? 0;
      setToolStatus(dirName, { kind: 'installing', done, total });
    } else if (depsReady === true) {
      setToolStatus(dirName, { kind: 'running' });
    }
  }, [depsReady, packages, dirName]);

  if (containerReady === null) return null;
  if (!containerReady) return <CenteredMonoStatus label={statusMessage} />;
  if (depsReady === null) return null;
  if (!depsReady) {
    if (packages === null) return null;  // still fetching the install plan
    if (packages.length === 0) return <CenteredMonoStatus label="FIRST BOOT — INSTALLING" />;
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
  const iframeRouteKey = React.useMemo(() => `${dirName}::${Math.random().toString(36).slice(2)}`, [dirName]);
  const registeredServerRef = useRef<string | null>(null);

  // Register MCP server from manifest.json on mount; tear down on unmount.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const manifest = await window.filesAPI.readFile(`${appDir}/manifest.json`);
        if (cancelled || !manifest || 'error' in manifest || manifest.type !== 'text') return;
        let parsed: any;
        try { parsed = JSON.parse(manifest.content); } catch { return; }
        const mcp = parsed?.mcp;
        if (!mcp || typeof mcp.server_name !== 'string' || !Array.isArray(mcp.tools)) return;
        const tools = mcp.tools.filter((t: any) =>
          t && typeof t.name === 'string' && typeof t.description === 'string' && t.input_schema && typeof t.input_schema === 'object',
        );
        if (tools.length === 0) return;
        await window.miniAppMcpAPI.register({
          serverName: mcp.server_name,
          dirName,
          tools,
          iframeRouteKey,
        });
        registeredServerRef.current = mcp.server_name;
      } catch (err) {
        console.warn('[MiniAppContent] Failed to register MCP server:', err);
      }
    })();
    return () => {
      cancelled = true;
      window.miniAppMcpAPI.unregisterByRoute(iframeRouteKey);
      registeredServerRef.current = null;
    };
  }, [appDir, dirName, iframeRouteKey]);

  // Route agent / other-mini-app invocations to this iframe and relay results.
  React.useEffect(() => {
    const unsubscribe = window.miniAppMcpAPI.onInvoke((payload) => {
      if (payload.iframeRouteKey !== iframeRouteKey) return;
      const iframe = iframeRef.current;
      if (!iframe || !iframe.contentWindow) {
        window.miniAppMcpAPI.sendResult({ invocationId: payload.invocationId, error: 'iframe is not mounted' });
        return;
      }
      iframe.contentWindow.postMessage(
        { type: 'mcp:invoke', invocationId: payload.invocationId, toolName: payload.toolName, args: payload.args },
        '*',
      );
    });
    return unsubscribe;
  }, [iframeRouteKey]);

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

      // Mini-app MCP responses follow a separate protocol: the iframe is
      // returning a result for an invocation main initiated, so the id field
      // is `invocationId` instead of `id` and there's no response postback.
      if (event.data?.type === 'mcp:result' && typeof event.data?.invocationId === 'string') {
        window.miniAppMcpAPI.sendResult({
          invocationId: event.data.invocationId,
          result: event.data.result,
          error: event.data.error,
        });
        return;
      }

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
          case 'mcp:listServers':
            result = await window.miniAppMcpAPI.list();
            break;
          case 'mcp:callTool': {
            const { serverName, toolName, args: callArgs } = args as { serverName: string; toolName: string; args: unknown };
            result = await window.miniAppMcpAPI.callTool(serverName, toolName, callArgs);
            break;
          }
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
