import React, { useState, useEffect } from 'react';
import { MSymbol } from './MSymbol';
import { resolveToolIcon } from './toolIcon';
import { relTimeShort, formatSize, headerDate } from './format';
import type { DriveFile } from './useHomeData';
import { AVAILABLE_TOOLS_STUB } from '../availableTools';

const MAX_TOOL_CARDS = 5; // + the "build a new tool" card = 6 grid cells
const MAX_RECENT_CHATS = 3;

function driveIconFor(relPath: string): string {
  const ext = relPath.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'db' || ext === 'sqlite') return 'database';
  if (ext === 'json' || ext === 'ipynb' || ext === 'yaml' || ext === 'yml') return 'data_object';
  if (ext === 'csv' || ext === 'tsv' || ext === 'xlsx' || ext === 'xls') return 'table';
  if (ext === 'pdf') return 'picture_as_pdf';
  if (ext === 'py' || ext === 'r') return 'code';
  return 'description';
}

/** Focus the docked composer (the "Build a new tool" card's click target). */
function focusComposer() {
  window.dispatchEvent(new CustomEvent('cd:focus-composer'));
}

/**
 * Home screen ("Command Desk"). The Tools grid shows the user's mini-apps
 * first, then the pre-built tools (same inventory as the Tools page). A
 * mini-app shows RUNNING while its viewer tab is open this session, SLEEPING
 * otherwise — there is no host-side tool lifecycle yet, so busy/crashed
 * states and progress bars stay dormant until one exists. Pre-built cards
 * navigate to the Tools page, where their real actions live.
 */
