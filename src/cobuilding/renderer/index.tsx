import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
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
import { TooltipProvider } from './components/ui/tooltip';
import { Thread } from './components/assistant-ui/thread';
import { ThreadList } from './components/assistant-ui/thread-list';
import { FilesTab } from './components/FilesTab';
import { DebugSidebar, DebugContent, type DebugSection } from './components/DebugPanel';
import { FileViewer } from './components/FileViewer';
import { NotebookViewer } from './components/notebook';
import { MiniAppViewer } from './components/MiniAppViewer';
import { MiniAppsTab } from './components/MiniAppsTab';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useTasks } from './taskStore';
import { useElectronChatAdapter } from './chatAdapter';
import { sessionListAdapter } from './sessionListAdapter';
import { useThreadHistoryAdapter } from './threadHistoryAdapter';
import { createAttachmentAdapter } from './attachmentAdapter';
import { useSessionSubscription } from './useSessionSubscription';
import WorkspaceOnboarding from './components/WorkspaceOnboarding';
import ScanningProgress from './components/ScanningProgress';
import ScanResultsReview from './components/ScanResultsReview';
import WorkspaceSettings from './components/WorkspaceSettings';
import AcademiaLogin from './components/AcademiaLogin';
import WelcomeScreen from './components/WelcomeScreen';
import { SetupBanner } from './components/SetupBanner';
import { TaskPanel } from './components/TaskPanel';
import { GlobalComposer } from './components/GlobalComposer';
import { TabBar } from './tabs/TabBar';
import { useTabs } from './tabs/useTabs';
import type { TabDescriptor } from './tabs/types';
import { kernelRegistry } from './components/notebook/kernelRegistry';
import type { Workspace } from '../shared/types';
import { initFullStory, identifyUser, trackEvent } from './utils/fullstory';
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
type SidebarTab = 'home' | 'tools' | 'files' | 'chats' | 'debug' | 'settings';

function NotificationNavigator({
  setSidebarTab,
  setChatViewMode,
  deactivateAllTabs,
}: {
  setSidebarTab: (tab: SidebarTab) => void;
  setChatViewMode: (mode: 'list' | 'detail') => void;
  deactivateAllTabs: () => void;
}) {
  const runtime = useAssistantRuntime();

  useEffect(() => {
    const handler = (_event: unknown, navigation: { type: string; threadId?: string; tab?: SidebarTab; sidebarTab?: SidebarTab }) => {
      console.log('[NotificationNav] Renderer received notification:navigate IPC:', JSON.stringify(navigation));
      if (navigation.type === 'thread' && navigation.threadId) {
        console.log('[NotificationNav] Thread navigation — threadId:', navigation.threadId, 'sidebarTab:', navigation.sidebarTab ?? 'chats (default)');
        setSidebarTab(navigation.sidebarTab ?? 'chats');
        setChatViewMode('detail');
        deactivateAllTabs();
        try {
          console.log('[NotificationNav] Calling runtime.threads.switchToThread("' + navigation.threadId + '")');
          runtime.threads.switchToThread(navigation.threadId);
          console.log('[NotificationNav] switchToThread returned successfully');
        } catch (err) {
          console.error('[NotificationNav] switchToThread threw an error:', err);
        }
      } else if (navigation.type === 'sidebar' && navigation.tab) {
        console.log('[NotificationNav] Sidebar navigation — tab:', navigation.tab);
        setSidebarTab(navigation.tab);
      } else {
        console.warn('[NotificationNav] Unhandled navigation type or missing fields:', JSON.stringify(navigation));
      }
    };
    window.electronAPI.on('notification:navigate', handler);
    return () => window.electronAPI.removeListener('notification:navigate', handler);
  }, [runtime, setSidebarTab, setChatViewMode, deactivateAllTabs]);

  return null;
}

