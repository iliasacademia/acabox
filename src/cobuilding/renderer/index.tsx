import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useLocalRuntime, useRemoteThreadListRuntime, AssistantRuntimeProvider } from '@assistant-ui/react';
import { FolderIcon, MessageSquareIcon, SettingsIcon } from 'lucide-react';
import { TooltipProvider } from './components/ui/tooltip';
import { Thread } from './components/assistant-ui/thread';
import { ThreadList } from './components/assistant-ui/thread-list';
import { FilesTab } from './components/FilesTab';
import { FileViewer } from './components/FileViewer';
import { useElectronChatAdapter } from './chatAdapter';
import { sessionListAdapter } from './sessionListAdapter';
import { useThreadHistoryAdapter } from './threadHistoryAdapter';
import { attachmentAdapter } from './attachmentAdapter';
import WorkspaceOnboarding from './components/WorkspaceOnboarding';
import WorkspaceSettings from './components/WorkspaceSettings';
import type { Workspace } from '../shared/types';
import './App.css';

function ChatView({ workspace, onWorkspaceUpdated }: { workspace: Workspace; onWorkspaceUpdated: (ws: Workspace) => void }) {
  const [showSettings, setShowSettings] = useState(false);
  const [activeTab, setActiveTab] = useState<'chats' | 'files'>('chats');
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

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

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>
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
              className="activityBarBtn activityBarBtn--bottom"
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
              ) : (
                <FilesTab
                  workspacePath={workspace.directory_path}
                  onSelectFile={(p) => setSelectedFilePath(p)}
                />
              )}
            </div>
          </div>
          <div className="mainPanel">
            {selectedFilePath ? (
              <FileViewer
                filePath={selectedFilePath}
                onClose={() => setSelectedFilePath(null)}
              />
            ) : (
              <Thread />
            )}
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
