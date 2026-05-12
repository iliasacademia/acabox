import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAssistantRuntime } from '@assistant-ui/react';
import {
  ChevronLeftIcon,
  MessageSquareIcon,
  MoreVerticalIcon,
  TrashIcon,
  ZapIcon,
  CheckCircleIcon,
  CircleIcon,
  SettingsIcon,
  PlayIcon,
  PowerOffIcon,
} from 'lucide-react';
import { DropdownMenu, AlertDialog } from 'radix-ui';
import { dateFromSessionStoredAt } from '../sessionTimestamps';
import { formatRelativeDate as formatRelativeDateFromDate } from '../../../shared/utils';

type FilterMode = 'reactions' | 'system';

const SCHEDULE_OPTIONS = [
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Every 30 minutes', cron: '*/30 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 2 hours', cron: '0 */2 * * *' },
];

function nextRunLabel(cron: string): string {
  try {
    const { CronExpressionParser } = require('cron-parser');
    const interval = CronExpressionParser.parse(cron);
    const next = new Date(interval.next().toISOString());
    return next.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatDate(iso: string): string {
  const date = dateFromSessionStoredAt(iso);
  if (Number.isNaN(date.getTime())) return '';
  return formatRelativeDateFromDate(date);
}

function useMessagePreview(sessionId: string): string {
  const [preview, setPreview] = useState('');
  useEffect(() => {
    window.sessionsAPI.listMessages(sessionId).then((messages) => {
      const firstUser = messages.find((m: any) => m.type === 'user');
      let userText = '';
      if (firstUser) {
        try {
          const parsed = JSON.parse(firstUser.content);
          userText = (typeof parsed.text === 'string' ? parsed.text : firstUser.content)
            .split('\n')[0].slice(0, 120);
        } catch {
          userText = firstUser.content.split('\n')[0].slice(0, 120);
        }
      }
      const firstAssistant = messages.find((m: any) => m.type === 'assistant');
      let assistantText = '';
      if (firstAssistant) {
        try {
          const blocks = JSON.parse(firstAssistant.content);
          const textBlock = Array.isArray(blocks) ? blocks.find((b: any) => b.type === 'text') : null;
          if (textBlock?.text) assistantText = textBlock.text.split('\n')[0].slice(0, 120);
        } catch {
          assistantText = firstAssistant.content.split('\n')[0].slice(0, 120);
        }
      }
      const parts = [
        userText ? `You: ${userText}` : '',
        assistantText ? `CS: ${assistantText}` : '',
      ].filter(Boolean);
      setPreview(parts.join(' · '));
    }).catch(() => {});
  }, [sessionId]);
  return preview;
}

export function ReactionsToolView({ onBack }: { onBack: () => void }) {
  const [phase, setPhase] = useState<'loading' | 'onboarding' | 'main'>('loading');
  const [serverRunning, setServerRunning] = useState(false);
  const [extensionConnected, setExtensionConnected] = useState(false);
  const [startingServer, setStartingServer] = useState(false);
  const activatingRef = useRef(false);

  useEffect(() => {
    window.settingsAPI.getReactionsEnabled().then((enabled) => {
      setPhase(enabled ? 'main' : 'onboarding');
    });
  }, []);

  // Poll for extension connection during onboarding
  useEffect(() => {
    if (phase !== 'onboarding') return;
    activatingRef.current = false;
    const poll = async () => {
      const status = await window.browserMonitorAPI.status();
      setServerRunning(status.serverRunning);
      setExtensionConnected(status.extensionConnected);
      if (status.serverRunning && status.extensionConnected && !activatingRef.current) {
        activatingRef.current = true;
        await window.settingsAPI.setReactionsEnabled(true);
        setPhase('main');
      }
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [phase]);

  const handleStartServer = useCallback(async () => {
    setStartingServer(true);
    try {
      await window.browserMonitorAPI.start();
      setServerRunning(true);
    } finally {
      setStartingServer(false);
    }
  }, []);

  if (phase === 'loading') {
    return (
      <div className="reactionsView">
        <div className="reactionsView__scroll">
          <button className="paperMonitor__topBack" onClick={onBack}>
            <ChevronLeftIcon style={{ width: 14, height: 14 }} />
            Back to Tools
          </button>
          <p style={{ color: '#7a746a', fontFamily: "'DM Sans', sans-serif", fontSize: '0.875rem' }}>Loading...</p>
        </div>
      </div>
    );
  }

  if (phase === 'onboarding') {
    return (
      <div className="reactionsView">
        <div className="reactionsView__scroll">
          <button className="paperMonitor__topBack" onClick={onBack}>
            <ChevronLeftIcon style={{ width: 14, height: 14 }} />
            Back to Tools
          </button>

          <div className="reactionsOnboarding__icon">
            <ZapIcon style={{ width: 28, height: 28 }} />
          </div>

          <h1 className="paperMonitor__title">Set up Reactions</h1>
          <p className="paperMonitor__subtitle">
            Reactions monitors your browser and file activity, then periodically generates AI-powered suggestions and insights based on what you&rsquo;re working on.
          </p>

          <div className="reactionsOnboarding__steps">
            <div className="reactionsOnboarding__step">
              <div className="reactionsOnboarding__stepNumber">
                {extensionConnected
                  ? <CheckCircleIcon style={{ width: 20, height: 20, color: '#4a9' }} />
                  : <CircleIcon style={{ width: 20, height: 20, color: '#b5aea4' }} />}
              </div>
              <div className="reactionsOnboarding__stepContent">
                <div className="reactionsOnboarding__stepTitle">Install the Chrome extension</div>
                <p className="reactionsOnboarding__stepDesc">
                  Install the Reactions extension from the Chrome Web Store.
                </p>
                <div className="reactionsOnboarding__btnRow">
                  <a
                    className="reactionsOnboarding__btn"
                    href="https://chromewebstore.google.com/detail/reactions/mallkjfjbpiopblplmpcnfppmpcmnkhd"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => {
                      e.preventDefault();
                      (window as { electronAPI?: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> } })
                        .electronAPI?.invoke('shell:openExternal', 'https://chromewebstore.google.com/detail/reactions/mallkjfjbpiopblplmpcnfppmpcmnkhd');
                    }}
                  >
                    Open Chrome Web Store
                  </a>
                  {!extensionConnected && serverRunning && (
                    <button
                      className="reactionsOnboarding__btnSecondary"
                      onClick={() => {}}
                      style={{ visibility: 'hidden' }}
                    />
                  )}
                </div>
                {extensionConnected && (
                  <span className="reactionsOnboarding__done">Extension connected</span>
                )}
              </div>
            </div>

            <div className="reactionsOnboarding__step">
              <div className="reactionsOnboarding__stepNumber">
                {serverRunning
                  ? <CheckCircleIcon style={{ width: 20, height: 20, color: '#4a9' }} />
                  : <CircleIcon style={{ width: 20, height: 20, color: '#b5aea4' }} />}
              </div>
              <div className="reactionsOnboarding__stepContent">
                <div className="reactionsOnboarding__stepTitle">Start the browser extension server</div>
                <p className="reactionsOnboarding__stepDesc">
                  This starts a local server that communicates with the Chrome extension.
                </p>
                {!serverRunning && (
                  <button
                    className="reactionsOnboarding__btn"
                    onClick={handleStartServer}
                    disabled={startingServer}
                  >
                    {startingServer ? 'Starting...' : 'Start server'}
                  </button>
                )}
                {serverRunning && (
                  <span className="reactionsOnboarding__done">Server running</span>
                )}
              </div>
            </div>
          </div>

          {serverRunning && !extensionConnected && (
            <p className="reactionsOnboarding__waiting">
              Waiting for the Chrome extension to connect&hellip;
              <br />
              <button
                className="reactionsOnboarding__alreadyInstalled"
                onClick={() => {}}
                style={{ visibility: 'hidden' }}
              />
              If you&rsquo;ve already installed the extension, make sure it&rsquo;s enabled and refresh the page.
            </p>
          )}

          {!serverRunning && !extensionConnected && (
            <p className="reactionsOnboarding__hint">
              Already have the extension? Start the server above and it will connect automatically.
            </p>
          )}
        </div>
      </div>
    );
  }

  return <ReactionsMainView onBack={onBack} onDisable={() => setPhase('onboarding')} />;
}

function ReactionsMainView({ onBack, onDisable }: { onBack: () => void; onDisable: () => void }) {
  const [userReactions, setUserReactions] = useState<SessionData[]>([]);
  const [systemReactions, setSystemReactions] = useState<SessionData[]>([]);
  const [filter, setFilter] = useState<FilterMode>('reactions');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [schedule, setSchedule] = useState('*/15 * * * *');
  const runtime = useAssistantRuntime();

  const load = useCallback(() => {
    window.sessionsAPI.list('reactions').then(setUserReactions);
    window.sessionsAPI.list('reactions-system').then(setSystemReactions);
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, [load]);

  // Load schedule for empty state message
  useEffect(() => {
    window.scheduledTasksAPI.list().then((tasks) => {
      const reactionsTask = tasks.find((t) => t.session_source === 'reactions-system');
      if (reactionsTask) setSchedule(reactionsTask.cron_expression);
    });
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    await window.sessionsAPI.delete(id);
    if (selectedId === id) setSelectedId(null);
    load();
  }, [load, selectedId]);

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    runtime.threads.switchToThread(id);
  }, [runtime]);

  const visibleItems: SessionData[] = (filter === 'reactions' ? userReactions : systemReactions)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

  const count = visibleItems.length;
  const latestId = visibleItems[0]?.id;
  const prevFilterRef = useRef(filter);

  useEffect(() => {
    if (!latestId) return;
    const filterChanged = prevFilterRef.current !== filter;
    prevFilterRef.current = filter;
    if (filterChanged) {
      setSelectedId(latestId);
      runtime.threads.switchToThread(latestId);
    }
  }, [filter, latestId, runtime]);

  const initialLoadRef = useRef(false);
  useEffect(() => {
    if (initialLoadRef.current || !latestId) return;
    initialLoadRef.current = true;
    setSelectedId(latestId);
    runtime.threads.switchToThread(latestId);
  }, [latestId, runtime]);

  const nextTime = nextRunLabel(schedule);

  return (
    <div className="reactionsView">
      <div className="reactionsView__scroll">
        <button className="paperMonitor__topBack" onClick={onBack}>
          <ChevronLeftIcon style={{ width: 14, height: 14 }} />
          Back to Tools
        </button>

        <div className="pageShell__headerBlock">
          <div className="pageShell__stats">
            {count} REACTION{count !== 1 ? 'S' : ''}
          </div>
          <h1 className="pageShell__title">Reactions</h1>
          <p className="pageShell__subtitle">
            AI-powered insights based on your browser and file activity.
          </p>
        </div>

        <div className="paperMonitor__filtersRow">
          <div className="paperMonitor__filters">
            {(['reactions', 'system'] as FilterMode[]).map((f) => (
              <button
                key={f}
                className={`paperMonitor__filterPill${filter === f ? ' paperMonitor__filterPill--active' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          <button
            className={`reactionsView__settingsToggle${settingsOpen ? ' reactionsView__settingsToggle--active' : ''}`}
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            <SettingsIcon style={{ width: 14, height: 14 }} />
            Settings
          </button>
        </div>

        {settingsOpen && <ReactionsSettings onDisable={onDisable} />}

        <div className="chatListItems">
          {visibleItems.length === 0 && (
            <div className="reactionsView__empty">
              <p>No reactions yet.</p>
              <p className="reactionsView__emptyHint">
                Use your browser normally and reactions will appear here.
                {nextTime && <> Next reaction at <strong>{nextTime}</strong>.</>}
              </p>
            </div>
          )}
          {visibleItems.map((r) => (
            <ReactionThreadItem
              key={r.id}
              session={r}
              selected={r.id === selectedId}
              onSelect={() => handleSelect(r.id)}
              onDelete={() => handleDelete(r.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ReactionThreadItem({
  session,
  selected,
  onSelect,
  onDelete,
}: {
  session: SessionData;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const preview = useMessagePreview(session.id);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const sourceLabel = session.source === 'reactions-system' ? 'System' : 'Reaction';

  return (
    <div className={`chatListItem${selected ? ' chatListItem--selected' : ''}`}>
      <div className="chatListItemIcon">
        <MessageSquareIcon style={{ width: 18, height: 18 }} />
      </div>
      <button className="chatListItemTrigger" onClick={onSelect}>
        <span className="chatListItemTitle">{session.title || 'Untitled'}</span>
        {preview && <span className="chatListItemPreview">{preview}</span>}
      </button>
      <div className="chatListItemMeta">
        <span className="chatListItemDate">{formatDate(session.created_at)}</span>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="chatListItemMenuBtn" onClick={(e) => e.stopPropagation()}>
              <MoreVerticalIcon style={{ width: 16, height: 16 }} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="chatListDropdown" sideOffset={4} align="end">
              <DropdownMenu.Item
                className="chatListDropdownItem chatListDropdownItem--danger"
                onSelect={() => setDeleteOpen(true)}
              >
                <TrashIcon style={{ width: 14, height: 14 }} />
                Delete
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      <AlertDialog.Root open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="chatListModalOverlay" />
          <AlertDialog.Content className="chatListModal">
            <AlertDialog.Title className="chatListModalTitle">Delete {sourceLabel.toLowerCase()}</AlertDialog.Title>
            <AlertDialog.Description className="chatListModalDesc">
              Are you sure you want to delete &ldquo;{session.title}&rdquo;? This action cannot be undone.
            </AlertDialog.Description>
            <div className="chatListModalActions">
              <AlertDialog.Cancel asChild>
                <button className="chatListModalBtn chatListModalBtn--secondary">Cancel</button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button className="chatListModalBtn chatListModalBtn--danger" onClick={onDelete}>
                  Delete
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}

function ReactionsSettings({ onDisable }: { onDisable: () => void }) {
  const [schedule, setSchedule] = useState('*/15 * * * *');
  const [savedSchedule, setSavedSchedule] = useState('*/15 * * * *');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [savedPrompt, setSavedPrompt] = useState('');
  const [sources, setSources] = useState<string[]>(['browser', 'file']);
  const [savedSources, setSavedSources] = useState<string[]>(['browser', 'file']);
  const [disabling, setDisabling] = useState(false);
  const [disableConfirmOpen, setDisableConfirmOpen] = useState(false);
  const [runningNow, setRunningNow] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    window.scheduledTasksAPI.list().then((tasks) => {
      const reactionsTask = tasks.find((t) => t.session_source === 'reactions-system');
      if (reactionsTask) {
        setTaskId(reactionsTask.id);
        setSchedule(reactionsTask.cron_expression);
        setSavedSchedule(reactionsTask.cron_expression);
      }
    });
    window.reactionPromptAPI.get().then((result) => {
      const val = result.instructions ?? '';
      setPrompt(val);
      setSavedPrompt(val);
    });
    window.reactionSourcesAPI.get().then((s) => {
      setSources(s);
      setSavedSources(s);
    });
  }, []);

  const handleSourceToggle = useCallback((source: string) => {
    setSources((prev) => {
      const next = prev.includes(source)
        ? prev.filter((s) => s !== source)
        : [...prev, source];
      return next.length === 0 ? prev : next;
    });
  }, []);

  const handleRunNow = useCallback(async () => {
    if (!taskId) return;
    setRunningNow(true);
    try {
      await window.scheduledTasksAPI.runNow(taskId);
    } finally {
      setRunningNow(false);
    }
  }, [taskId]);

  const handleDisable = useCallback(async () => {
    setDisabling(true);
    try {
      await window.settingsAPI.setReactionsEnabled(false);
      onDisable();
    } finally {
      setDisabling(false);
      setDisableConfirmOpen(false);
    }
  }, [onDisable]);

  const dirty = schedule !== savedSchedule
    || prompt !== savedPrompt
    || JSON.stringify(sources) !== JSON.stringify(savedSources);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      if (schedule !== savedSchedule && taskId) {
        await window.scheduledTasksAPI.update(taskId, { cron_expression: schedule });
        setSavedSchedule(schedule);
      }
      if (prompt !== savedPrompt) {
        if (prompt.trim()) {
          await window.reactionPromptAPI.set(prompt.trim());
        } else {
          await window.reactionPromptAPI.reset();
        }
        setSavedPrompt(prompt);
      }
      if (JSON.stringify(sources) !== JSON.stringify(savedSources)) {
        await window.reactionSourcesAPI.set(sources);
        setSavedSources([...sources]);
      }
    } finally {
      setSaving(false);
    }
  }, [schedule, savedSchedule, prompt, savedPrompt, sources, savedSources, taskId]);

  const handleCancel = useCallback(() => {
    setSchedule(savedSchedule);
    setPrompt(savedPrompt);
    setSources([...savedSources]);
  }, [savedSchedule, savedPrompt, savedSources]);

  return (
    <div className="reactionsSettings">
      <div className="reactionsSettings__section">
        <label className="reactionsSettings__label">Schedule</label>
        <div className="reactionsSettings__scheduleRow">
          <select
            className="reactionsSettings__select"
            value={schedule}
            onChange={(e) => setSchedule(e.target.value)}
          >
            {SCHEDULE_OPTIONS.map((opt) => (
              <option key={opt.cron} value={opt.cron}>{opt.label}</option>
            ))}
          </select>
          <button
            className="reactionsSettings__runNowBtn"
            onClick={handleRunNow}
            disabled={!taskId || runningNow}
          >
            <PlayIcon style={{ width: 12, height: 12 }} />
            {runningNow ? 'Running...' : 'Run now'}
          </button>
        </div>
      </div>

      <div className="reactionsSettings__section">
        <label className="reactionsSettings__label">Activity sources</label>
        <div className="reactionsSettings__checkboxes">
          <label className="reactionsSettings__checkbox">
            <input
              type="checkbox"
              checked={sources.includes('browser')}
              onChange={() => handleSourceToggle('browser')}
            />
            Browser activity
          </label>
          <label className="reactionsSettings__checkbox">
            <input
              type="checkbox"
              checked={sources.includes('file')}
              onChange={() => handleSourceToggle('file')}
            />
            File activity
          </label>
        </div>
      </div>

      <div className="reactionsSettings__section">
        <label className="reactionsSettings__label">Focus prompt</label>
        <textarea
          className="reactionsSettings__textarea"
          placeholder="Optionally guide what reactions should focus on..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
        />
      </div>

      {dirty && (
        <div className="reactionsSettings__saveRow">
          <button
            className="reactionsSettings__cancelBtn"
            onClick={handleCancel}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            className="reactionsSettings__saveBtn"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      )}

      <div className="reactionsSettings__section reactionsSettings__section--danger">
        <button
          className="reactionsSettings__disableBtn"
          onClick={() => setDisableConfirmOpen(true)}
          disabled={disabling}
        >
          <PowerOffIcon style={{ width: 14, height: 14 }} />
          Disable Reactions
        </button>
      </div>

      <AlertDialog.Root open={disableConfirmOpen} onOpenChange={setDisableConfirmOpen}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="chatListModalOverlay" />
          <AlertDialog.Content className="chatListModal">
            <AlertDialog.Title className="chatListModalTitle">Disable Reactions</AlertDialog.Title>
            <AlertDialog.Description className="chatListModalDesc">
              This will stop the browser extension server and disable the scheduled reaction task. Your existing reactions will be kept. You can re-enable reactions at any time.
            </AlertDialog.Description>
            <div className="chatListModalActions">
              <AlertDialog.Cancel asChild>
                <button className="chatListModalBtn chatListModalBtn--secondary">Cancel</button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button className="chatListModalBtn chatListModalBtn--danger" onClick={handleDisable}>
                  {disabling ? 'Disabling...' : 'Disable'}
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}
