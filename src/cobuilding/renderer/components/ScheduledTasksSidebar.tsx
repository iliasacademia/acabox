import React, { useState, useEffect, useCallback } from 'react';
import { ClockIcon, PlusIcon } from 'lucide-react';
import type { ScheduledTask } from '../../shared/types';

function cronToHuman(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;

  const [min, hour, dom, mon, dow] = parts;

  // Step patterns (*/N)
  const minStep = min.match(/^\*\/(\d+)$/);
  if (minStep && hour === '*') {
    const n = parseInt(minStep[1], 10);
    return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  }

  const hourStep = hour.match(/^\*\/(\d+)$/);
  if (min === '0' && hourStep && dom === '*') {
    const n = parseInt(hourStep[1], 10);
    return n === 1 ? 'Every hour' : `Every ${n} hours`;
  }

  const domStep = dom.match(/^\*\/(\d+)$/);
  if (min === '0' && hour === '0' && domStep) {
    const n = parseInt(domStep[1], 10);
    return n === 1 ? 'Daily' : `Every ${n} days`;
  }

  // Legacy patterns
  if (min === '*' && hour === '*') return 'Every minute';
  if (min === '0' && hour === '*') return 'Every hour';
  if (min === '0' && hour === '0' && dom === '*') return 'Daily';
  if (hour === '*' && min !== '*') return `Every hour at :${min.padStart(2, '0')}`;
  if (dom === '*' && mon === '*' && dow === '*' && hour !== '*' && min !== '*') {
    return `Daily at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }

  return expr;
}

export function ScheduledTasksSidebar({
  selectedTaskId,
  onSelectTask,
  onNewTask,
  refreshKey,
}: {
  selectedTaskId: string | null;
  onSelectTask: (id: string | null) => void;
  onNewTask: () => void;
  refreshKey: number;
}) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const list = await window.scheduledTasksAPI.list();
      setTasks(list);
    } catch {
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  const handleToggle = useCallback(async (e: React.MouseEvent, task: ScheduledTask) => {
    e.stopPropagation();
    const newEnabled = !task.enabled;
    await window.scheduledTasksAPI.setEnabled(task.id, newEnabled);
    setTasks((prev) =>
      prev.map((t) => (t.id === task.id ? { ...t, enabled: newEnabled ? 1 : 0 } : t)),
    );
  }, []);

  return (
    <div className="scheduledTasksTab">
      <button className="threadListNewBtn" onClick={onNewTask}>
        <PlusIcon style={{ width: 16, height: 16 }} />
        New Task
      </button>
      {loading && tasks.length === 0 ? (
        <div className="scheduledTasksEmpty">Loading...</div>
      ) : tasks.length === 0 ? (
        <div className="scheduledTasksEmpty">No scheduled tasks yet</div>
      ) : (
        <div className="scheduledTasksList">
          {tasks.map((task) => (
            <div
              key={task.id}
              className={`scheduledTasksItem ${selectedTaskId === task.id ? 'scheduledTasksItem--active' : ''}`}
              onClick={() => onSelectTask(task.id)}
            >
              <div className="scheduledTasksItemContent">
                <ClockIcon style={{ width: 16, height: 16, flexShrink: 0, opacity: task.enabled ? 1 : 0.4 }} />
                <div className="scheduledTasksItemText">
                  <span className={`scheduledTasksItemName ${!task.enabled ? 'scheduledTasksItemName--disabled' : ''}`}>
                    {task.name}
                  </span>
                  <span className="scheduledTasksItemSchedule">
                    {cronToHuman(task.cron_expression)}
                  </span>
                </div>
              </div>
              <button
                className={`scheduledTasksToggle ${task.enabled ? 'scheduledTasksToggle--on' : ''}`}
                onClick={(e) => handleToggle(e, task)}
                title={task.enabled ? 'Disable' : 'Enable'}
              >
                <span className="scheduledTasksToggleKnob" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
