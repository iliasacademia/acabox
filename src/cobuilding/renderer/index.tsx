import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { useLocalRuntime, useRemoteThreadListRuntime, AssistantRuntimeProvider } from '@assistant-ui/react';
import { TooltipProvider } from './components/ui/tooltip';
import { Thread } from './components/assistant-ui/thread';
import { ThreadList } from './components/assistant-ui/thread-list';
import { useElectronChatAdapter } from './chatAdapter';
import { sessionListAdapter } from './sessionListAdapter';
import { useThreadHistoryAdapter } from './threadHistoryAdapter';
import WorkspaceOnboarding from './components/WorkspaceOnboarding';
import type { Workspace } from '../shared/types';
import './App.css';

function ChatView() {
  const runtime = useRemoteThreadListRuntime({
    runtimeHook: () => {
      const chatAdapter = useElectronChatAdapter();
      const history = useThreadHistoryAdapter();
      return useLocalRuntime(chatAdapter, {
        adapters: { history },
      });
    },
    adapter: sessionListAdapter,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>
        <div className="appLayout">
          <div className="sidebarPanel">
            <ThreadList />
          </div>
          <div className="mainPanel">
            <Thread />
          </div>
        </div>
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

  return <ChatView />;
}

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
