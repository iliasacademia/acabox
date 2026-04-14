import React, { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { CodeIcon, FolderIcon, RefreshCwIcon } from 'lucide-react';
import { useComposerRuntime } from '@assistant-ui/react';
import { useKernel } from './notebook/useKernel';
import { NotebookViewer } from './notebook/NotebookViewer';
import type { CellOutput } from './notebook/types';

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

interface MiniAppViewerProps {
  dirName: string;
  workspacePath: string;
}

export const MiniAppViewer: FC<MiniAppViewerProps> = ({ dirName, workspacePath }) => {
  const [viewingSource, setViewingSource] = useState(false);
  const [rebuildKey, setRebuildKey] = useState(0);
  const appDir = `${workspacePath}/.applications/${dirName}`;

  const handleRebuildSuccess = useCallback(() => {
    setRebuildKey((k) => k + 1);
    setViewingSource(false);
  }, []);

  return (
    <div className="miniAppViewer">
      <MiniAppHeader
        viewingSource={viewingSource}
        onToggleSource={() => setViewingSource((v) => !v)}
      />
      <div className="miniAppBody">
        {viewingSource ? (
          <SourceViewer
            appDir={appDir}
            dirName={dirName}
            onRebuildSuccess={handleRebuildSuccess}
          />
        ) : (
          <MiniAppContent
            key={rebuildKey}
            dirName={dirName}
            workspacePath={workspacePath}
          />
        )}
      </div>
    </div>
  );
};

const MiniAppHeader: FC<{
  viewingSource: boolean;
  onToggleSource: () => void;
}> = ({ viewingSource, onToggleSource }) => {
  return (
    <div className="miniAppHeader">
      <button
        className={`miniAppHeaderClose${viewingSource ? ' miniAppHeaderClose--active' : ''}`}
        onClick={onToggleSource}
        title="View source"
      >
        <CodeIcon style={{ width: 16, height: 16 }} />
      </button>
    </div>
  );
};

const MiniAppContent: FC<{ dirName: string; workspacePath: string }> = ({ dirName, workspacePath }) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loadError, setLoadError] = useState(false);
  const appDir = `${workspacePath}/.applications/${dirName}`;
  const { connect, executeCode } = useKernel();
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
        if (bodyText === 'Not Found' || bodyText === 'Forbidden' || bodyText === '') {
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
  }, [workspacePath, dirName]);

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
    [connect, executeCode, composerRuntime, dirName],
  );

  useEffect(() => {
    window.addEventListener('message', handleBridgeMessage);
    return () => window.removeEventListener('message', handleBridgeMessage);
  }, [handleBridgeMessage]);

  const iframeSrc = `local-file://${encodeURI(appDir)}/src/index.html`;

  if (loadError) {
    return (
      <div style={{ padding: 24, color: '#888' }}>
        <p>Could not load application <strong>{dirName}</strong>.</p>
        <p style={{ fontSize: 13, marginTop: 8 }}>
          Expected: <code>{appDir}/src/index.html</code>
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
};

interface SourceFile {
  label: string;
  path: string;
}

type RebuildState =
  | { kind: 'idle' }
  | { kind: 'building' }
  | { kind: 'error'; message: string };

const SourceViewer: FC<{
  appDir: string;
  dirName: string;
  onRebuildSuccess: () => void;
}> = ({ appDir, dirName, onRebuildSuccess }) => {
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rebuildState, setRebuildState] = useState<RebuildState>({ kind: 'idle' });

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
      onRebuildSuccess();
    } catch (err) {
      setRebuildState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [dirName, onRebuildSuccess]);

  const handleShowInFinder = useCallback(async () => {
    await window.filesAPI.showInFinder(appDir);
  }, [appDir]);

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

  const isBuilding = rebuildState.kind === 'building';

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
        <div className="sourceViewerActions">
          <button
            className="sourceViewerAction"
            onClick={handleRebuild}
            disabled={isBuilding}
            title="Rebuild and reload the app"
          >
            <RefreshCwIcon className="sourceViewerActionIcon" />
            {isBuilding ? 'Rebuilding…' : 'Rebuild'}
          </button>
          <button
            className="sourceViewerAction"
            onClick={handleShowInFinder}
            title="Show app folder in Finder"
          >
            <FolderIcon className="sourceViewerActionIcon" />
            Show in Finder
          </button>
        </div>
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
