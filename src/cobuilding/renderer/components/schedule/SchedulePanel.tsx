import React, { useCallback, useEffect, useState } from 'react';
import { MSymbol } from '../command-desk/MSymbol';
import {
  intervalToCron, cronToInterval, validateInterval, cronToHuman, snapIntervalToUnit,
  type ScheduleUnit,
} from './scheduleCron';
import type { ScheduledTask, ScheduledTaskRun } from '../../../shared/types';

/**
 * The scheduler, surfaced at last.
 *
 * The backend has been complete and RUNNING this whole time — `startScheduledTasks`
 * at `main/index.ts`, eight IPC channels, its own `scheduling.db` with run
 * history. The only thing missing was a way to see it: `ScheduledTaskEditor.tsx`
 * (372 lines) and `ScheduledTasksSidebar.tsx` (122 lines) existed and were
 * imported nowhere. Both are deleted; their cron translation lives on in
 * `scheduleCron.ts`, which now has tests it never had.
 *
 * It lands on Activity rather than in its own nav slot because a schedule and
 * the output it produces are the same subject: Activity is already the page
 * that answers "what happened while I wasn't watching", and these tasks are
 * what produce that. The counter-argument is real and recorded in the design
 * doc (nobody hunting for "automations" looks under Activity) — if that turns
 * out to bite, the fix is a rail entry pointing here, not a second home.
 *
 * A scheduled task runs through the same `createAgentSession` path as a chat
 * turn, so it has the identical MCP surface — hosted servers included — and
 * `mcp__notification__show_notification` is already always-allowed. "Notify me
 * when the overnight check finds something" needs no new backend.
 */

const UNITS: { value: ScheduleUnit; label: string }[] = [
  { value: 'minutes', label: 'minutes' },
  { value: 'hours', label: 'hours' },
  { value: 'days', label: 'days' },
];

/** A run's status as something a person would say. Never invents an outcome. */
function runOutcome(run: ScheduledTaskRun): { text: string; tone: 'good' | 'bad' | 'unknown' } {
  switch (run.status) {
    case 'completed': return { text: 'Finished', tone: 'good' };
    case 'failed': return { text: run.error ? `Failed — ${run.error}` : 'Failed', tone: 'bad' };
    case 'running': return { text: 'Running now', tone: 'unknown' };
    default: return { text: run.status, tone: 'unknown' };
  }
}

