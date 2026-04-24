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
import { FolderIcon, MessageSquareIcon, BracesIcon, SettingsIcon, LayoutGridIcon, ClockIcon, SparklesIcon, MicIcon, CalendarIcon } from 'lucide-react';
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
import { FocusEditor } from './components/FocusEditor';
import { NotesSidebar } from './components/NotesSidebar';
import { NotesPanel } from './components/NotesPanel';
import { NotesChat } from './components/NotesChat';
import { CalendarPage } from './components/CalendarPage';

import { ScheduledTaskEditor } from './components/ScheduledTaskEditor';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useTasks } from './taskStore';
import './components/ScheduledTasks.css';
import { useElectronChatAdapter } from './chatAdapter';
import { sessionListAdapter } from './sessionListAdapter';
import { useThreadHistoryAdapter } from './threadHistoryAdapter';
import { createAttachmentAdapter } from './attachmentAdapter';
import { useSessionSubscription } from './useSessionSubscription';
import WorkspaceOnboarding from './components/WorkspaceOnboarding';
import WorkspaceSettings from './components/WorkspaceSettings';
import AcademiaLogin from './components/AcademiaLogin';
import { SetupBanner } from './components/SetupBanner';
import { TaskPanel } from './components/TaskPanel';
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
type SidebarTab = 'chats' | 'files' | 'apps' | 'scheduled' | 'reactions' | 'writing' | 'notes' | 'calendar' | 'debug';

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
      console.log('[NotificationNav] Renderer received notification:navigate IPC:', JSON.stringify(navigation));
      if (navigation.type === 'thread' && navigation.threadId) {
        console.log('[NotificationNav] Thread navigation — threadId:', navigation.threadId, 'sidebarTab:', navigation.sidebarTab ?? 'chats (default)');
        setSidebarTab(navigation.sidebarTab ?? 'chats');
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
  }, [runtime, setSidebarTab, deactivateAllTabs]);

  return null;
}

