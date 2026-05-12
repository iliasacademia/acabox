import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAssistantRuntime } from '@assistant-ui/react';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  TrashIcon,
  ZapIcon,
  CheckCircleIcon,
  CircleIcon,
  SettingsIcon,
  PowerOffIcon,
} from 'lucide-react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './ui/collapsible';
import { dateFromSessionStoredAt } from '../sessionTimestamps';

type FilterMode = 'all' | 'reactions' | 'system';

const SCHEDULE_OPTIONS = [
  { label: 'Every 5 minutes', cron: '*/5 * * * *' },
  { label: 'Every 10 minutes', cron: '*/10 * * * *' },
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Every 30 minutes', cron: '*/30 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
];

function cronToLabel(cron: string): string {
  return SCHEDULE_OPTIONS.find((o) => o.cron === cron)?.label ?? cron;
}

function formatDate(iso: string): string {
  const date = dateFromSessionStoredAt(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
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
    const poll = async () => {
      const status = await window.browserMonitorAPI.status();
      setServerRunning(status.serverRunning);
      setExtensionConnected(status.extensionConnected);
      if (status.extensionConnected && !activatingRef.current) {
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

            <div className="reactionsOnboarding__step">
              <div className="reactionsOnboarding__stepNumber">
                {extensionConnected
                  ? <CheckCircleIcon style={{ width: 20, height: 20, color: '#4a9' }} />
                  : <CircleIcon style={{ width: 20, height: 20, color: '#b5aea4' }} />}
              </div>
              <div className="reactionsOnboarding__stepContent">
                <div className="reactionsOnboarding__stepTitle">Install the Chrome extension</div>
                <p className="reactionsOnboarding__stepDesc">
                  Install the Reactions extension from the Chrome Web Store, then open it in your browser.
                </p>
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
                {extensionConnected && (
                  <span className="reactionsOnboarding__done" style={{ marginLeft: 12 }}>Connected</span>
                )}
              </div>
            </div>
          </div>

          {serverRunning && !extensionConnected && (
            <p className="reactionsOnboarding__waiting">
              Waiting for the Chrome extension to connect...
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
  const [filter, setFilter] = useState<FilterMode>('all');
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  const handleDelete = useCallback(async (id: string) => {
    await window.sessionsAPI.delete(id);
    load();
  }, [load]);

  const showReactions = filter === 'all' || filter === 'reactions';
  const showSystem = filter === 'all' || filter === 'system';

  const renderThreadList = (items: SessionData[]) => (
    <div className="threadListItems">
      {items.length === 0 && (
        <div className="reactionsView__empty">No threads yet</div>
      )}
      {items.map((r) => (
        <div key={r.id} className="threadListItem">
          <button
            className="threadListItemTrigger"
            onClick={() => runtime.threads.switchToThread(r.id)}
          >
            <span className="threadListItemTitle">
              <span className="threadListItemTitleText">{r.title}</span>
              <span className="threadListItemDate">{formatDate(r.created_at)}</span>
            </span>
          </button>
          <button
            className="threadListItemAction threadListItemDelete"
            onClick={() => handleDelete(r.id)}
          >
            <TrashIcon style={{ width: 14, height: 14 }} />
          </button>
        </div>
      ))}
    </div>
  );

  return (
    <div className="reactionsView">
      <div className="reactionsView__scroll">
        <button className="paperMonitor__topBack" onClick={onBack}>
          <ChevronLeftIcon style={{ width: 14, height: 14 }} />
          Back to Tools
        </button>

        <div className="paperMonitor__crumbs">
          <ZapIcon style={{ width: 13, height: 13 }} />
          <span>TOOLS</span>
          <span>&middot;</span>
          <span>REACTIONS</span>
        </div>

        <h1 className="paperMonitor__title">Reactions</h1>
        <p className="paperMonitor__subtitle">
          AI-powered insights based on your browser and file activity.
        </p>

        <div className="paperMonitor__filtersRow">
          <div className="paperMonitor__filters">
            {(['all', 'reactions', 'system'] as FilterMode[]).map((f) => (
              <button
                key={f}
                className={`paperMonitor__filterPill${filter === f ? ' paperMonitor__filterPill--active' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
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

        <div className="reactionsView__threads">
          {showReactions && (
            <Collapsible defaultOpen>
              <CollapsibleTrigger className="reactionsSectionHeader">
                <ChevronRightIcon className="reactionsSectionChevron" />
                Reactions
              </CollapsibleTrigger>
              <CollapsibleContent>
                {renderThreadList(userReactions)}
              </CollapsibleContent>
            </Collapsible>
          )}
          {showSystem && (
            <Collapsible defaultOpen>
              <CollapsibleTrigger className="reactionsSectionHeader">
                <ChevronRightIcon className="reactionsSectionChevron" />
                System
              </CollapsibleTrigger>
              <CollapsibleContent>
                {renderThreadList(systemReactions)}
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </div>
    </div>
  );
}

function ReactionsSettings({ onDisable }: { onDisable: () => void }) {
  const [schedule, setSchedule] = useState('*/15 * * * *');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [savedPrompt, setSavedPrompt] = useState('');
  const [sources, setSources] = useState<string[]>(['browser', 'file']);
  const [disabling, setDisabling] = useState(false);

  useEffect(() => {
    window.scheduledTasksAPI.list().then((tasks) => {
      const reactionsTask = tasks.find((t) => t.session_source === 'reactions-system');
      if (reactionsTask) {
        setTaskId(reactionsTask.id);
        setSchedule(reactionsTask.cron_expression);
      }
    });
    window.reactionPromptAPI.get().then((result) => {
      const val = result.instructions ?? '';
      setPrompt(val);
      setSavedPrompt(val);
    });
    window.reactionSourcesAPI.get().then(setSources);
  }, []);

  const handleScheduleChange = useCallback(async (cron: string) => {
    setSchedule(cron);
    if (taskId) {
      await window.scheduledTasksAPI.update(taskId, { cron_expression: cron });
    }
  }, [taskId]);

  const handleSavePrompt = useCallback(async () => {
    if (prompt.trim()) {
      await window.reactionPromptAPI.set(prompt.trim());
    } else {
      await window.reactionPromptAPI.reset();
    }
    setSavedPrompt(prompt);
  }, [prompt]);

  const handleSourceToggle = useCallback(async (source: string) => {
    const next = sources.includes(source)
      ? sources.filter((s) => s !== source)
      : [...sources, source];
    if (next.length === 0) return;
    setSources(next);
    await window.reactionSourcesAPI.set(next);
  }, [sources]);

  const handleDisable = useCallback(async () => {
    setDisabling(true);
    try {
      await window.settingsAPI.setReactionsEnabled(false);
      onDisable();
    } finally {
      setDisabling(false);
    }
  }, [onDisable]);

  const promptDirty = prompt !== savedPrompt;

  return (
    <div className="reactionsSettings">
      <div className="reactionsSettings__section">
        <label className="reactionsSettings__label">Schedule</label>
        <select
          className="reactionsSettings__select"
          value={schedule}
          onChange={(e) => handleScheduleChange(e.target.value)}
        >
          {SCHEDULE_OPTIONS.map((opt) => (
            <option key={opt.cron} value={opt.cron}>{opt.label}</option>
          ))}
        </select>
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
        {promptDirty && (
          <div className="reactionsSettings__actions">
            <button
              className="reactionsSettings__cancelBtn"
              onClick={() => setPrompt(savedPrompt)}
            >
              Cancel
            </button>
            <button
              className="reactionsSettings__saveBtn"
              onClick={handleSavePrompt}
            >
              Save
            </button>
          </div>
        )}
      </div>

      <div className="reactionsSettings__section reactionsSettings__section--danger">
        <button
          className="reactionsSettings__disableBtn"
          onClick={handleDisable}
          disabled={disabling}
        >
          <PowerOffIcon style={{ width: 14, height: 14 }} />
          {disabling ? 'Disabling...' : 'Disable Reactions'}
        </button>
      </div>
    </div>
  );
}
