import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  useLocalRuntime,
  useRemoteThreadListRuntime,
  AssistantRuntimeProvider,
  useThreadList,
  useAssistantToolUI,
  useAssistantRuntime,
  useComposerRuntime,
} from '@assistant-ui/react';
import { FolderIcon, MessageSquareIcon, BracesIcon, SettingsIcon, LayoutGridIcon, ClockIcon, SparklesIcon } from 'lucide-react';
import { TooltipProvider } from './components/ui/tooltip';
import { Thread } from './components/assistant-ui/thread';
import { ThreadList } from './components/assistant-ui/thread-list';
import { FilesTab } from './components/FilesTab';
import { DebugSidebar, DebugContent, type DebugSection } from './components/DebugPanel';
import { FileViewer } from './components/FileViewer';
import { NotebookViewer } from './components/notebook';
import { MiniAppViewer } from './components/MiniAppViewer';
import { MiniAppsTab } from './components/MiniAppsTab';
import { ScheduledTasksSidebar } from './components/ScheduledTasksSidebar';
import { ReactionsSidebar } from './components/ReactionsSidebar';

import { ScheduledTaskEditor } from './components/ScheduledTaskEditor';
import './components/ScheduledTasks.css';
import { useElectronChatAdapter } from './chatAdapter';
import { sessionListAdapter } from './sessionListAdapter';
import { useThreadHistoryAdapter } from './threadHistoryAdapter';
import { attachmentAdapter } from './attachmentAdapter';
import { useSessionSubscription } from './useSessionSubscription';
import WorkspaceOnboarding from './components/WorkspaceOnboarding';
import WorkspaceSettings from './components/WorkspaceSettings';
import AcademiaLogin from './components/AcademiaLogin';
import { SetupBanner } from './components/SetupBanner';
import { TabBar } from './tabs/TabBar';
import { useTabs } from './tabs/useTabs';
import type { TabDescriptor } from './tabs/types';
import type { Workspace } from '../shared/types';
import './App.css';

/** Listens for quick-chat:inject IPC and creates a new thread with the message + context. */
function QuickChatInjector({ onSwitchToChat }: { onSwitchToChat: () => void }) {
  const assistantRuntime = useAssistantRuntime();
  const composerRuntime = useComposerRuntime();

  useEffect(() => {
    const cleanup = window.chatAPI.onQuickChatInject((data: { text: string; context: any }) => {
      onSwitchToChat();

      // Format message with context
      let message = '';
      const ctx = data.context;
      if (ctx) {
        const contextParts: string[] = [];
        if (ctx.frontmostApp) contextParts.push(`App: ${ctx.frontmostApp}`);
        if (ctx.documentUrl) contextParts.push(`URL: ${ctx.documentUrl}`);
        if (ctx.selectedText) contextParts.push(`Selected text:\n${ctx.selectedText}`);
        if (ctx.focusedElementValue && ctx.focusedElementValue !== ctx.selectedText) {
          contextParts.push(`Focused element value:\n${ctx.focusedElementValue}`);
        }
        if (ctx.focusedElementDescription) contextParts.push(`Focused element: ${ctx.focusedElementDescription}`);
        if (contextParts.length > 0) {
          message = `[Context]\n${contextParts.join('\n')}\n\n[User Request]\n${data.text}`;
        } else {
          message = data.text;
        }
      } else {
        message = data.text;
      }

      assistantRuntime.switchToNewThread();
      setTimeout(() => {
        composerRuntime.setText(message);
        composerRuntime.send();
      }, 100);
    });

    return cleanup;
  }, [assistantRuntime, composerRuntime, onSwitchToChat]);

  return null;
}

/** Listens for notification:navigate IPC and navigates to the specified target. */
type SidebarTab = 'chats' | 'files' | 'apps' | 'scheduled' | 'reactions' | 'debug';

function NotificationNavigator({
  setSidebarTab,
  deactivateAllTabs,
}: {
  setSidebarTab: (tab: SidebarTab) => void;
  deactivateAllTabs: () => void;
}) {
  const runtime = useAssistantRuntime();

  useEffect(() => {
    const handler = (_event: unknown, navigation: { type: string; threadId?: string; tab?: SidebarTab; sidebarTab?: SidebarTab }) => {
      if (navigation.type === 'thread' && navigation.threadId) {
        setSidebarTab(navigation.sidebarTab ?? 'chats');
        deactivateAllTabs();
        runtime.threads.switchToThread(navigation.threadId);
      } else if (navigation.type === 'sidebar' && navigation.tab) {
        setSidebarTab(navigation.tab);
      }
    };
    window.electronAPI.on('notification:navigate', handler);
    return () => window.electronAPI.removeListener('notification:navigate', handler);
  }, [runtime, setSidebarTab, deactivateAllTabs]);

  return null;
}

/** Subscribes to running agent sessions when a thread is opened. */
function SessionSubscriber() {
  useSessionSubscription();
  return null;
}

