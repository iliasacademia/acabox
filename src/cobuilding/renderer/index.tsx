import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  useLocalRuntime,
  useRemoteThreadListRuntime,
  AssistantRuntimeProvider,
  useThreadList,
} from '@assistant-ui/react';
import { FolderIcon, MessageSquareIcon, BracesIcon, SettingsIcon } from 'lucide-react';
import { TooltipProvider } from './components/ui/tooltip';
import { Thread } from './components/assistant-ui/thread';
import { ThreadList } from './components/assistant-ui/thread-list';
import { FilesTab } from './components/FilesTab';
import { DebugSidebar, DebugContent, type DebugSection } from './components/DebugPanel';
import { FileViewer } from './components/FileViewer';
import { useElectronChatAdapter } from './chatAdapter';
import { sessionListAdapter } from './sessionListAdapter';
import { useThreadHistoryAdapter } from './threadHistoryAdapter';
import { attachmentAdapter } from './attachmentAdapter';
import WorkspaceOnboarding from './components/WorkspaceOnboarding';
import WorkspaceSettings from './components/WorkspaceSettings';
import { SetupBanner } from './components/SetupBanner';
import type { Workspace } from '../shared/types';
import './App.css';

/** When the user picks a thread (or new thread), close the file viewer so the chat shows. */
function CloseFileOnThreadSelect({ onCloseFile }: { onCloseFile: () => void }) {
  const mainThreadId = useThreadList((s) => s.mainThreadId);
  const prevRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (mainThreadId == null) return;
    const prev = prevRef.current;
    if (prev !== undefined && prev !== mainThreadId) {
      onCloseFile();
    }
    prevRef.current = mainThreadId;
  }, [mainThreadId, onCloseFile]);

  return null;
}


function ChatView({ workspace, onWorkspaceUpdated }: { workspace: Workspace; onWorkspaceUpdated: (ws: Workspace) => void }) {
  const [showSettings, setShowSettings] = useState(false);
  const [activeTab, setActiveTab] = useState<'chats' | 'files' | 'debug'>('chats');
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [debugSection, setDebugSection] = useState<DebugSection>('podman');

  const runtime = useRemoteThreadListRuntime({
    runtimeHook: () => {
      const chatAdapter = useElectronChatAdapter();
      const history = useThreadHistoryAdapter();
      return useLocalRuntime(chatAdapter, {
        adapters: { history, attachments: attachmentAdapter },
      });
    },
    adapter: sessionListAdapter,
  });

  const clearSelectedFile = useCallback(() => setSelectedFilePath(null), []);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <CloseFileOnThreadSelect onCloseFile={clearSelectedFile} />
      <TooltipProvider>
        <div className="appRoot">
          <SetupBanner />
          <div className="appLayout">
          <div className="activityBar">
            <button
              className={`activityBarBtn ${activeTab === 'files' ? 'activityBarBtn--active' : ''}`}
              onClick={() => setActiveTab('files')}
              title="Files"
            >
              <FolderIcon style={{ width: 22, height: 22 }} />
            </button>
            <button
              className={`activityBarBtn ${activeTab === 'chats' ? 'activityBarBtn--active' : ''}`}
              onClick={() => setActiveTab('chats')}
              title="Chats"
            >
              <MessageSquareIcon style={{ width: 22, height: 22 }} />
            </button>
            <button
              className={`activityBarBtn activityBarBtn--bottom ${activeTab === 'debug' ? 'activityBarBtn--active' : ''}`}
              onClick={() => setActiveTab('debug')}
              title="Debug"
            >
              <BracesIcon style={{ width: 22, height: 22 }} />
            </button>
            <button
              className="activityBarBtn"
              onClick={() => setShowSettings(true)}
              title="Settings"
            >
              <SettingsIcon style={{ width: 22, height: 22 }} />
            </button>
          </div>
          <div className="sidebarPanel">
            <div className="sidebarContent">
              {activeTab === 'chats' ? (
                <ThreadList />
              ) : activeTab === 'files' ? (
                <FilesTab
                  workspacePath={workspace.directory_path}
                  onSelectFile={(p) => setSelectedFilePath(p)}
                />
              ) : activeTab === 'debug' ? (
                <DebugSidebar activeSection={debugSection} onSelect={setDebugSection} />
              ) : null}
            </div>
          </div>
          <div className="mainPanel">
            {activeTab === 'debug' ? (
              <DebugContent activeSection={debugSection} />
            ) : selectedFilePath ? (
              <FileViewer
                filePath={selectedFilePath}
                onClose={() => setSelectedFilePath(null)}
              />
            ) : (
              <Thread />
            )}
          </div>
        </div>
        </div>
        {showSettings && (
          <WorkspaceSettings
            workspace={workspace}
            onClose={() => setShowSettings(false)}
            onSaved={(ws) => {
              onWorkspaceUpdated(ws);
              setShowSettings(false);
            }}
          />
        )}
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}

function App() {
  const [workspace, setWorkspace] = useState<Workspace | null | undefined>(undefined);

  useEffect(() => {
    window.workspacesAPI.getActive().then((ws) => setWorkspace(ws ?? null));
  }, []);

  if (workspace === undefined) return null;

  if (workspace === null) {
    return (
      <WorkspaceOnboarding
        onComplete={() => {
          window.workspacesAPI.getActive().then((ws) => setWorkspace(ws ?? null));
        }}
      />
    );
  }

  return <ChatView workspace={workspace} onWorkspaceUpdated={setWorkspace} />;
}

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