/** Listens for navigate-to-page IPC (from Word overlay) and shows the chat view. */
function OverlayNavigationHandler({
  setSidebarTab,
  setChatViewMode,
  deactivateAllTabs,
}: {
  setSidebarTab: (tab: SidebarTab) => void;
  setChatViewMode: (mode: 'list' | 'detail') => void;
  deactivateAllTabs: () => void;
}) {
  const runtime = useAssistantRuntime();

  useEffect(() => {
    const handler = (_event: unknown, payload: { page: string; projectId?: number; conversationId?: number; sessionId?: string }) => {
      console.log('[OverlayNav] Received navigate-to-page:', JSON.stringify(payload));
      setSidebarTab('chats');
      setChatViewMode('detail');
      deactivateAllTabs();
      if (payload.sessionId) {
        try {
          runtime.threads.switchToThread(payload.sessionId);
        } catch (err) {
          console.error('[OverlayNav] Failed to switch to session:', err);
        }
      }
    };
    window.electronAPI.on('navigate-to-page', handler);
    return () => window.electronAPI.removeListener('navigate-to-page', handler);
  }, [runtime, setSidebarTab, setChatViewMode, deactivateAllTabs]);

  return null;
}

/** Subscribes to running agent sessions when a thread is opened. */
function SessionSubscriber() {
  useSessionSubscription();
  return null;
}

/** Listen for auto-generated session titles from the main process and update the thread list. */
function SessionTitleUpdater() {
  const runtime = useAssistantRuntime();

  useEffect(() => {
    return window.sessionsAPI.onTitleUpdated((sessionId, title) => {
      try {
        const item = runtime.threads.getItemById(sessionId);
        item.rename(title);
      } catch {
        // Thread not in list yet — title will appear on next list refresh
      }
    });
  }, [runtime]);

  return null;
}

/**
 * Refresh the thread list when main broadcasts `sessions:changed`
 * (e.g. overlay creates a chat or sends a message that re-sorts).
 *
 * assistant-ui's RemoteThreadListAdapter caches its `list()` result in
 * a private `_loadThreadsPromise` and exposes no public refresh API.
 * We clear that cache and re-trigger the internal load so new/renamed
 * threads merge in and `threadIds` re-sorts — without remounting the
 * runtime or interrupting an active conversation.
 */
function SessionsListRefresher() {
  const runtime = useAssistantRuntime();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      const core: any = (runtime as any)?._core?.threads;
      if (!core) return;
      core._loadThreadsPromise = null;
      core.__internal_load?.();
    };
    const unsubscribe = window.sessionsAPI.onSessionsChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 500);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [runtime]);

  return null;
}

/** When the user picks a different thread, deactivate tabs so chat is shown.
 *  Suppressed when the switch is app-initiated (e.g. opening a miniapp tab). */
function ShowChatOnThreadSelect({ onShowChat, suppressRef }: { onShowChat: () => void; suppressRef: React.RefObject<boolean> }) {
  const mainThreadId = useThreadList((s) => s.mainThreadId);
  const prevRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (mainThreadId == null) return;
    const prev = prevRef.current;
    if (prev !== undefined && prev !== mainThreadId) {
      if (suppressRef.current) {
        console.debug('[ShowChatOnThreadSelect] Thread changed (suppressed):', prev, '->', mainThreadId);
        suppressRef.current = false;
      } else {
        console.debug('[ShowChatOnThreadSelect] Thread changed:', prev, '->', mainThreadId, '— deactivating tabs');
        onShowChat();
      }
    }
    prevRef.current = mainThreadId;
  }, [mainThreadId, onShowChat, suppressRef]);

  return null;
}

/**
 * Switches to a new (empty) thread whenever the user leaves chat detail view.
 * This ensures the GlobalComposer always targets a fresh thread on non-chat pages.
 */
