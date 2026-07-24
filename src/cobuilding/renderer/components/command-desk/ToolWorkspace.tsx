import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { MSymbol } from './MSymbol';
import { resolveToolIcon } from './toolIcon';
import { MiniAppViewer } from '../MiniAppViewer';
import { Thread } from '../assistant-ui/thread';
import { useToolStatuses, type ToolRuntimeStatus } from '../../toolStatusStore';
import type { TabDescriptor } from '../../tabs/types';
import type { FC } from 'react';

/**
 * Tool viewer (Phase B): tab bar → per-tool viewer (header + iframe/install/
 * build-error) → optional chat side panel (the narrow thread variant) with a
 * drag divider and a collapsed 44px strip. Panel width is persisted per user;
 * open/collapsed state per tool.
 */

const PANEL_WIDTH_KEY = 'cd.toolPanel.width';
const PANEL_OPEN_KEY = 'cd.toolPanel.open';
const PANEL_MIN = 320;
const PANEL_MAX = 560;

function loadPanelWidth(): number {
  const raw = Number(localStorage.getItem(PANEL_WIDTH_KEY));
  if (!Number.isFinite(raw) || raw <= 0) return 380;
  return Math.min(PANEL_MAX, Math.max(PANEL_MIN, raw));
}

function loadPanelOpenMap(): Record<string, boolean> {
  try {
    const parsed = JSON.parse(localStorage.getItem(PANEL_OPEN_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function statusDotClass(status: ToolRuntimeStatus): string {
  switch (status.kind) {
    case 'buildFailed': return 'cdDot--error';
    case 'building':
    case 'installing': return 'cdDot--busy cdDot--pulse';
    default: return 'cdDot--running';
  }
}

export interface ToolWorkspaceProps {
  tabs: TabDescriptor[];
  activeTabId: string | null;
  apps: MiniAppEntry[];
  workspacePath: string;
  miniAppReloadNonces: Record<string, number>;
  preBuiltApps: Set<string>;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onBack: () => void;
  onExpandChat: () => void;
}

export const ToolWorkspace: FC<ToolWorkspaceProps> = ({
  tabs,
  activeTabId,
  apps,
  workspacePath,
  miniAppReloadNonces,
  preBuiltApps,
  onSelectTab,
  onCloseTab,
  onBack,
  onExpandChat,
}) => {
  const statuses = useToolStatuses();
  const miniappTabs = tabs.filter((t) => t.kind === 'miniapp' && t.data.kind === 'miniapp');
  const activeTab = miniappTabs.find((t) => t.id === activeTabId) ?? null;
  const activeDirName =
    activeTab?.data.kind === 'miniapp' ? activeTab.data.dirName : null;
  const appByDir = new Map(apps.map((a) => [a.dirName, a]));
  const activeApp = activeDirName ? appByDir.get(activeDirName) : undefined;
  const activeName = activeApp?.name ?? activeDirName ?? '';

  const [panelWidth, setPanelWidth] = useState(loadPanelWidth);
  const [panelOpenMap, setPanelOpenMap] = useState<Record<string, boolean>>(loadPanelOpenMap);
  const [unread, setUnread] = useState<Set<string>>(new Set());

  const panelOpen = activeDirName ? panelOpenMap[activeDirName] ?? true : true;

  const setPanelOpen = useCallback((dirName: string, open: boolean) => {
    setPanelOpenMap((prev) => {
      const next = { ...prev, [dirName]: open };
      localStorage.setItem(PANEL_OPEN_KEY, JSON.stringify(next));
      return next;
    });
    if (open) {
      setUnread((prev) => {
        if (!prev.has(dirName)) return prev;
        const next = new Set(prev);
        next.delete(dirName);
        return next;
      });
    }
  }, []);

  const togglePanel = useCallback(() => {
    if (activeDirName) setPanelOpen(activeDirName, !panelOpen);
  }, [activeDirName, panelOpen, setPanelOpen]);

  // ── Divider drag (320–560, persisted) ──
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragState.current = { startX: e.clientX, startWidth: panelWidth };
    document.body.classList.add('cobuild-resizing');
    const onMove = (ev: MouseEvent) => {
      if (!dragState.current) return;
      const delta = dragState.current.startX - ev.clientX;
      const next = Math.min(PANEL_MAX, Math.max(PANEL_MIN, dragState.current.startWidth + delta));
      setPanelWidth(next);
    };
    const onUp = () => {
      dragState.current = null;
      document.body.classList.remove('cobuild-resizing');
      setPanelWidth((w) => {
        localStorage.setItem(PANEL_WIDTH_KEY, String(w));
        return w;
      });
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [panelWidth]);

  const handleTurnFinishedWhileCollapsed = useCallback(() => {
    if (!activeDirName) return;
    setUnread((prev) => {
      const next = new Set(prev);
      next.add(activeDirName);
      return next;
    });
  }, [activeDirName]);

  return (
    <div className="cdToolWorkspace">
      {/* Tab bar */}
      <div className="cdTabBar">
        {miniappTabs.map((tab) => {
          const dirName = tab.data.kind === 'miniapp' ? tab.data.dirName : '';
          const app = appByDir.get(dirName);
          const Icon = resolveToolIcon(app?.icon ?? null);
          const isActive = tab.id === activeTabId;
          const status = statuses.get(dirName) ?? { kind: 'running' as const };
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              className={`cdTab${isActive ? ' cdTab--active' : ''}`}
              onClick={() => onSelectTab(tab.id)}
              onAuxClick={(e) => { if (e.button === 1) onCloseTab(tab.id); }}
            >
              <Icon className="cdTab__icon" style={{ width: 15, height: 15 }} />
              {app?.name ?? dirName}
              <span className={`cdTab__dot cdDot ${statusDotClass(status)}`} style={{ width: 5, height: 5 }} />
              <button
                type="button"
                className="cdTab__close"
                title="Close tab"
                onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              >
                <MSymbol name="close" size={14} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Body: viewer(s) + chat panel */}
      <div className="cdToolBody">
        <div className="cdToolMain">
          {miniappTabs.map((tab) => {
            const dirName = tab.data.kind === 'miniapp' ? tab.data.dirName : '';
            const app = appByDir.get(dirName);
            return (
              <div
                key={tab.id}
                className="tabPanel"
                style={{ display: tab.id === activeTabId ? 'flex' : 'none', flex: 1, minHeight: 0 }}
              >
                <MiniAppViewer
                  dirName={dirName}
                  workspacePath={workspacePath}
                  reloadNonce={miniAppReloadNonces[dirName] ?? 0}
                  preBuilt={preBuiltApps.has(dirName)}
                  appName={app?.name ?? dirName}
                  appIcon={app?.icon ?? null}
                  chatOpen={panelOpen}
                  onToggleChat={togglePanel}
                  onBack={onBack}
                />
              </div>
            );
          })}
        </div>

        {activeDirName && panelOpen && (
          <>
            <div
              className="cdPanelDivider"
              title="Drag to resize (320–560)"
              onMouseDown={handleDividerMouseDown}
            >
              <MSymbol name="drag_indicator" size={13} />
            </div>
            <div className="cdSidePanel" style={{ width: panelWidth }}>
              <SidePanelHeader
                onExpand={onExpandChat}
                onCollapse={() => setPanelOpen(activeDirName, false)}
              />
              <Thread variant="panel" />
            </div>
          </>
        )}

        {activeDirName && !panelOpen && (
          <div className="cdPanelCollapsed">
            <UnreadWatcher collapsed onTurnFinished={handleTurnFinishedWhileCollapsed} />
            <button
              type="button"
              className="cdPanelCollapsed__btn"
              title="Expand chat panel"
              onClick={() => setPanelOpen(activeDirName, true)}
            >
              <MSymbol name="keyboard_double_arrow_left" size={17} />
            </button>
            <button
              type="button"
              className="cdPanelCollapsed__btn"
              title={`Chat — ${activeName}`}
              onClick={() => setPanelOpen(activeDirName, true)}
            >
              <MSymbol name="forum" size={17} />
              {unread.has(activeDirName) && <span className="cdPanelCollapsed__unread" />}
            </button>
            <span className="cdPanelCollapsed__spacer" />
            <span className="cdPanelCollapsed__label">CHAT — {activeName.toUpperCase()}</span>
          </div>
        )}
      </div>
    </div>
  );
};

/** Panel header: chat title · GENERATING chip · pop-out · collapse. */
const SidePanelHeader: FC<{ onExpand: () => void; onCollapse: () => void }> = ({ onExpand, onCollapse }) => {
  const title = useAuiState((s: any) => s.threadListItem?.title) as string | undefined;
  const isRunning = useAuiState((s: any) => s.thread?.isRunning ?? false) as boolean;
  return (
    <div className="cdSidePanel__header">
      <span className="cdSidePanel__title">{title ?? 'Chat'}</span>
      {isRunning && (
        <span className="cdStatusChip">
          <span className="cdDot cdDot--busy cdDot--pulse" />
          GENERATING
        </span>
      )}
      <button type="button" className="cdIconBtn cdIconBtn--26" title="Open as full chat" onClick={onExpand}>
        <MSymbol name="open_in_full" size={15} />
      </button>
      <button type="button" className="cdIconBtn cdIconBtn--26" title="Collapse panel" onClick={onCollapse}>
        <MSymbol name="keyboard_double_arrow_right" size={16} />
      </button>
    </div>
  );
};

/**
 * Flags an unread dot when a turn for the active tool's chat finishes while
 * the panel is collapsed.
 */
const UnreadWatcher: FC<{ collapsed: boolean; onTurnFinished: () => void }> = ({ collapsed, onTurnFinished }) => {
  const isRunning = useAuiState((s: any) => s.thread?.isRunning ?? false) as boolean;
  const prevRef = useRef(isRunning);
  useEffect(() => {
    if (prevRef.current && !isRunning && collapsed) onTurnFinished();
    prevRef.current = isRunning;
  }, [isRunning, collapsed, onTurnFinished]);
  return null;
};