function whenText(iso: string | null): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'never';
  const mins = Math.round((Date.now() - t) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function nextText(iso: string | null): string {
  if (!iso) return 'not scheduled';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'not scheduled';
  const mins = Math.round((t - Date.now()) / 60_000);
  if (mins <= 0) return 'due now';
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/* ------------------------------------------------------------------ list -- */

/**
 * The "On a schedule" section for ActivityPanel. Unlike the other sections on
 * that page it is rendered even when empty — the others signal news, this one
 * is also the only place the feature can be discovered, and a heading that
 * disappears when there is nothing scheduled can never teach anyone that
 * scheduling exists.
 */
export function ScheduleSection({
  tasks,
  onOpen,
  onNew,
  onToggle,
}: {
  tasks: ScheduledTask[];
  onOpen: (id: string) => void;
  onNew: () => void;
  onToggle: (task: ScheduledTask) => void;
}) {
  return (
    <section className="cdActivity__section">
      <div className="scheduleSection__head">
        <div className="cdSectionLabel">On a schedule</div>
        <button className="cdBtnXs" onClick={onNew}>New task</button>
      </div>

      {tasks.length === 0 && (
        <div className="scheduleSection__empty">Nothing is scheduled.</div>
      )}

      {tasks.map((task) => {
        const off = task.enabled === 0;
        return (
          <div key={task.id} className={`cdActivityRow${off ? ' scheduleRow--off' : ''}`}>
            <MSymbol name="schedule" size={16} />
            <div className="cdActivityRow__main">
              <div className="cdActivityRow__title">{task.name}</div>
              <div className="cdActivityRow__sub">
                {cronToHuman(task.cron_expression)}
                {off
                  ? ' · paused'
                  : ` · last ran ${whenText(task.last_run_at)} · next ${nextText(task.next_run_at)}`}
              </div>
            </div>
            <button className="cdBtnXs" onClick={() => onToggle(task)}>
              {off ? 'Resume' : 'Pause'}
            </button>
            <button className="cdBtnXs" onClick={() => onOpen(task.id)}>Open</button>
          </div>
        );
      })}
    </section>
  );
}

/* ----------------------------------------------------------------- panel -- */

/**
 * Right-docked editor, the same shape as the Servers detail panel — not a
 * modal, because the run history underneath keeps updating, and not a route,
 * because the shell has no router.
 */
export function SchedulePanel({
  taskId,
  onClose,
  onChanged,
}: {
  /** `null` = compose a new task. */
  taskId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const isNew = taskId === null;

  const [task, setTask] = useState<ScheduledTask | null>(null);
  const [runs, setRuns] = useState<ScheduledTaskRun[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [interval, setInterval] = useState(1);
  const [unit, setUnit] = useState<ScheduleUnit>('hours');
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);

  useEffect(() => {
    if (!taskId) {
      setTask(null); setName(''); setDescription(''); setPrompt('');
      setInterval(1); setUnit('hours'); setRuns([]);
      return;
    }
    let live = true;
    window.scheduledTasksAPI.get(taskId).then((t) => {
      if (!live || !t) return;
      setTask(t);
      setName(t.name);
      setDescription(t.description);
      setPrompt(t.prompt);
      const parsed = cronToInterval(t.cron_expression);
      setInterval(parsed.interval);
      setUnit(parsed.unit);
    }).catch(() => {});
    window.scheduledTasksAPI.listRuns(taskId).then((r) => { if (live) setRuns(r); }).catch(() => {});
    return () => { live = false; };
  }, [taskId]);

  const cronExpression = intervalToCron(interval, unit);
  const intervalError = validateInterval(interval, unit);
  // A system task (the Reactions cron) owns its own name and prompt; only its
  // cadence is the user's to change.
  const isSystemTask = task?.session_source === 'reactions-system';
  const missingFields = !isSystemTask && (!name.trim() || !prompt.trim());
  const canSave = !intervalError && !missingFields && !saving;

  const changeUnit = useCallback((next: ScheduleUnit) => {
    setUnit(next);
    setInterval((cur) => snapIntervalToUnit(cur, next));
  }, []);

  const save = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      if (isNew) {
        await window.scheduledTasksAPI.create({
          name: name.trim(),
          description: description.trim(),
          prompt: prompt.trim(),
          cron_expression: cronExpression,
        });
      } else if (isSystemTask) {
        await window.scheduledTasksAPI.update(taskId!, { cron_expression: cronExpression });
      } else {
        await window.scheduledTasksAPI.update(taskId!, {
          name: name.trim(),
          description: description.trim(),
          prompt: prompt.trim(),
          cron_expression: cronExpression,
        });
      }
      onChanged();
      onClose();
    } finally {
      setSaving(false);
    }
  }, [canSave, isNew, isSystemTask, taskId, name, description, prompt, cronExpression, onChanged, onClose]);

  const runNow = useCallback(async () => {
    if (!taskId) return;
    setRunning(true);
    try {
      await window.scheduledTasksAPI.runNow(taskId);
      setRuns(await window.scheduledTasksAPI.listRuns(taskId));
      onChanged();
    } finally {
      setRunning(false);
    }
  }, [taskId, onChanged]);

  const remove = useCallback(async () => {
    if (!taskId) return;
    await window.scheduledTasksAPI.delete(taskId);
    setPendingDelete(false);
    onChanged();
    onClose();
  }, [taskId, onChanged, onClose]);

  return (
    <div className="schedulePanel">
      <div className="schedulePanel__header">
        <MSymbol name="schedule" size={18} />
        <div className="schedulePanel__title">
          {isNew ? 'New scheduled task' : isSystemTask ? task!.name : 'Scheduled task'}
        </div>
        <button className="cdBtnXs" onClick={onClose} title="Close">Close</button>
      </div>

      <div className="schedulePanel__body">
        {!isSystemTask && (
          <>
            <div className="connectorField">
              <label className="connectorField__label" htmlFor="sched-name">Name</label>
              <input
                id="sched-name"
                className="connectorField__input"
                value={name}
                placeholder="Overnight data check"
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="connectorField">
              <label className="connectorField__label" htmlFor="sched-desc">Description</label>
              <input
                id="sched-desc"
                className="connectorField__input"
                value={description}
                placeholder="Optional — a note to your future self"
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            <div className="connectorField">
              <label className="connectorField__label" htmlFor="sched-prompt">
                What should Claude do?
              </label>
              <textarea
                id="sched-prompt"
                className="connectorField__input schedulePanel__prompt"
                value={prompt}
                rows={6}
                placeholder={
                  'Check the files in ~/Data for new results and tell me if anything looks wrong.'
                }
                onChange={(e) => setPrompt(e.target.value)}
              />
              <div className="connectorField__help">
                This is sent as a chat message, on the schedule below. It can do
                anything you could ask for in a chat — read your files, run code,
                and use your servers. Ask it to notify you and it will.
              </div>
            </div>
          </>
        )}

        <div className="connectorField">
          <span className="connectorField__label">How often</span>
          <div className="scheduleIntervalRow">
            <span>Every</span>
            <input
              className="connectorField__input scheduleIntervalRow__num"
              type="number"
              min={1}
              value={Number.isFinite(interval) ? interval : ''}
              onChange={(e) => setInterval(parseInt(e.target.value, 10))}
              aria-label="Interval"
            />
            <select
              className="connectorField__input scheduleIntervalRow__unit"
              value={unit}
              onChange={(e) => changeUnit(e.target.value as ScheduleUnit)}
              aria-label="Unit"
            >
              {UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
            </select>
          </div>
          {intervalError
            ? <div className="schedulePanel__error">{intervalError}</div>
            : <div className="connectorField__help">{cronToHuman(cronExpression)}.</div>}
        </div>

        <div className="schedulePanel__note">
          Each run is a real conversation with Claude, billed to your API key,
          and it happens whether or not Acabox is on screen.
        </div>

        {!isNew && (
          <div className="schedulePanel__section">
            <div className="cdSectionLabel">Recent runs</div>
            {runs.length === 0 && (
              <div className="scheduleSection__empty">It has not run yet.</div>
            )}
            {runs.slice(0, 8).map((run) => {
              const outcome = runOutcome(run);
              return (
                <div key={run.id} className="schedulePanel__run">
                  <span className={`cdDot cdDot--${outcome.tone === 'good' ? 'ok' : outcome.tone === 'bad' ? 'error' : 'idle'}`} />
                  <span className="schedulePanel__runText">{outcome.text}</span>
                  <span className="schedulePanel__runWhen">{whenText(run.started_at)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="schedulePanel__footer">
        {!isNew && (
          <button className="cdBtnXs" onClick={runNow} disabled={running}>
            {running ? 'Running…' : 'Run now'}
          </button>
        )}
        {!isNew && !isSystemTask && (
          <button className="cdBtnXs" onClick={() => setPendingDelete(true)}>Delete</button>
        )}
        <div className="schedulePanel__footerSpacer" />
        <button className="cdBtnPrimary" onClick={save} disabled={!canSave}>
          {saving ? 'Saving…' : isNew ? 'Create' : 'Save'}
        </button>
      </div>

      {pendingDelete && (
        <div className="toolsConfirmOverlay">
          <div className="toolsConfirmModal">
            <div className="toolsConfirmModal__title">Delete this task?</div>
            <div className="toolsConfirmModal__message">
              “{task?.name ?? name}” will stop running. Its past runs are removed
              with it. Nothing it already wrote to your files is touched.
            </div>
            <div className="toolsConfirmModal__actions">
              <button className="cdBtnXs" onClick={() => setPendingDelete(false)}>Cancel</button>
              <button className="cdBtnXs" onClick={remove}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