function ResetThreadOnLeavingDetail({
  isInChatDetail,
  suppressRef,
}: {
  isInChatDetail: boolean;
  suppressRef: React.MutableRefObject<boolean>;
}) {
  const runtime = useAssistantRuntime();
  const prevRef = useRef(isInChatDetail);

  useEffect(() => {
    if (prevRef.current && !isInChatDetail) {
      suppressRef.current = true;
      runtime.switchToNewThread();
    }
    prevRef.current = isInChatDetail;
  }, [isInChatDetail, runtime, suppressRef]);

  return null;
}

/** When a miniapp tab becomes active, switch to its associated chat session. */
function AppSessionSwitcher({
  activeDirName,
  cacheRef,
  suppressRef,
}: {
  activeDirName: string | null;
  cacheRef: React.RefObject<Map<string, string>>;
  suppressRef: React.MutableRefObject<boolean>;
}) {
  const runtime = useAssistantRuntime();

  useEffect(() => {
    if (!activeDirName) return;

    const cached = cacheRef.current.get(activeDirName);
    if (cached) {
      suppressRef.current = true;
      try {
        runtime.threads.switchToThread(cached);
      } catch {
        // Session may have been deleted — clear cache and retry via IPC
        cacheRef.current.delete(activeDirName);
      }
      return;
    }

    // Look up (or create) the session via main process
    let cancelled = false;
    window.sessionsAPI.findForApp(activeDirName).then((sessionId) => {
      if (cancelled || !sessionId) return;
      cacheRef.current.set(activeDirName, sessionId);
      suppressRef.current = true;
      try {
        runtime.threads.switchToThread(sessionId);
      } catch (err) {
        console.error('[AppSessionSwitcher] Failed to switch thread:', err);
      }
    });

    return () => { cancelled = true; };
  }, [activeDirName, runtime, cacheRef, suppressRef]);

  return null;
}

function OpenMiniAppToolUI({
  args,
  status,
  onOpen,
}: {
  args: { dir_name?: string };
  status: { type: string };
  onOpen: (dirName: string, opts?: { forceReload?: boolean }) => void;
}) {
  const openedRef = useRef<string | null>(null);

  useEffect(() => {
    const dirName = args?.dir_name;
    // Only open for tool calls that are actively running — not completed history
    if (dirName && status.type === 'running' && dirName !== openedRef.current) {
      openedRef.current = dirName;
      console.debug('[OpenMiniAppToolUI] Opening mini app (running tool call):', dirName);
      onOpen(dirName, { forceReload: true });
    } else if (dirName && status.type !== 'running') {
      console.debug('[OpenMiniAppToolUI] Skipping open for completed tool call:', dirName, 'status:', status.type);
    }
  }, [args?.dir_name, status.type, onOpen]);

  return null;
}

function OpenMiniAppHandler({ onOpen }: { onOpen: (dirName: string, opts?: { forceReload?: boolean }) => void }) {
  useAssistantToolUI({
    toolName: 'mcp__mini-apps__open_mini_application',
    render: (props: { args: { dir_name?: string }; status: { type: string } }) => (
      <OpenMiniAppToolUI args={props.args} status={props.status} onOpen={onOpen} />
    ),
  });

  return null;
}