/** Listens for navigate-to-page IPC (from Word overlay) and shows the chat view. */
function OverlayNavigationHandler({
  setSidebarTab,
  deactivateAllTabs,
}: {
  setSidebarTab: (tab: SidebarTab) => void;
  deactivateAllTabs: () => void;
}) {
  const runtime = useAssistantRuntime();

  useEffect(() => {
    const handler = (_event: unknown, payload: { page: string; projectId?: number; conversationId?: number; sessionId?: string }) => {
      console.log('[OverlayNav] Received navigate-to-page:', JSON.stringify(payload));
      setSidebarTab('chats');
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
  }, [runtime, setSidebarTab, deactivateAllTabs]);

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
  useEffect(() => {
    trackEvent('Cobuilding Session');
  }, []);

  const [showSettings, setShowSettings] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('chats');
  const [debugSection, setDebugSection] = useState<DebugSection>(() => {
    const saved = localStorage.getItem('debug-section');
    return (saved as DebugSection) || 'apps';
  });
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [isNewTask, setIsNewTask] = useState(false);
  const [taskRefreshKey, setTaskRefreshKey] = useState(0);
  const [selectedNoteDay, setSelectedNoteDay] = useState<string | null>(null);

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

  const handleSelectApp = useCallback((dirName: string) => {
    console.debug('[handleSelectApp] Opening mini app tab:', dirName);
    const tabId = `miniapp::${dirName}`;
    // Only force an iframe reload when the tab doesn't already exist. Re-clicking
    // an already-open mini app should just activate it — remounting the viewer
    // would tear down its kernel connection bookkeeping and the iframe state.
    const alreadyOpen = tabsRef.current.some((t) => t.id === tabId);
    if (!alreadyOpen) {
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

  const handleOpenFocus = useCallback(() => {
    const descriptor: TabDescriptor = {
      id: 'focus',
      kind: 'focus',
      label: 'Focus',
      pinned: true,
      data: { kind: 'focus' },
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

  const handleAppsClick = useCallback(() => {
    setSidebarTab('apps');
    // Activate the most recently opened miniapp tab, or auto-open the first app
    const miniappTab = [...tabs].reverse().find((t) => t.kind === 'miniapp');
    if (miniappTab) {
      activateTab(miniappTab.id);
    } else {
      setAutoSelectFirstApp(true);
    }
  }, [tabs, activateTab]);

  const handleNotesClick = useCallback(() => {
    setSidebarTab('notes');
    deactivateAllTabs();
    if (!selectedNoteDay) {
      setSelectedNoteDay(new Date().toISOString().split('T')[0]);
    }
  }, [deactivateAllTabs, selectedNoteDay]);

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
      <SessionSubscriber />
      <ShowChatOnThreadSelect onShowChat={deactivateAllTabs} suppressRef={suppressThreadDeactivateRef} />
      <AppSessionSwitcher activeDirName={activeMiniAppDirName} cacheRef={appSessionCacheRef} suppressRef={suppressThreadDeactivateRef} />
      <OpenMiniAppHandler onOpen={handleSelectApp} />
      <QuickChatInjector onSwitchToChat={() => { setSidebarTab('chats'); deactivateAllTabs(); }} />
      <NotificationNavigator setSidebarTab={setSidebarTab} deactivateAllTabs={deactivateAllTabs} />
      <OverlayNavigationHandler setSidebarTab={setSidebarTab} deactivateAllTabs={deactivateAllTabs} />
      <TooltipProvider>
        <div className="appRoot">
          <SetupBanner />
          <div className="appLayout">
          <div className="activityBar">
            <button
              className={`activityBarBtn ${sidebarTab === 'files' ? 'activityBarBtn--active' : ''}`}
              onClick={handleFilesClick}
            >
              <FolderIcon style={{ width: 20, height: 20 }} />
              <span className="activityBarBtnLabel">Files</span>
            </button>
            <button
              className={`activityBarBtn ${sidebarTab === 'chats' ? 'activityBarBtn--active' : ''}`}
              onClick={() => { setSidebarTab('chats'); deactivateAllTabs(); }}
            >
              <MessageSquareIcon style={{ width: 20, height: 20 }} />
              <span className="activityBarBtnLabel">Chats</span>
            </button>
            <button
              className={`activityBarBtn ${sidebarTab === 'apps' ? 'activityBarBtn--active' : ''}`}
              onClick={handleAppsClick}
            >
              <LayoutGridIcon style={{ width: 20, height: 20 }} />
              <span className="activityBarBtnLabel">Apps</span>
            </button>
            <button
              className={`activityBarBtn ${sidebarTab === 'scheduled' ? 'activityBarBtn--active' : ''}`}
              onClick={() => setSidebarTab('scheduled')}
            >
              <ClockIcon style={{ width: 20, height: 20 }} />
              <span className="activityBarBtnLabel">Schedule</span>
            </button>
            <button
              className={`activityBarBtn ${sidebarTab === 'reactions' ? 'activityBarBtn--active' : ''}`}
              onClick={() => setSidebarTab('reactions')}
            >
              <SparklesIcon style={{ width: 20, height: 20 }} />
              <span className="activityBarBtnLabel">Reactions</span>
            </button>
            <button
              className={`activityBarBtn ${sidebarTab === 'notes' ? 'activityBarBtn--active' : ''}`}
              onClick={handleNotesClick}
            >
              <MicIcon style={{ width: 20, height: 20 }} />
              <span className="activityBarBtnLabel">Notes</span>
            </button>
            <button
              className={`activityBarBtn ${sidebarTab === 'calendar' ? 'activityBarBtn--active' : ''}`}
              onClick={() => setSidebarTab('calendar')}
            >
              <CalendarIcon style={{ width: 20, height: 20 }} />
              <span className="activityBarBtnLabel">Calendar</span>
            </button>
            <button
              className={`activityBarBtn activityBarBtn--bottom ${sidebarTab === 'debug' ? 'activityBarBtn--active' : ''}`}
              onClick={() => { setSidebarTab('debug'); handleOpenDebug(); }}
            >
              <BracesIcon style={{ width: 20, height: 20 }} />
              <span className="activityBarBtnLabel">Debug</span>
            </button>
            <button
              className="activityBarBtn"
              onClick={() => setShowSettings(true)}
            >
              <SettingsIcon style={{ width: 20, height: 20 }} />
              <span className="activityBarBtnLabel">Settings</span>
            </button>
          </div>
          <PanelGroup direction="horizontal" autoSaveId="cobuild.layout" className="appPanelGroup">
            {sidebarTab !== 'calendar' && (
              <>
                <Panel id="sidebar" order={1} defaultSize={18} minSize={12} maxSize={40}>
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
                          onDeleteApp={(dirName) => closeTab(`miniapp::${dirName}`)}
                          onNewApplication={() => { setSidebarTab('chats'); }}
                          activeAppDirName={activeTab?.kind === 'miniapp' && activeTab.data.kind === 'miniapp' ? activeTab.data.dirName : undefined}
                          autoSelectFirst={autoSelectFirstApp}
                          onAutoSelectDone={() => setAutoSelectFirstApp(false)}
                        />
                      ) : sidebarTab === 'reactions' ? (
                        <ReactionsSidebar onOpenFocus={handleOpenFocus} />
                      ) : sidebarTab === 'scheduled' ? (
                        <ScheduledTasksSidebar
                          selectedTaskId={selectedTaskId}
                          onSelectTask={(id) => { setSelectedTaskId(id); setIsNewTask(false); }}
                          onNewTask={() => { setSelectedTaskId(null); setIsNewTask(true); }}
                          refreshKey={taskRefreshKey}
                        />
                      ) : sidebarTab === 'notes' ? (
                        <NotesSidebar
                          selectedDay={selectedNoteDay}
                          onSelectDay={setSelectedNoteDay}
                        />
                      ) : sidebarTab === 'debug' ? (
                        <DebugSidebar activeSection={debugSection} onSelect={(s) => { setDebugSection(s); localStorage.setItem('debug-section', s); }} />
                      ) : null}
                    </div>
                  </div>
                </Panel>
                <PanelResizeHandle className="panelHandle" onDragging={handleDragging} />
              </>
            )}
            <Panel id="main" order={2} defaultSize={54} minSize={30}>
              <div className="mainPanel">
                {sidebarTab === 'calendar' ? (
                  <CalendarPage />
                ) : sidebarTab === 'notes' ? (
                  <PanelGroup direction="horizontal" autoSaveId="cobuild.notesLayout" className="appPanelGroup">
                    <Panel id="notesMain" order={1} defaultSize={65} minSize={40}>
                      <NotesPanel selectedDay={selectedNoteDay} />
                    </Panel>
                    <PanelResizeHandle className="panelHandle" onDragging={handleDragging} />
                    <Panel id="notesAssistant" order={2} defaultSize={35} minSize={20} maxSize={50}>
                      <NotesChat dayFile={selectedNoteDay ?? new Date().toISOString().split('T')[0]} />
                    </Panel>
                  </PanelGroup>
                ) : sidebarTab === 'scheduled' ? (
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
                      hasLiveKernel={hasLiveKernel}
                      onActivate={activateTab}
                      onClose={closeTab}
                      onPin={pinTab}
                      onShowChat={deactivateAllTabs}
                    />
                    <div className="tabPanelsContainer">
                      {/* Chat is the default view when no tab is active */}
                      <div className="tabPanel" style={{ display: activeTabId === null ? 'flex' : 'none' }}>
                        <PanelGroup direction="horizontal" autoSaveId="cobuild.chatTasks" className="appPanelGroup">
                          <Panel id="thread" order={1} defaultSize={78} minSize={40}>
                            <Thread />
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
                              key={miniAppReloadNonces[tab.data.dirName] ?? 0}
                              dirName={tab.data.dirName}
                              workspacePath={workspace.directory_path}
                            />
                          )}
                          {tab.data.kind === 'debug' && (
                            <DebugContent activeSection={debugSection} />
                          )}
                          {tab.data.kind === 'focus' && (
                            <FocusEditor />
                          )}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </Panel>
            {showChatSidePanel && (
              <>
                <PanelResizeHandle className="panelHandle" onDragging={handleDragging} />
                <Panel id="chatSide" order={3} defaultSize={28} minSize={18} maxSize={50}>
                  <div className="chatSidePanel">
                    <Thread />
                  </div>
                </Panel>
              </>
            )}
          </PanelGroup>
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
    window.authAPI.checkLogin().then((result: any) => {
      const { loggedIn, user, appInfo } = result;
      initFullStory(appInfo?.isPackaged);
      setIsLoggedIn(loggedIn);
      if (loggedIn) {
        if (user?.id) {
          identifyUser(user.id, user.email, user.first_name || user.name, appInfo?.deviceId, appInfo?.appVersion);
        }
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
          window.authAPI.checkLogin().then((result: any) => {
            const { user, appInfo } = result;
            if (user?.id) {
              identifyUser(user.id, user.email, user.first_name || user.name, appInfo?.deviceId, appInfo?.appVersion);
            }
          });
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
