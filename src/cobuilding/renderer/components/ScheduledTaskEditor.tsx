import React, { useState, useEffect, useCallback } from 'react';
import { PlayIcon, TrashIcon, SaveIcon } from 'lucide-react';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './ui/select';
import type { ScheduledTask, ScheduledTaskRun } from '../../shared/types';

type ScheduleUnit = 'minutes' | 'hours' | 'days';

function intervalToCron(interval: number, unit: ScheduleUnit): string {
  switch (unit) {
    case 'minutes': return `*/${interval} * * * *`;
    case 'hours':   return `0 */${interval} * * *`;
    case 'days':    return `0 0 */${interval} * *`;
  }
}

function cronToInterval(expr: string): { interval: number; unit: ScheduleUnit } {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return { interval: 1, unit: 'hours' };

  const [min, hour, dom] = parts;

  const minStep = min.match(/^\*\/(\d+)$/);
  if (minStep && hour === '*' && dom === '*') {
    return { interval: parseInt(minStep[1], 10), unit: 'minutes' };
  }

  const hourStep = hour.match(/^\*\/(\d+)$/);
  if (min === '0' && hourStep && dom === '*') {
    return { interval: parseInt(hourStep[1], 10), unit: 'hours' };
  }
  if (min === '0' && hour === '*' && dom === '*') {
    return { interval: 1, unit: 'hours' };
  }

  const domStep = dom.match(/^\*\/(\d+)$/);
  if (min === '0' && hour === '0' && domStep) {
    return { interval: parseInt(domStep[1], 10), unit: 'days' };
  }
  if (min === '0' && hour === '0' && dom === '*') {
    return { interval: 1, unit: 'days' };
  }

  return { interval: 1, unit: 'hours' };
}

