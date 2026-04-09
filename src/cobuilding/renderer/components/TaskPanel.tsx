import React from 'react';
import { CheckCircleIcon, CircleDotIcon, CircleIcon } from 'lucide-react';
import { useTasks, type TaskItem } from '../taskStore';

const statusIcon: Record<TaskItem['status'], React.ElementType> = {
  completed: CheckCircleIcon,
  in_progress: CircleDotIcon,
  pending: CircleIcon,
};

export function TaskPanel() {
  const tasks = useTasks();
  if (!tasks || tasks.length === 0) return null;

  const completed = tasks.filter((t) => t.status === 'completed').length;

  return (
    <div className="taskPanel">
      <div className="taskPanelHeader">
        <span>Tasks</span>
        <span className="taskPanelCount">
          {completed}/{tasks.length}
        </span>
      </div>
      <div className="taskPanelList">
        {tasks.map((task) => {
          const Icon = statusIcon[task.status] ?? CircleIcon;
          return (
            <div key={task.id} className={`taskPanelItem taskPanelItem--${task.status}`}>
              <Icon className={`taskPanelIcon taskPanelIcon--${task.status}`} />
              <span className={`taskPanelContent taskPanelContent--${task.status}`}>
                {task.content}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