export function CommandDesk({
  sessions,
  apps,
  driveFiles,
  liveToolDirNames,
  workspaceName,
  onOpenChat,
  onOpenTool,
  onNavigateChats,
  onNavigateTools,
  onNavigateFiles,
  onOpenFile,
}: {
  sessions: SessionData[];
  apps: MiniAppEntry[];
  driveFiles: DriveFile[];
  liveToolDirNames: Set<string>;
  workspaceName: string;
  onOpenChat: (sessionId: string) => void;
  onOpenTool: (dirName: string) => void;
  onNavigateChats: () => void;
  onNavigateTools: () => void;
  onNavigateFiles: () => void;
  onOpenFile: (path: string) => void;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const appCards = apps.slice(0, MAX_TOOL_CARDS);
  const stubCards = AVAILABLE_TOOLS_STUB.slice(0, MAX_TOOL_CARDS - appCards.length);
  const totalTools = apps.length + AVAILABLE_TOOLS_STUB.length;
  const recentChats = sessions.slice(0, MAX_RECENT_CHATS);

  return (
    <div className="cdHome">
      <div className="cdHome__header">
        <h1 className="cdHome__title">Command desk</h1>
        <span className="cdHome__date">{headerDate(now)}</span>
        <span className="cdHome__spacer" />
        <button className="cdSearch" onClick={onNavigateChats} title="Search (⌘K)">
          <MSymbol name="search" size={17} />
          <span className="cdSearch__placeholder">Search chats, tools, files…</span>
          <span className="cdSearch__keycap">⌘K</span>
        </button>
      </div>

      <div className="cdHome__content">
        <div className="cdSectionRow">
          <span className="cdSectionLabel">
            Tools — {appCards.length + stubCards.length} of {totalTools}
          </span>
          <button className="cdTextLink" onClick={onNavigateTools}>All tools</button>
        </div>
        <div className="cdToolGrid">
          {appCards.map((app) => {
            const Icon = resolveToolIcon(app.icon);
            const live = liveToolDirNames.has(app.dirName);
            return (
              <div
                key={app.dirName}
                className="cdCard"
                role="button"
                tabIndex={0}
                onClick={() => onOpenTool(app.dirName)}
                onKeyDown={(e) => { if (e.key === 'Enter') onOpenTool(app.dirName); }}
              >
                <div className="cdCard__top">
                  <Icon className="cdCard__icon" style={{ width: 24, height: 24 }} />
                  <span className="cdCard__status">
                    <span className={`cdDot ${live ? 'cdDot--running' : 'cdDot--sleeping'}`} />
                    {live ? 'RUNNING' : 'SLEEPING'}
                  </span>
                </div>
                <div className="cdCard__title">{app.name}</div>
                <div className="cdCard__desc">
                  {app.description ?? 'No description yet — open it and ask for one.'}
                </div>
                <div className="cdCard__footer">
                  <button
                    className="cdBtnXs"
                    onClick={(e) => { e.stopPropagation(); onOpenTool(app.dirName); }}
                  >
                    Open
                  </button>
                  <span className="cdCard__metric">
                    {app.lastOpened ? `LAST ${relTimeShort(app.lastOpened)}` : app.preBuilt ? 'PRE-BUILT' : 'NEW'}
                  </span>
                </div>
              </div>
            );
          })}
          {stubCards.map((stub) => {
            const Icon = resolveToolIcon(null);
            return (
              <div
                key={`stub:${stub.name}`}
                className="cdCard"
                role="button"
                tabIndex={0}
                onClick={onNavigateTools}
                onKeyDown={(e) => { if (e.key === 'Enter') onNavigateTools(); }}
              >
                <div className="cdCard__top">
                  <Icon className="cdCard__icon" style={{ width: 24, height: 24 }} />
                  <span className="cdCard__status">{stub.tag}</span>
                </div>
                <div className="cdCard__title">{stub.name}</div>
                <div className="cdCard__desc">{stub.description}</div>
                <div className="cdCard__footer">
                  <button
                    className="cdBtnXs"
                    onClick={(e) => { e.stopPropagation(); onNavigateTools(); }}
                  >
                    Open
                  </button>
                  <span className="cdCard__metric">PRE-BUILT</span>
                </div>
              </div>
            );
          })}
          <div
            className="cdCard cdCard--new"
            role="button"
            tabIndex={0}
            onClick={focusComposer}
            onKeyDown={(e) => { if (e.key === 'Enter') focusComposer(); }}
          >
            <MSymbol name="add" size={22} />
            <span className="cdCard__newTitle">Build a new tool</span>
            <span className="cdCard__newSub">Describe it below — ACABOX scaffolds it</span>
          </div>
        </div>

        <div className="cdLowerGrid">
          <div>
            <div className="cdSectionRow">
              <span className="cdSectionLabel">Jump back in</span>
              <button className="cdTextLink" onClick={onNavigateChats}>
                All chats · {sessions.length}
              </button>
            </div>
            <div className="cdListCard">
              {recentChats.length === 0 ? (
                <div className="cdListCard__empty">No chats yet — start one below.</div>
              ) : (
                recentChats.map((chat) => (
                  <button key={chat.id} className="cdListRow" onClick={() => onOpenChat(chat.id)}>
                    <MSymbol name="chat_bubble" size={16} />
                    <span className="cdListRow__title">{chat.title}</span>
                    <span className="cdListRow__meta">{relTimeShort(chat.updated_at)}</span>
                  </button>
                ))
              )}
            </div>
          </div>

          <div>
            <div className="cdSectionRow">
              <span className="cdSectionLabel">Drive — ~/{workspaceName}</span>
              <button className="cdTextLink" onClick={onNavigateFiles}>Browse</button>
            </div>
            <div className="cdListCard">
              {driveFiles.length === 0 ? (
                <div className="cdListCard__empty">No files yet — share a folder in Settings.</div>
              ) : (
                driveFiles.map((file) => (
                  <button key={file.path} className="cdListRow" onClick={() => onOpenFile(file.path)}>
                    <MSymbol name={driveIconFor(file.relPath)} size={16} />
                    <span className="cdListRow__mono">{file.relPath}</span>
                    <span className="cdListRow__meta cdListRow__meta--small">{formatSize(file.size)}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