function validateInterval(interval: number, unit: ScheduleUnit): string | null {
  if (!Number.isInteger(interval) || interval <= 0) return 'Must be a positive whole number';
  switch (unit) {
    case 'minutes':
      if (interval % 5 !== 0) return 'Must be a multiple of 5';
      if (interval < 5 || interval > 55) return 'Must be between 5 and 55';
      break;
    case 'hours':
      if (interval > 24) return 'Must be between 1 and 24';
      break;
    case 'days':
      if (interval > 31) return 'Must be between 1 and 31';
      break;
  }
  return null;
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
  const [scheduleInterval, setScheduleInterval] = useState(1);
  const [scheduleUnit, setScheduleUnit] = useState<ScheduleUnit>('hours');
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [sources, setSources] = useState<string[]>([]);

  const isNew = taskId === null;
  const isSystemTask = task?.session_source === 'reactions-system';

  useEffect(() => {
    if (taskId) {
      window.scheduledTasksAPI.get(taskId).then((t) => {
        if (t) {
          setTask(t);
          setName(t.name);
          setDescription(t.description);
          setPrompt(t.prompt);
          const { interval, unit } = cronToInterval(t.cron_expression);
          setScheduleInterval(interval);
          setScheduleUnit(unit);
          if (t.session_source === 'reactions-system') {
            window.reactionSourcesAPI.get().then(setSources);
          }
        }
      });
      window.scheduledTasksAPI.listRuns(taskId).then(setRuns);
    } else {
      setTask(null);
      setName('');
      setDescription('');
      setPrompt('');
      setScheduleInterval(1);
      setScheduleUnit('hours');
      setRuns([]);
      setSources([]);
    }
  }, [taskId]);

  const cronExpression = intervalToCron(scheduleInterval, scheduleUnit);
  const validationError = validateInterval(scheduleInterval, scheduleUnit);

  const handleSave = useCallback(async () => {
    if (validationError) return;
    if (!isSystemTask && (!name.trim() || !prompt.trim())) return;
    setSaving(true);
    try {
      let savedId: string;
      if (isNew) {
        const created = await window.scheduledTasksAPI.create({
          name: name.trim(),
          description: description.trim(),
          prompt: prompt.trim(),
          cron_expression: cronExpression,
        });
        savedId = created.id;
      } else if (isSystemTask) {
        await window.scheduledTasksAPI.update(taskId!, {
          cron_expression: cronExpression,
        });
        savedId = taskId!;
      } else {
        await window.scheduledTasksAPI.update(taskId!, {
          name: name.trim(),
          description: description.trim(),
          prompt: prompt.trim(),
          cron_expression: cronExpression,
        });
        savedId = taskId!;
      }
      onSaved(savedId);
    } finally {
      setSaving(false);
    }
  }, [isNew, isSystemTask, taskId, name, description, prompt, cronExpression, validationError, onSaved]);

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

  const handleSourceToggle = useCallback((source: string, checked: boolean) => {
    const next = checked
      ? [...sources, source]
      : sources.filter(s => s !== source);
    // Prevent unchecking the last source
    if (next.length === 0) return;
    setSources(next);
    window.reactionSourcesAPI.set(next);
  }, [sources]);

  const handleUnitChange = (newUnit: ScheduleUnit) => {
    setScheduleUnit(newUnit);
    if (newUnit === 'minutes') {
      const snapped = Math.max(5, Math.min(55, Math.round(scheduleInterval / 5) * 5));
      setScheduleInterval(snapped);
    } else if (newUnit === 'hours') {
      setScheduleInterval(Math.max(1, Math.min(24, scheduleInterval)));
    } else {
      setScheduleInterval(Math.max(1, Math.min(31, scheduleInterval)));
    }
  };

  return (
    <div className="scheduledTaskEditor">
      <div className="scheduledTaskEditor__header">
        <h2 className="scheduledTaskEditor__title">
          {isNew ? 'New Scheduled Task' : isSystemTask ? task.name : 'Edit Scheduled Task'}
        </h2>
      </div>

      <div className="scheduledTaskEditor__form">
        {isSystemTask && sources.length > 0 && (
          <div className="scheduledTaskEditor__label">
            Sources
            <div className="scheduledTaskEditor__sources">
              {[
                { key: 'browser', label: 'Browser activity' },
                { key: 'file', label: 'File activity' },
              ].map(({ key, label }) => (
                <label key={key} className="scheduledTaskEditor__sourceLabel">
                  <input
                    type="checkbox"
                    checked={sources.includes(key)}
                    disabled={sources.length === 1 && sources.includes(key)}
                    onChange={(e) => handleSourceToggle(key, e.target.checked)}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
        )}

        {!isSystemTask && (
          <>
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
          </>
        )}

        <div className="scheduledTaskEditor__label">
          Schedule
          <div className="scheduledTaskEditor__scheduleRow">
            <span className="scheduledTaskEditor__scheduleLabel">Every</span>
            <input
              className="scheduledTaskEditor__input scheduledTaskEditor__scheduleInput"
              type="number"
              value={scheduleInterval}
              min={scheduleUnit === 'minutes' ? 5 : 1}
              max={scheduleUnit === 'minutes' ? 55 : scheduleUnit === 'hours' ? 24 : 31}
              step={scheduleUnit === 'minutes' ? 5 : 1}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val)) setScheduleInterval(val);
              }}
            />
            <Select value={scheduleUnit} onValueChange={(v) => handleUnitChange(v as ScheduleUnit)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="minutes">minutes</SelectItem>
                <SelectItem value="hours">hours</SelectItem>
                <SelectItem value="days">days</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {validationError && (
            <span className="scheduledTaskEditor__hint scheduledTaskEditor__hint--error">
              {validationError}
            </span>
          )}
        </div>

        <div className="scheduledTaskEditor__actions">
          <button
            className="scheduledTaskEditor__btn scheduledTaskEditor__btn--primary"
            onClick={handleSave}
            disabled={saving || !!validationError || (!isSystemTask && (!name.trim() || !prompt.trim()))}
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
              {!isSystemTask && (
                <button
                  className="scheduledTaskEditor__btn scheduledTaskEditor__btn--danger"
                  onClick={() => setPendingDelete(true)}
                >
                  <TrashIcon style={{ width: 14, height: 14 }} />
                  Delete
                </button>
              )}
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
