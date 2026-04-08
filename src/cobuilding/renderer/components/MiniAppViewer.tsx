import React, { useCallback, useEffect, useRef, type FC } from 'react';
import { XIcon } from 'lucide-react';

interface MiniAppViewerProps {
  dirName: string;
  workspacePath: string;
  onClose: () => void;
}

export const MiniAppViewer: FC<MiniAppViewerProps> = ({ dirName, workspacePath, onClose }) => {
  return (
    <div className="miniAppViewer">
      <MiniAppHeader dirName={dirName} onClose={onClose} />
      <div className="miniAppBody">
        <MiniAppContent dirName={dirName} workspacePath={workspacePath} />
      </div>
    </div>
  );
};

const MiniAppHeader: FC<{ dirName: string; onClose: () => void }> = ({ dirName, onClose }) => {
  return (
    <div className="miniAppHeader">
      <span className="miniAppHeaderTitle">{dirName}</span>
      <button className="miniAppHeaderClose" onClick={onClose} title="Close">
        <XIcon style={{ width: 16, height: 16 }} />
      </button>
    </div>
  );
};

const MiniAppContent: FC<{ dirName: string; workspacePath: string }> = ({ dirName, workspacePath }) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const appDir = `${workspacePath}/.applications/${dirName}`;

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
          case 'executeCode':
            error = 'Kernel execution is not yet supported';
            break;
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
    [],
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
