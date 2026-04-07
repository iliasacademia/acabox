import React, { useState, useRef, useImperativeHandle, forwardRef, type FC } from 'react';
import {
  PlayIcon,
  SquareIcon,
  TrashIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  CopyIcon,
  XCircleIcon,
  ChevronRightIcon,
  LoaderIcon,
} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeEditor, type CodeEditorHandle } from './CodeEditor';
import { CellOutput } from './CellOutput';
import type { NotebookCell as NotebookCellType } from './types';

export interface NotebookCellHandle {
  focus: () => void;
  blur: () => void;
}

interface NotebookCellProps {
  cell: NotebookCellType;
  index: number;
  language: string;
  isExecuting: boolean;
  isSelected: boolean;
  isFirst: boolean;
  isLast: boolean;
  executionDuration: number | null;
  onSourceChange: (source: string) => void;
  onExecute: () => void;
  onExecuteAndAdvance: () => void;
  onInterrupt: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDuplicate: () => void;
  onClearOutputs: () => void;
  onSelect: () => void;
  onEnterEdit: () => void;
  onExitEdit: () => void;
  onNavigateUp: () => void;
  onNavigateDown: () => void;
}

export const NotebookCell = forwardRef<NotebookCellHandle, NotebookCellProps>(
  (
    {
      cell,
      index,
      language,
      isExecuting,
      isSelected,
      isFirst,
      isLast,
      executionDuration,
      onSourceChange,
      onExecute,
      onExecuteAndAdvance,
      onInterrupt,
      onDelete,
      onMoveUp,
      onMoveDown,
      onDuplicate,
      onClearOutputs,
      onSelect,
      onEnterEdit,
      onExitEdit,
      onNavigateUp,
      onNavigateDown,
    },
    ref,
  ) => {
    const [editingMarkdown, setEditingMarkdown] = useState(false);
    const [outputsCollapsed, setOutputsCollapsed] = useState(false);
    const editorRef = useRef<CodeEditorHandle>(null);
    const source = cell.source.join('');
    const hasOutputs = cell.outputs && cell.outputs.length > 0;

    useImperativeHandle(ref, () => ({
      focus: () => editorRef.current?.focus(),
      blur: () => editorRef.current?.blur(),
    }));

    const handleEscape = () => {
      if (editingMarkdown) {
        setEditingMarkdown(false);
      }
      onExitEdit();
    };

    if (cell.cell_type === 'markdown' && !editingMarkdown) {
      return (
        <div
          className={`notebookCell notebookCellMarkdown ${isSelected ? 'notebookCell--selected' : ''}`}
          onClick={onSelect}
          onDoubleClick={() => { setEditingMarkdown(true); onEnterEdit(); }}
        >
          <CellToolbar
            cellType="markdown"
            index={index}
            executionCount={null}
            isFirst={isFirst}
            isLast={isLast}
            executionDuration={null}
            onExecute={() => setEditingMarkdown(false)}
            onDelete={onDelete}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
            onDuplicate={onDuplicate}
          />
          <div className="notebookMarkdown">
            {source ? (
              <Markdown remarkPlugins={[remarkGfm]}>{source}</Markdown>
            ) : (
              <span className="notebookCellPlaceholder">
                Double-click to edit
              </span>
            )}
          </div>
        </div>
      );
    }

    if (cell.cell_type === 'markdown' && editingMarkdown) {
      return (
        <div
          className={`notebookCell notebookCellMarkdown notebookCellMarkdown--editing ${isSelected ? 'notebookCell--selected' : ''}`}
          onClick={onSelect}
        >
          <CellToolbar
            cellType="markdown"
            index={index}
            executionCount={null}
            isFirst={isFirst}
            isLast={isLast}
            executionDuration={null}
            onExecute={() => { setEditingMarkdown(false); onExitEdit(); }}
            onDelete={onDelete}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
            onDuplicate={onDuplicate}
          />
          <CodeEditor
            ref={editorRef}
            value={source}
            onChange={onSourceChange}
            language="markdown"
            onExecute={() => { setEditingMarkdown(false); onExitEdit(); }}
            onExecuteAndAdvance={() => { setEditingMarkdown(false); onExitEdit(); }}
            onEscape={handleEscape}
            onArrowUp={onNavigateUp}
            onArrowDown={onNavigateDown}
          />
        </div>
      );
    }

    return (
      <div
        className={`notebookCell notebookCellCode ${
          isExecuting ? 'notebookCellCode--executing' : ''
        } ${isSelected ? 'notebookCell--selected' : ''}`}
        onClick={onSelect}
      >
        <CellToolbar
          cellType="code"
          index={index}
          executionCount={cell.execution_count}
          isExecuting={isExecuting}
          isFirst={isFirst}
          isLast={isLast}
          executionDuration={executionDuration}
          hasOutputs={hasOutputs}
          onExecute={onExecute}
          onInterrupt={onInterrupt}
          onDelete={onDelete}
          onMoveUp={onMoveUp}
          onMoveDown={onMoveDown}
          onDuplicate={onDuplicate}
          onClearOutputs={onClearOutputs}
        />
        <CodeEditor
          ref={editorRef}
          value={source}
          onChange={onSourceChange}
          language={language}
          onExecute={onExecute}
          onExecuteAndAdvance={onExecuteAndAdvance}
          onEscape={handleEscape}
          onArrowUp={onNavigateUp}
          onArrowDown={onNavigateDown}
        />
        {hasOutputs && (
          <>
            <button
              className="notebookOutputToggle"
              onClick={(e) => { e.stopPropagation(); setOutputsCollapsed(!outputsCollapsed); }}
            >
              <ChevronRightIcon
                style={{ width: 12, height: 12 }}
                className={`notebookOutputToggleIcon ${!outputsCollapsed ? 'notebookOutputToggleIcon--open' : ''}`}
              />
              {outputsCollapsed
                ? `${cell.outputs!.length} output${cell.outputs!.length === 1 ? '' : 's'} hidden`
                : 'Outputs'}
            </button>
            {!outputsCollapsed && (
              <div className="notebookCellOutputs">
                {cell.outputs!.map((output, i) => (
                  <CellOutput key={i} output={output} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    );
  },
);

const CellToolbar: FC<{
  cellType: string;
  index: number;
  executionCount: number | null | undefined;
  isExecuting?: boolean;
  isFirst: boolean;
  isLast: boolean;
  executionDuration: number | null;
  hasOutputs?: boolean;
  onExecute: () => void;
  onInterrupt?: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDuplicate: () => void;
  onClearOutputs?: () => void;
}> = ({
  cellType,
  index,
  executionCount,
  isExecuting,
  isFirst,
  isLast,
  executionDuration,
  hasOutputs,
  onExecute,
  onInterrupt,
  onDelete,
  onMoveUp,
  onMoveDown,
  onDuplicate,
  onClearOutputs,
}) => (
  <div
    className={`notebookCellToolbar ${
      isExecuting ? 'notebookCellToolbar--visible' : ''
    }`}
  >
    {cellType === 'code' && isExecuting ? (
      <button className="notebookCellBtn notebookCellBtn--interrupt" onClick={onInterrupt} title="Interrupt">
        <SquareIcon style={{ width: 10, height: 10 }} />
      </button>
    ) : (
      <span className="notebookCellExecutionCount">
        {cellType === 'code'
          ? `[${executionCount ?? ' '}]`
          : `[${index + 1}]`}
      </span>
    )}
    {executionDuration !== null && !isExecuting && (
      <span className="notebookCellDuration">{formatDuration(executionDuration)}</span>
    )}
    <button className="notebookCellBtn" onClick={onExecute} title="Run">
      <PlayIcon style={{ width: 12, height: 12 }} />
    </button>
    <button
      className="notebookCellBtn"
      onClick={onMoveUp}
      disabled={isFirst}
      title="Move up"
    >
      <ChevronUpIcon style={{ width: 12, height: 12 }} />
    </button>
    <button
      className="notebookCellBtn"
      onClick={onMoveDown}
      disabled={isLast}
      title="Move down"
    >
      <ChevronDownIcon style={{ width: 12, height: 12 }} />
    </button>
    <button className="notebookCellBtn" onClick={onDuplicate} title="Duplicate cell">
      <CopyIcon style={{ width: 12, height: 12 }} />
    </button>
    <div style={{ flex: 1 }} />
    {cellType === 'code' && hasOutputs && onClearOutputs && (
      <button className="notebookCellBtn" onClick={onClearOutputs} title="Clear outputs">
        <XCircleIcon style={{ width: 12, height: 12 }} />
      </button>
    )}
    <button
      className="notebookCellBtn"
      onClick={onDelete}
      title="Delete cell"
    >
      <TrashIcon style={{ width: 12, height: 12 }} />
    </button>
  </div>
);

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}m ${seconds}s`;
}
