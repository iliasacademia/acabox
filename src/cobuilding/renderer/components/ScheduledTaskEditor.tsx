import React, { useState, useEffect, useCallback } from 'react';
import { PlayIcon, TrashIcon, SaveIcon } from 'lucide-react';
import type { ScheduledTask, ScheduledTaskRun } from '../../shared/types';

function cronToHuman(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return '';

  const [min, hour, dom, mon, dow] = parts;

  if (min === '*' && hour === '*') return 'Runs every minute';
  if (hour === '*' && min !== '*') return `Runs every hour at :${min.padStart(2, '0')}`;
  if (dom === '*' && mon === '*' && dow === '*' && hour !== '*' && min !== '*') {
    return `Runs daily at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }
  if (min === '0' && hour === '*') return 'Runs every hour';

  return '';
}

export function ScheduledTaskEditor({
  taskId,
  onSaved,
  onDeleted,
}: {
  taskId: string | null;
  onSaved: (savedTaskId: string) => void;
  onDeleted: () => void;
}) {
  const [task, setTask] = useState<ScheduledTask | null>(null);
  const [runs, setRuns] = useState<ScheduledTaskRun[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [cronExpression, setCronExpression] = useState('0 * * * *');
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);

  const isNew = taskId === null;

  useEffect(() => {
    if (taskId) {
      window.scheduledTasksAPI.get(taskId).then((t) => {
        if (t) {
          setTask(t);
          setName(t.name);
          setDescription(t.description);
          setPrompt(t.prompt);
          setCronExpression(t.cron_expression);
        }
      });
      window.scheduledTasksAPI.listRuns(taskId).then(setRuns);
    } else {
      setTask(null);
      setName('');
      setDescription('');
      setPrompt('');
      setCronExpression('0 * * * *');
      setRuns([]);
    }
  }, [taskId]);

  const handleSave = useCallback(async () => {
    if (!name.trim() || !prompt.trim()) return;
    setSaving(true);
    try {
      let savedId: string;
      if (isNew) {
        const created = await window.scheduledTasksAPI.create({
          name: name.trim(),
          description: description.trim(),
          prompt: prompt.trim(),
          cron_expression: cronExpression.trim(),
        });
        savedId = created.id;
      } else {
        await window.scheduledTasksAPI.update(taskId!, {
          name: name.trim(),
          description: description.trim(),
          prompt: prompt.trim(),
          cron_expression: cronExpression.trim(),
        });
        savedId = taskId!;
      }
      onSaved(savedId);
    } finally {
      setSaving(false);
    }
  }, [isNew, taskId, name, description, prompt, cronExpression, onSaved]);

  const handleDelete = useCallback(async () => {
    if (!taskId) return;
    await window.scheduledTasksAPI.delete(taskId);
    setPendingDelete(false);
    onDeleted();
  }, [taskId, onDeleted]);

  const handleRunNow = useCallback(async () => {
    if (!taskId) return;
    setRunning(true);
    try {
      await window.scheduledTasksAPI.runNow(taskId);
      const updatedRuns = await window.scheduledTasksAPI.listRuns(taskId);
      setRuns(updatedRuns);
    } finally {
      setRunning(false);
    }
  }, [taskId]);

  const cronHint = cronToHuman(cronExpression);

  return (
    <div className="scheduledTaskEditor">
      <div className="scheduledTaskEditor__header">
        <h2 className="scheduledTaskEditor__title">
          {isNew ? 'New Scheduled Task' : 'Edit Scheduled Task'}
        </h2>
      </div>

      <div className="scheduledTaskEditor__form">
        <label className="scheduledTaskEditor__label">
          Name
          <input
            className="scheduledTaskEditor__input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Hourly Summary"
          />
        </label>

        <label className="scheduledTaskEditor__label">
          Description
          <input
            className="scheduledTaskEditor__input"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional description"
          />
        </label>

        <label className="scheduledTaskEditor__label">
          Prompt
          <textarea
            className="scheduledTaskEditor__textarea"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="The prompt that will be sent to the agent when this task runs"
            rows={6}
          />
        </label>

        <label className="scheduledTaskEditor__label">
          Cron Expression
          <input
            className="scheduledTaskEditor__input"
            type="text"
            value={cronExpression}
            onChange={(e) => setCronExpression(e.target.value)}
            placeholder="0 * * * *"
          />
          {cronHint && (
            <span className="scheduledTaskEditor__hint">{cronHint}</span>
          )}
          <span className="scheduledTaskEditor__hint scheduledTaskEditor__hint--muted">
            Format: minute hour day-of-month month day-of-week
          </span>
        </label>

        <div className="scheduledTaskEditor__actions">
          <button
            className="scheduledTaskEditor__btn scheduledTaskEditor__btn--primary"
            onClick={handleSave}
            disabled={saving || !name.trim() || !prompt.trim()}
          >
            <SaveIcon style={{ width: 14, height: 14 }} />
            {saving ? 'Saving...' : 'Save'}
          </button>
          {!isNew && (
            <>
              <button
                className="scheduledTaskEditor__btn"
                onClick={handleRunNow}
                disabled={running}
              >
                <PlayIcon style={{ width: 14, height: 14 }} />
                {running ? 'Running...' : 'Run Now'}
              </button>
              <button
                className="scheduledTaskEditor__btn scheduledTaskEditor__btn--danger"
                onClick={() => setPendingDelete(true)}
              >
                <TrashIcon style={{ width: 14, height: 14 }} />
                Delete
              </button>
            </>
          )}
        </div>
      </div>

      {!isNew && runs.length > 0 && (
        <div className="scheduledTaskEditor__runs">
          <h3 className="scheduledTaskEditor__runsTitle">Run History</h3>
          <div className="scheduledTaskEditor__runsList">
            {runs.map((run) => (
              <div key={run.id} className="scheduledTaskEditor__runItem">
                <span className={`scheduledTaskEditor__runStatus scheduledTaskEditor__runStatus--${run.status}`}>
                  {run.status}
                </span>
                <span className="scheduledTaskEditor__runTime">
                  {new Date(run.started_at + 'Z').toLocaleString()}
                </span>
                {run.error && (
                  <span className="scheduledTaskEditor__runError">{run.error}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {pendingDelete && (
        <div className="miniAppsModal__overlay" onClick={() => setPendingDelete(false)}>
          <div className="miniAppsModal" onClick={(e) => e.stopPropagation()}>
            <p className="miniAppsModal__message">
              Are you sure you want to delete this scheduled task?
            </p>
            <div className="miniAppsModal__actions">
              <button className="miniAppsModal__btn" onClick={() => setPendingDelete(false)}>
                Cancel
              </button>
              <button
                className="miniAppsModal__btn miniAppsModal__btn--danger"
                onClick={handleDelete}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
