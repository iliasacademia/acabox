import React, { memo } from 'react';
import { CheckCircleIcon, CircleDotIcon, CircleIcon } from 'lucide-react';
import type { ToolCallMessagePartComponent } from '@assistant-ui/react';

interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'high' | 'medium' | 'low';
}

function parseTodos(args: Record<string, unknown> | undefined, argsText?: string): TodoItem[] | null {
  const source = args && Object.keys(args).length > 0 ? args : undefined;
  let resolved = source;
  if (!resolved && argsText) {
    try {
      const parsed = JSON.parse(argsText);
      if (parsed && typeof parsed === 'object') {
        resolved = parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  }
  if (!resolved || !Array.isArray(resolved.todos)) return null;
  return resolved.todos as TodoItem[];
}

const statusIcon: Record<TodoItem['status'], React.ElementType> = {
  completed: CheckCircleIcon,
  in_progress: CircleDotIcon,
  pending: CircleIcon,
};

const TodoWriteImpl: ToolCallMessagePartComponent = ({ args, argsText }: any) => {
  const todos = parseTodos(args, argsText);

  if (!todos) {
    return (
      <div className="todoList">
        <div className="todoListHeader">Tasks</div>
        <div className="todoEmpty">Loading tasks...</div>
      </div>
    );
  }

  const completed = todos.filter((t) => t.status === 'completed').length;

  return (
    <div className="todoList">
      <div className="todoListHeader">
        <span>Tasks</span>
        <span className="todoCount">{completed}/{todos.length}</span>
      </div>
      {todos.map((todo) => {
        const Icon = statusIcon[todo.status] ?? CircleIcon;
        return (
          <div key={todo.id} className={`todoItem todoItem--${todo.status}`}>
            <Icon className={`todoIcon todoIcon--${todo.status}`} />
            <span className={`todoContent todoContent--${todo.status}`}>
              {todo.content}
            </span>
          </div>
        );
      })}
    </div>
  );
};

export const TodoWrite = memo(TodoWriteImpl) as unknown as ToolCallMessagePartComponent;
TodoWrite.displayName = 'TodoWrite';
