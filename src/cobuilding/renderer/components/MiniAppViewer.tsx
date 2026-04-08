import React, { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { CodeIcon } from 'lucide-react';
import { useKernel } from './notebook/useKernel';
import { NotebookViewer } from './notebook/NotebookViewer';
import type { CellOutput } from './notebook/types';

interface MiniAppViewerProps {
  dirName: string;
  workspacePath: string;
}

export const MiniAppViewer: FC<MiniAppViewerProps> = ({ dirName, workspacePath }) => {
  const [viewingSource, setViewingSource] = useState(false);
  const appDir = `${workspacePath}/.applications/${dirName}`;

  return (
    <div className="miniAppViewer">
      <MiniAppHeader
        viewingSource={viewingSource}
        onToggleSource={() => setViewingSource((v) => !v)}
      />
      <div className="miniAppBody">
        {viewingSource ? (
          <SourceViewer appDir={appDir} />
        ) : (
          <MiniAppContent dirName={dirName} workspacePath={workspacePath} />
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
  const appDir = `${workspacePath}/.applications/${dirName}`;
  const { connect, executeCode } = useKernel();

  const handleIframeLoad = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'init', workspacePath },
      '*',
    );
  }, [workspacePath]);

  const handleBridgeMessage = useCallback(
    async (event: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe || event.source !== iframe.contentWindow) return;

      const { type, id, ...args } = event.data;
      if (!type || !id) return;

      let result: unknown;
      let error: string | undefined;

      try {
        switch (type) {
          case 'readFile':
            result = await window.filesAPI.readFile(args.path);
            break;
          case 'writeFile':
            await window.filesAPI.writeFile(args.path, args.content);
            result = { ok: true };
            break;
          case 'selectFile':
            result = await window.filesAPI.selectFile(args.filters);
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
          default:
            error = `Unknown bridge message type: ${type}`;
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      iframe.contentWindow?.postMessage(
        { type: 'response', id, result, error },
        '*',
      );
    },
    [connect, executeCode],
  );

  useEffect(() => {
    window.addEventListener('message', handleBridgeMessage);
    return () => window.removeEventListener('message', handleBridgeMessage);
  }, [handleBridgeMessage]);

  const iframeSrc = `local-file://${appDir}/src/index.html`;

  return (
    <iframe
      ref={iframeRef}
      src={iframeSrc}
      className="miniAppIframe"
      sandbox="allow-scripts allow-same-origin"
      onLoad={handleIframeLoad}
    />
  );
};

interface SourceFile {
  label: string;
  path: string;
}

const SourceViewer: FC<{ appDir: string }> = ({ appDir }) => {
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