function ChatView({ workspace, onWorkspaceUpdated, onLogout }: { workspace: Workspace; onWorkspaceUpdated: (ws: Workspace) => void; onLogout: () => void }) {
  useEffect(() => {
    trackEvent('Cobuilding Session');
  }, []);

  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('home');
  const [chatViewMode, setChatViewMode] = useState<'list' | 'detail'>('list');
  const [debugSection, setDebugSection] = useState<DebugSection>(() => {
    const saved = localStorage.getItem('debug-section');
    return (saved as DebugSection) || 'apps';
  });

  const { tabs, activeTabId, openTab, closeTab, activateTab, pinTab, deactivateAllTabs } = useTabs({
    onBeforeClose: (id) => {
      kernelRegistry.shutdown(id).catch(() => {});
    },
  });
  const [dirtyTabIds, setDirtyTabIds] = useState<Set<string>>(new Set());
  const [autoSelectFirstApp, setAutoSelectFirstApp] = useState(false);
  // Per-mini-app reload nonce — bumped each time the app is (re-)opened so the
  // iframe remounts and picks up a freshly built bundle. Without this, calling
  // open_mini_application on an already-open tab just activates it without
  // reloading the iframe contents.
  const [miniAppReloadNonces, setMiniAppReloadNonces] = useState<Record<string, number>>({});

  // Latest tabs ref so handleSelectApp's identity doesn't change on every tab
  // mutation (it would otherwise re-render sidebar components on each close/open).
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // Clear kernel registry when the workspace directory changes — the Jupyter
  // gateway container is restarted on workspace switch, so any cached kernels
  // are stale handles to a dead container.
  const prevWorkspacePathRef = useRef<string>(workspace.directory_path);
  useEffect(() => {
    if (prevWorkspacePathRef.current !== workspace.directory_path) {
      kernelRegistry.clearAll().catch(() => {});
      prevWorkspacePathRef.current = workspace.directory_path;
    }
  }, [workspace.directory_path]);

  const hasLiveKernel = useCallback((tabId: string) => {
    const entry = kernelRegistry.get(tabId);
    return entry !== null && entry.status !== 'dead' && entry.status !== 'disconnected';
  }, []);

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
      const attachments = useMemo(
        () => createAttachmentAdapter(workspace.directory_path),
        [workspace.directory_path]
      );
      return useLocalRuntime(chatAdapter, {
        adapters: { history, attachments },
      });
    },
    adapter: sessionListAdapter,
  });

  const handleSelectFile = useCallback((filePath: string) => {
    setSidebarTab('files');
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

  // Open file tabs from clickable paths in chat messages
  useEffect(() => {
    const handler = (e: CustomEvent<{ filePath: string; lineNumber?: number }>) => {
      const absolutePath = `${workspace.directory_path}/${e.detail.filePath}`;
      handleSelectFile(absolutePath);
    };
    window.addEventListener('open-file-tab', handler);
    return () => window.removeEventListener('open-file-tab', handler);
  }, [workspace.directory_path, handleSelectFile]);

  const handleSelectApp = useCallback((dirName: string, opts?: { forceReload?: boolean }) => {
    console.debug('[handleSelectApp] Opening mini app tab:', dirName, opts);
    setSidebarTab('tools');
    const tabId = `miniapp::${dirName}`;
    // Only force an iframe reload when the tab doesn't already exist. Re-clicking
    // an already-open mini app should just activate it — remounting the viewer
    // would tear down its kernel connection bookkeeping and the iframe state.
    // However, when forceReload is set (e.g. agent tool call after a rebuild),
    // always bump the nonce so the iframe picks up the new bundle.
    const alreadyOpen = tabsRef.current.some((t) => t.id === tabId);
    if (!alreadyOpen || opts?.forceReload) {
      setMiniAppReloadNonces((prev) => ({ ...prev, [dirName]: (prev[dirName] ?? 0) + 1 }));
    }
    const descriptor: TabDescriptor = {
      id: tabId,
      kind: 'miniapp',
      label: dirName,
      pinned: true, // mini apps are always pinned
      data: { kind: 'miniapp', dirName },
    };
    openTab(descriptor);
  }, [openTab]);


  const handleFilesClick = useCallback(() => {
    setSidebarTab('files');
    // If there's an open file/notebook tab, activate it
    const fileTab = [...tabs].reverse().find((t) => t.kind === 'file' || t.kind === 'notebook');
    if (fileTab) {
      activateTab(fileTab.id);
    }
    // Otherwise, leave the main panel as-is
  }, [tabs, activateTab]);

  const handleToolsClick = useCallback(() => {
    setSidebarTab('tools');
    // Activate the most recently opened miniapp tab, or auto-open the first app
    const miniappTab = [...tabs].reverse().find((t) => t.kind === 'miniapp');
    if (miniappTab) {
      activateTab(miniappTab.id);
    } else {
      setAutoSelectFirstApp(true);
    }
  }, [tabs, activateTab]);

  // Suppress ShowChatOnThreadSelect when switching threads for a miniapp
  const suppressThreadDeactivateRef = useRef(false);

  // In-memory cache: dirName → sessionId
  const appSessionCacheRef = useRef<Map<string, string>>(new Map());

  // Determine if the active tab is a miniapp (for showing chat side panel)
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const showChatSidePanel = activeTab?.kind === 'miniapp';
  const activeMiniAppDirName = activeTab?.kind === 'miniapp' && activeTab.data.kind === 'miniapp' ? activeTab.data.dirName : null;

  // Toggle a body class while dragging any panel divider so iframes/webviews
  // don't swallow the mousemove/mouseup events. CSS pairs this with
  // `pointer-events: none` on iframes during drag.
  const handleDragging = useCallback((isDragging: boolean) => {
    document.body.classList.toggle('cobuild-resizing', isDragging);
  }, []);

  // Whether the inner Thread/TaskPanel split should show the task panel.
  const tasks = useTasks();
  const showTaskPanel = !!tasks && tasks.length > 0;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SessionTitleUpdater />
      <SessionsListRefresher />
      <SessionSubscriber />
      <ShowChatOnThreadSelect onShowChat={() => { deactivateAllTabs(); setChatViewMode('detail'); }} suppressRef={suppressThreadDeactivateRef} />
      <AppSessionSwitcher activeDirName={activeMiniAppDirName} cacheRef={appSessionCacheRef} suppressRef={suppressThreadDeactivateRef} />
      <OpenMiniAppHandler onOpen={handleSelectApp} />
      <QuickChatInjector onSwitchToChat={() => { setSidebarTab('chats'); setChatViewMode('detail'); deactivateAllTabs(); }} />
      <ResetThreadOnLeavingDetail isInChatDetail={sidebarTab === 'chats' && chatViewMode === 'detail'} suppressRef={suppressThreadDeactivateRef} />
      <NotificationNavigator setSidebarTab={setSidebarTab} setChatViewMode={setChatViewMode} deactivateAllTabs={deactivateAllTabs} />
      <OverlayNavigationHandler setSidebarTab={setSidebarTab} setChatViewMode={setChatViewMode} deactivateAllTabs={deactivateAllTabs} />
      <TooltipProvider>
        <div className="appRoot">
          <SetupBanner />
          <div className="appLayout">
          <div className="topNavBar">
            <div className="topNavBar__brand">
              <span className="topNavBar__brandName">Co-scientist</span>
            </div>
            <nav className="topNavBar__tabs">
              <button
                className={`topNavTab${sidebarTab === 'home' ? ' topNavTab--active' : ''}`}
                onClick={() => { setSidebarTab('home'); deactivateAllTabs(); }}
              >
                Home
              </button>
              <button
                className={`topNavTab${sidebarTab === 'tools' ? ' topNavTab--active' : ''}`}
                onClick={handleToolsClick}
              >
                Tools
              </button>
              <button
                className={`topNavTab${sidebarTab === 'files' ? ' topNavTab--active' : ''}`}
                onClick={handleFilesClick}
              >
                Files
              </button>
              <button
                className={`topNavTab${sidebarTab === 'chats' ? ' topNavTab--active' : ''}`}
                onClick={() => { setSidebarTab('chats'); setChatViewMode('list'); deactivateAllTabs(); }}
              >
                Chats
              </button>
            </nav>
            <div className="topNavBar__right">
              <button
                className={`topNavTab topNavTab--secondary${sidebarTab === 'debug' ? ' topNavTab--active' : ''}`}
                onClick={() => setSidebarTab('debug')}
              >
                Debug
              </button>
              <button
                className={`topNavTab topNavTab--secondary${sidebarTab === 'settings' ? ' topNavTab--active' : ''}`}
                onClick={() => setSidebarTab('settings')}
              >
                Settings
              </button>
            </div>
          </div>
          <div className="contentArea">
            {/* Home tab */}
            <div style={{ display: sidebarTab === 'home' ? 'flex' : 'none', flex: 1 }}>
              <div className="homeContent">
                <h1>Home</h1>
              </div>
            </div>

            {/* Tools tab */}
            <div style={{ display: sidebarTab === 'tools' ? 'flex' : 'none', flex: 1 }}>
              <PanelGroup direction="horizontal" autoSaveId="cobuild.toolsLayout" className="appPanelGroup">
                <Panel id="toolsSidebar" order={1} defaultSize={18} minSize={12} maxSize={40}>
                  <div className="sidebarPanel">
                    <div className="sidebarContent">
                      <MiniAppsTab
                        workspacePath={workspace.directory_path}
                        onSelectApp={handleSelectApp}
                        onDeleteApp={(dirName) => closeTab(`miniapp::${dirName}`)}
                        onNewApplication={() => { setSidebarTab('chats'); }}
                        activeAppDirName={activeTab?.kind === 'miniapp' && activeTab.data.kind === 'miniapp' ? activeTab.data.dirName : undefined}
                        autoSelectFirst={autoSelectFirstApp}
                        onAutoSelectDone={() => setAutoSelectFirstApp(false)}
                      />
                    </div>
                  </div>
                </Panel>
                <PanelResizeHandle className="panelHandle" onDragging={handleDragging} />
                <Panel id="toolsMain" order={2} defaultSize={54} minSize={30}>
                  <div className="mainPanel">
                    <TabBar
                      tabs={tabs.filter(t => t.kind === 'miniapp')}
                      activeTabId={activeTabId}
                      dirtyTabIds={dirtyTabIds}
                      hasLiveKernel={hasLiveKernel}
                      onActivate={activateTab}
                      onClose={closeTab}
                      onPin={pinTab}
                      onShowChat={deactivateAllTabs}
                      homeLabel="Tools"
                    />
                    <div className="tabPanelsContainer">
                      <div className="tabPanel" style={{ display: !activeTabId || !tabs.find(t => t.id === activeTabId && t.kind === 'miniapp') ? 'flex' : 'none' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#999', fontSize: '0.875rem' }}>
                          Select a tool from the sidebar
                        </div>
                      </div>
                      {tabs.filter(t => t.kind === 'miniapp').map((tab) => (
                        <div key={tab.id} className="tabPanel" style={{ display: tab.id === activeTabId ? 'flex' : 'none' }}>
                          {tab.data.kind === 'miniapp' && (
                            <MiniAppViewer
                              dirName={tab.data.dirName}
                              workspacePath={workspace.directory_path}
                              reloadNonce={miniAppReloadNonces[tab.data.dirName] ?? 0}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </Panel>
                {showChatSidePanel && (
                  <>
                    <PanelResizeHandle className="panelHandle" onDragging={handleDragging} />
                    <Panel id="toolsChatSide" order={3} defaultSize={28} minSize={18} maxSize={50}>
                      <div className="chatSidePanel">
                        <Thread />
                      </div>
                    </Panel>
                  </>
                )}
              </PanelGroup>
            </div>

            {/* Files tab */}
            <div style={{ display: sidebarTab === 'files' ? 'flex' : 'none', flex: 1 }}>
              <PanelGroup direction="horizontal" autoSaveId="cobuild.filesLayout" className="appPanelGroup">
                <Panel id="filesSidebar" order={1} defaultSize={18} minSize={12} maxSize={40}>
                  <div className="sidebarPanel">
                    <div className="sidebarContent">
                      <FilesTab
                        workspacePath={workspace.directory_path}
                        onSelectFile={handleSelectFile}
                      />
                    </div>
                  </div>
                </Panel>
                <PanelResizeHandle className="panelHandle" onDragging={handleDragging} />
                <Panel id="filesMain" order={2} defaultSize={82} minSize={30}>
                  <div className="mainPanel">
                    <TabBar
                      tabs={tabs.filter(t => t.kind === 'file' || t.kind === 'notebook')}
                      activeTabId={activeTabId}
                      dirtyTabIds={dirtyTabIds}
                      hasLiveKernel={hasLiveKernel}
                      onActivate={activateTab}
                      onClose={closeTab}
                      onPin={pinTab}
                      onShowChat={deactivateAllTabs}
                      homeLabel="Files"
                    />
                    <div className="tabPanelsContainer">
                      <div className="tabPanel" style={{ display: !activeTabId || !tabs.find(t => t.id === activeTabId && (t.kind === 'file' || t.kind === 'notebook')) ? 'flex' : 'none' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#999', fontSize: '0.875rem' }}>
                          Select a file from the sidebar
                        </div>
                      </div>
                      {tabs.filter(t => t.kind === 'file' || t.kind === 'notebook').map((tab) => (
                        <div key={tab.id} className="tabPanel" style={{ display: tab.id === activeTabId ? 'flex' : 'none' }}>
                          {tab.data.kind === 'file' && (
                            <FileViewer filePath={tab.data.filePath} />
                          )}
                          {tab.data.kind === 'notebook' && (
                            <NotebookViewer
                              filePath={tab.data.filePath}
                              onDirtyChange={(dirty) => handleDirtyChange(tab.id, dirty)}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </Panel>
              </PanelGroup>
            </div>

            {/* Chats tab */}
            <div style={{ display: sidebarTab === 'chats' ? 'flex' : 'none', flex: 1, flexDirection: 'column' }}>
              {chatViewMode === 'detail' ? (
                <>
                  <div className="chatDetailHeader">
                    <button
                      className="chatDetailBackBtn"
                      onClick={() => { setChatViewMode('list'); }}
                    >
                      &larr; Back to chats
                    </button>
                  </div>
                  <div className="chatDetailContent" style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                    <PanelGroup direction="horizontal" autoSaveId="cobuild.chatTasks" className="appPanelGroup">
                      <Panel id="thread" order={1} defaultSize={78} minSize={40}>
                        <Thread hideComposer />
                      </Panel>
                      {showTaskPanel && (
                        <>
                          <PanelResizeHandle className="panelHandle" onDragging={handleDragging} />
                          <Panel id="tasks" order={2} defaultSize={22} minSize={15} maxSize={45}>
                            <TaskPanel />
                          </Panel>
                        </>
                      )}
                    </PanelGroup>
                  </div>
                </>
              ) : (
                <ThreadList onSelectThread={() => setChatViewMode('detail')} />
              )}
            </div>

            {/* Debug tab */}
            <div style={{ display: sidebarTab === 'debug' ? 'flex' : 'none', flex: 1 }}>
              <PanelGroup direction="horizontal" autoSaveId="cobuild.debugLayout" className="appPanelGroup">
                <Panel id="debugSidebar" order={1} defaultSize={18} minSize={12} maxSize={40}>
                  <div className="sidebarPanel">
                    <div className="sidebarContent">
                      <DebugSidebar activeSection={debugSection} onSelect={(s) => { setDebugSection(s); localStorage.setItem('debug-section', s); }} />
                    </div>
                  </div>
                </Panel>
                <PanelResizeHandle className="panelHandle" onDragging={handleDragging} />
                <Panel id="debugMain" order={2} defaultSize={82} minSize={30}>
                  <div className="mainPanel">
                    <DebugContent activeSection={debugSection} />
                  </div>
                </Panel>
              </PanelGroup>
            </div>

            {/* Settings tab */}
            <div style={{ display: sidebarTab === 'settings' ? 'flex' : 'none', flex: 1 }}>
              <WorkspaceSettings
                workspace={workspace}
                onClose={() => setSidebarTab('home')}
                onSaved={(ws) => {
                  onWorkspaceUpdated(ws);
                  setSidebarTab('home');
                }}
                onLogout={onLogout}
                inline
              />
            </div>
          </div>
          {/* Global composer — shown on all pages except settings, debug, active miniapp */}
          {sidebarTab !== 'settings' &&
           sidebarTab !== 'debug' &&
           !(sidebarTab === 'tools' && activeTab?.kind === 'miniapp') && (
            <GlobalComposer
              isInChatDetail={sidebarTab === 'chats' && chatViewMode === 'detail'}
              onNavigateToChat={() => {
                suppressThreadDeactivateRef.current = true;
                setSidebarTab('chats');
                setChatViewMode('detail');
              }}
            />
          )}
        </div>
        </div>
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}

type OnboardingStep = 'loading' | 'welcome' | 'login' | 'workspace' | 'scanning' | 'review' | 'ready';

function App() {
  const [step, setStep] = useState<OnboardingStep>('loading');
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [scanReportId, setScanReportId] = useState<string | null>(null);

  useEffect(() => {
    window.authAPI.checkLogin().then((result: any) => {
      const { loggedIn, user, appInfo } = result;
      initFullStory(appInfo?.isPackaged);

      if (!loggedIn) {
        setStep('welcome');
        return;
      }

      if (user?.id) {
        identifyUser(user.id, user.email, user.first_name || user.name, appInfo?.deviceId, appInfo?.appVersion);
      }

      window.workspacesAPI.getActive().then((ws) => {
        if (ws) {
          setWorkspace(ws);
          setStep('ready');
        } else {
          setStep('workspace');
        }
      });
    });
  }, []);

  switch (step) {
    case 'loading':
      return null;

    case 'welcome':
      return <WelcomeScreen onGetStarted={() => setStep('login')} />;

    case 'login':
      return (
        <AcademiaLogin
          onBack={() => setStep('welcome')}
          onSuccess={() => {
            window.authAPI.checkLogin().then((result: any) => {
              const { user, appInfo } = result;
              if (user?.id) {
                identifyUser(user.id, user.email, user.first_name || user.name, appInfo?.deviceId, appInfo?.appVersion);
              }
            });
            setStep('workspace');
          }}
        />
      );

    case 'workspace':
      return (
        <WorkspaceOnboarding
          onBack={() => setStep('login')}
          onComplete={() => {
            window.workspacesAPI.getActive().then((ws) => {
              if (ws) {
                setWorkspace(ws);
                setStep('scanning');
              }
            });
          }}
        />
      );

    case 'scanning':
      return (
        <ScanningProgress
          onComplete={(reportId) => {
            setScanReportId(reportId);
            setStep('review');
          }}
          onSkip={() => setStep('ready')}
        />
      );

    case 'review':
      return (
        <ScanResultsReview
          reportId={scanReportId!}
          onComplete={() => setStep('ready')}
        />
      );

    case 'ready':
      return (
        <ChatView
          workspace={workspace!}
          onWorkspaceUpdated={setWorkspace}
          onLogout={() => setStep('welcome')}
        />
      );
  }
}

// Wrap ResizeObserver callbacks in requestAnimationFrame so they never fire
// synchronously inside the browser's delivery loop. This is the canonical fix
// for "ResizeObserver loop completed with undelivered notifications" — the
// loop guard only trips when callbacks mutate layout during the same delivery
// cycle they were dispatched in, so deferring by one frame eliminates it.
const NativeResizeObserver = window.ResizeObserver;
if (NativeResizeObserver) {
  window.ResizeObserver = class extends NativeResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => {
        window.requestAnimationFrame(() => {
          if (!Array.isArray(entries) || !entries.length) return;
          callback(entries, observer);
        });
      });
    }
  };
}

const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