/** When the user picks a different thread, deactivate tabs so chat is shown. */
function ShowChatOnThreadSelect({ onShowChat }: { onShowChat: () => void }) {
  const mainThreadId = useThreadList((s) => s.mainThreadId);
  const prevRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (mainThreadId == null) return;
    const prev = prevRef.current;
    if (prev !== undefined && prev !== mainThreadId) {
      console.debug('[ShowChatOnThreadSelect] Thread changed:', prev, '->', mainThreadId, '— deactivating tabs');
      onShowChat();
    }
    prevRef.current = mainThreadId;
  }, [mainThreadId, onShowChat]);

  return null;
}

function OpenMiniAppToolUI({
  args,
  status,
  onOpen,
}: {
  args: { dir_name?: string };
  status: { type: string };
  onOpen: (dirName: string) => void;
}) {
  const openedRef = useRef<string | null>(null);

  useEffect(() => {
    const dirName = args?.dir_name;
    // Only open for tool calls that are actively running — not completed history
    if (dirName && status.type === 'running' && dirName !== openedRef.current) {
      openedRef.current = dirName;
      console.debug('[OpenMiniAppToolUI] Opening mini app (running tool call):', dirName);
      onOpen(dirName);
    } else if (dirName && status.type !== 'running') {
      console.debug('[OpenMiniAppToolUI] Skipping open for completed tool call:', dirName, 'status:', status.type);
    }
  }, [args?.dir_name, status.type, onOpen]);

  return null;
}

function OpenMiniAppHandler({ onOpen }: { onOpen: (dirName: string) => void }) {
  useAssistantToolUI({
    toolName: 'mcp__mini-apps__open_mini_application',
    render: (props: { args: { dir_name?: string }; status: { type: string } }) => (
      <OpenMiniAppToolUI args={props.args} status={props.status} onOpen={onOpen} />
    ),
  });

  return null;
}


function ChatView({ workspace, onWorkspaceUpdated }: { workspace: Workspace; onWorkspaceUpdated: (ws: Workspace) => void }) {
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('chats');
  const [debugSection, setDebugSection] = useState<DebugSection>('apps');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [isNewTask, setIsNewTask] = useState(false);
  const [taskRefreshKey, setTaskRefreshKey] = useState(0);

  const { tabs, activeTabId, openTab, closeTab, activateTab, pinTab, deactivateAllTabs } = useTabs();
  const [dirtyTabIds, setDirtyTabIds] = useState<Set<string>>(new Set());

  const handleDirtyChange = useCallback((tabId: string, dirty: boolean) => {
    setDirtyTabIds((prev) => {
      if (dirty && prev.has(tabId)) return prev;
      if (!dirty && !prev.has(tabId)) return prev;
      const next = new Set(prev);
      if (dirty) {
        next.add(tabId);
      } else {
        next.delete(tabId);
      }
      return next;
    });
  }, []);

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

  const handleSelectFile = useCallback((filePath: string) => {
    const isNotebook = filePath.endsWith('.ipynb');
    const kind = isNotebook ? 'notebook' as const : 'file' as const;
    const label = filePath.split('/').pop() ?? filePath;
    const id = `${kind}::${filePath}`;
    const descriptor: TabDescriptor = {
      id,
      kind,
      label,
      pinned: isNotebook, // notebooks are always pinned, regular files are preview
      data: isNotebook ? { kind: 'notebook', filePath } : { kind: 'file', filePath },
    };
    openTab(descriptor);
  }, [openTab]);

  const handleSelectApp = useCallback((dirName: string) => {
    console.debug('[handleSelectApp] Opening mini app tab:', dirName);
    const descriptor: TabDescriptor = {
      id: `miniapp::${dirName}`,
      kind: 'miniapp',
      label: dirName,
      pinned: true, // mini apps are always pinned
      data: { kind: 'miniapp', dirName },
    };
    openTab(descriptor);
  }, [openTab]);

  const handleOpenDebug = useCallback(() => {
    const descriptor: TabDescriptor = {
      id: 'debug',
      kind: 'debug',
      label: 'Debug',
      pinned: true,
      data: { kind: 'debug' },
    };
    openTab(descriptor);
  }, [openTab]);

  // Determine if the active tab is a miniapp (for showing chat side panel)
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const showChatSidePanel = activeTab?.kind === 'miniapp';

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SessionSubscriber />
      <ShowChatOnThreadSelect onShowChat={deactivateAllTabs} />
      <OpenMiniAppHandler onOpen={handleSelectApp} />
      <QuickChatInjector onSwitchToChat={() => { setSidebarTab('chats'); deactivateAllTabs(); }} />
      <NotificationNavigator setSidebarTab={setSidebarTab} deactivateAllTabs={deactivateAllTabs} />
      <TooltipProvider>
        <div className="appRoot">
          <SetupBanner />
          <div className="appLayout">
          <div className="activityBar">
            <button
              className={`activityBarBtn ${sidebarTab === 'files' ? 'activityBarBtn--active' : ''}`}
              onClick={() => setSidebarTab('files')}
              title="Files"
            >
              <FolderIcon style={{ width: 22, height: 22 }} />
            </button>
            <button
              className={`activityBarBtn ${sidebarTab === 'chats' ? 'activityBarBtn--active' : ''}`}
              onClick={() => setSidebarTab('chats')}
              title="Chats"
            >
              <MessageSquareIcon style={{ width: 22, height: 22 }} />
            </button>
            <button
              className={`activityBarBtn ${sidebarTab === 'apps' ? 'activityBarBtn--active' : ''}`}
              onClick={() => setSidebarTab('apps')}
              title="Applications"
            >
              <LayoutGridIcon style={{ width: 22, height: 22 }} />
            </button>
            <button
              className={`activityBarBtn ${sidebarTab === 'scheduled' ? 'activityBarBtn--active' : ''}`}
              onClick={() => setSidebarTab('scheduled')}
              title="Scheduled Tasks"
            >
              <ClockIcon style={{ width: 22, height: 22 }} />
            </button>
            <button
              className={`activityBarBtn ${sidebarTab === 'reactions' ? 'activityBarBtn--active' : ''}`}
              onClick={() => setSidebarTab('reactions')}
              title="Reactions"
            >
              <SparklesIcon style={{ width: 22, height: 22 }} />
            </button>
            <button
              className={`activityBarBtn activityBarBtn--bottom ${sidebarTab === 'debug' ? 'activityBarBtn--active' : ''}`}
              onClick={() => { setSidebarTab('debug'); handleOpenDebug(); }}
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
              {sidebarTab === 'chats' ? (
                <ThreadList />
              ) : sidebarTab === 'files' ? (
                <FilesTab
                  workspacePath={workspace.directory_path}
                  onSelectFile={handleSelectFile}
                />
              ) : sidebarTab === 'apps' ? (
                <MiniAppsTab
                  workspacePath={workspace.directory_path}
                  onSelectApp={handleSelectApp}
                  onNewApplication={() => { setSidebarTab('chats'); }}
                />
              ) : sidebarTab === 'reactions' ? (
                <ReactionsSidebar />
              ) : sidebarTab === 'scheduled' ? (
                <ScheduledTasksSidebar
                  selectedTaskId={selectedTaskId}
                  onSelectTask={(id) => { setSelectedTaskId(id); setIsNewTask(false); }}
                  onNewTask={() => { setSelectedTaskId(null); setIsNewTask(true); }}
                  refreshKey={taskRefreshKey}
                />
              ) : sidebarTab === 'debug' ? (
                <DebugSidebar activeSection={debugSection} onSelect={setDebugSection} />
              ) : null}
            </div>
          </div>
          <div className="mainPanel">
            {sidebarTab === 'scheduled' ? (
              (selectedTaskId || isNewTask) ? (
                <ScheduledTaskEditor
                  taskId={selectedTaskId}
                  onSaved={(savedId) => { setSelectedTaskId(savedId); setIsNewTask(false); setTaskRefreshKey((k) => k + 1); }}
                  onDeleted={() => { setSelectedTaskId(null); setIsNewTask(false); setTaskRefreshKey((k) => k + 1); }}
                />
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#999', fontSize: '0.875rem' }}>
                  Select a task or create a new one
                </div>
              )
            ) : (
              <>
                <TabBar
                  tabs={tabs}
                  activeTabId={activeTabId}
                  dirtyTabIds={dirtyTabIds}
                  onActivate={activateTab}
                  onClose={closeTab}
                  onPin={pinTab}
                  onShowChat={deactivateAllTabs}
                />
                <div className="tabPanelsContainer">
                  {/* Chat is the default view when no tab is active */}
                  <div className="tabPanel" style={{ display: activeTabId === null ? 'flex' : 'none' }}>
                    <Thread />
                  </div>
                  {/* Render all tab panels - hidden ones use display:none to preserve state */}
                  {tabs.map((tab) => (
                    <div
                      key={tab.id}
                      className="tabPanel"
                      style={{ display: tab.id === activeTabId ? 'flex' : 'none' }}
                    >
                      {tab.data.kind === 'file' && (
                        <FileViewer filePath={tab.data.filePath} />
                      )}
                      {tab.data.kind === 'notebook' && (
                        <NotebookViewer
                          filePath={tab.data.filePath}
                          onDirtyChange={(dirty) => handleDirtyChange(tab.id, dirty)}
                        />
                      )}
                      {tab.data.kind === 'miniapp' && (
                        <MiniAppViewer
                          dirName={tab.data.dirName}
                          workspacePath={workspace.directory_path}
                        />
                      )}
                      {tab.data.kind === 'debug' && (
                        <DebugContent activeSection={debugSection} />
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          {showChatSidePanel && (
            <div className="chatSidePanel">
              <Thread />
            </div>
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
  const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null | undefined>(undefined);

  useEffect(() => {
    window.authAPI.checkLogin().then(({ loggedIn }) => {
      setIsLoggedIn(loggedIn);
      if (loggedIn) {
        window.workspacesAPI.getActive().then((ws) => setWorkspace(ws ?? null));
      }
    });
  }, []);

  // Loading
  if (isLoggedIn === null) return null;

  if (!isLoggedIn) {
    return (
      <AcademiaLogin
        onSuccess={() => {
          setIsLoggedIn(true);
          window.workspacesAPI.getActive().then((ws) => setWorkspace(ws ?? null));
        }}
      />
    );
  }

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
