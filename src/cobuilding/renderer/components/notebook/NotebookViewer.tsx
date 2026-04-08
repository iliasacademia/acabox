import React, { useState, useEffect, useCallback, useRef, type FC } from 'react';
import {
  PlusIcon,
  SaveIcon,
  RotateCcwIcon,
  CircleIcon,
  PlayIcon,
  SquareIcon,
  XCircleIcon,
} from 'lucide-react';
import { useNotebook } from './useNotebook';
import { useKernel, type KernelStatus } from './useKernel';
import { NotebookCell, type NotebookCellHandle } from './NotebookCell';
import type { CellOutput } from './types';

interface NotebookViewerProps {
  filePath: string;
  onDirtyChange?: (dirty: boolean) => void;
}

export const NotebookViewer: FC<NotebookViewerProps> = ({ filePath, onDirtyChange }) => {
  const {
    notebook,
    loading,
    error,
    dirty,
    updateCellSource,
    updateCellOutputs,
    updateCellExecutionCount,
    addCell,
    deleteCell,
    moveCell,
    clearCellOutputs,
    clearAllOutputs,
    changeCellType,
    duplicateCell,
    save,
  } = useNotebook(filePath);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const kernel = useKernel();
  const cellRefs = useRef<Map<number, NotebookCellHandle>>(new Map());
  const pendingFocusRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [executingCells, setExecutingCells] = useState<Set<number>>(new Set());
  const [selectedCellIndex, setSelectedCellIndex] = useState<number>(0);
  const [editMode, setEditMode] = useState(false);
  const [cellDurations, setCellDurations] = useState<Map<number, number>>(new Map());
  const cellStartTimes = useRef<Map<number, number>>(new Map());
  const lastDKeyRef = useRef<number>(0);

  const language =
    (notebook?.metadata?.kernelspec?.language as string | undefined) ??
    (notebook?.metadata?.language_info?.name as string | undefined) ??
    'python';

  const defaultKernelName =
    (notebook?.metadata?.kernelspec?.name as string | undefined) ?? 'python3';

  // Auto-connect kernel on mount
  useEffect(() => {
    if (notebook && kernel.status === 'disconnected') {
      kernel.connect(defaultKernelName);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notebook]);

  // Focus cell after state updates
  useEffect(() => {
    if (pendingFocusRef.current !== null && notebook) {
      const index = pendingFocusRef.current;
      pendingFocusRef.current = null;
      setSelectedCellIndex(index);
      setEditMode(true);
      requestAnimationFrame(() => {
        cellRefs.current.get(index)?.focus();
      });
    }
  }, [notebook]);

  const focusCell = useCallback((index: number) => {
    const handle = cellRefs.current.get(index);
    if (handle) {
      handle.focus();
      setSelectedCellIndex(index);
      setEditMode(true);
    } else {
      pendingFocusRef.current = index;
    }
  }, []);

  const selectCell = useCallback((index: number) => {
    setSelectedCellIndex(index);
  }, []);

  const enterEditMode = useCallback(() => {
    setEditMode(true);
    cellRefs.current.get(selectedCellIndex)?.focus();
  }, [selectedCellIndex]);

  const exitEditMode = useCallback(() => {
    setEditMode(false);
    cellRefs.current.get(selectedCellIndex)?.blur();
    // Return focus to the notebook container for command mode shortcuts
    containerRef.current?.focus();
  }, [selectedCellIndex]);

  const handleExecuteCell = useCallback(
    async (index: number) => {
      if (!notebook) return;
      const cell = notebook.cells[index];
      if (cell.cell_type !== 'code') return;

      const source = cell.source.join('');
      if (!source.trim()) return;

      updateCellOutputs(index, []);
      updateCellExecutionCount(index, null);
      setExecutingCells((prev) => new Set(prev).add(index));
      cellStartTimes.current.set(index, Date.now());
      setCellDurations((prev) => { const next = new Map(prev); next.delete(index); return next; });

      try {
        const outputs: CellOutput[] = [];
        const count = await kernel.executeCode(source, (output) => {
          outputs.push(output);
          updateCellOutputs(index, [...outputs]);
        });

        updateCellExecutionCount(index, count);
      } finally {
        setExecutingCells((prev) => {
          const next = new Set(prev);
          next.delete(index);
          return next;
        });
        const startTime = cellStartTimes.current.get(index);
        if (startTime) {
          setCellDurations((prev) => new Map(prev).set(index, Date.now() - startTime));
          cellStartTimes.current.delete(index);
        }
      }
    },
    [notebook, kernel, updateCellOutputs, updateCellExecutionCount],
  );

  const handleExecuteAndAdvance = useCallback(
    async (index: number) => {
      if (!notebook) return;

      handleExecuteCell(index);

      const nextIndex = index + 1;
      if (nextIndex < notebook.cells.length) {
        focusCell(nextIndex);
      } else {
        addCell(notebook.cells.length, 'code');
        pendingFocusRef.current = nextIndex;
      }
    },
    [notebook, handleExecuteCell, focusCell, addCell],
  );

  const handleInsertCell = useCallback(
    (index: number, type: 'code' | 'markdown') => {
      addCell(index, type);
      pendingFocusRef.current = index;
    },
    [addCell],
  );

  const handleRunAll = useCallback(async () => {
    if (!notebook) return;
    for (let i = 0; i < notebook.cells.length; i++) {
      if (notebook.cells[i].cell_type === 'code') {
        await handleExecuteCell(i);
      }
    }
  }, [notebook, handleExecuteCell]);

  // Command mode keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!notebook) return;

      // Cmd+S works in both modes
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        save();
        return;
      }

      // Only handle command mode shortcuts when not in edit mode
      if (editMode) return;

      const cellCount = notebook.cells.length;

      switch (e.key) {
        case 'Enter':
          e.preventDefault();
          enterEditMode();
          break;
        case 'ArrowUp':
        case 'k':
          e.preventDefault();
          if (selectedCellIndex > 0) setSelectedCellIndex(selectedCellIndex - 1);
          break;
        case 'ArrowDown':
        case 'j':
          e.preventDefault();
          if (selectedCellIndex < cellCount - 1) setSelectedCellIndex(selectedCellIndex + 1);
          break;
        case 'a':
          e.preventDefault();
          addCell(selectedCellIndex, 'code');
          // The new cell is inserted at selectedCellIndex, pushing current down
          // Keep selection on the new cell
          break;
        case 'b':
          e.preventDefault();
          addCell(selectedCellIndex + 1, 'code');
          setSelectedCellIndex(selectedCellIndex + 1);
          break;
        case 'd': {
          const now = Date.now();
          if (now - lastDKeyRef.current < 500) {
            e.preventDefault();
            if (cellCount > 1) {
              deleteCell(selectedCellIndex);
              if (selectedCellIndex >= cellCount - 1) {
                setSelectedCellIndex(Math.max(0, selectedCellIndex - 1));
              }
            }
            lastDKeyRef.current = 0;
          } else {
            lastDKeyRef.current = now;
          }
          break;
        }
        case 'm':
          e.preventDefault();
          changeCellType(selectedCellIndex, 'markdown');
          break;
        case 'y':
          e.preventDefault();
          changeCellType(selectedCellIndex, 'code');
          break;
      }
    },
    [notebook, editMode, selectedCellIndex, addCell, deleteCell, changeCellType, enterEditMode, save],
  );

  const isBusy = kernel.status === 'busy';

  return (
    <div
      className="notebookViewer"
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="notebookViewerHeader">
        <KernelStatusIndicator status={kernel.status} name={kernel.kernelName} />
        <div className="notebookViewerActions">
          <button className="btn btn--ghost btn--icon-xs" onClick={save} title="Save (Cmd+S)">
            <SaveIcon style={{ width: 16, height: 16 }} />
          </button>
          <button className="btn btn--ghost btn--icon-xs" onClick={handleRunAll} title="Run all cells">
            <PlayIcon style={{ width: 16, height: 16 }} />
          </button>
          {isBusy && (
            <button className="btn btn--ghost btn--icon-xs" onClick={() => kernel.interrupt()} title="Interrupt kernel">
              <SquareIcon style={{ width: 16, height: 16 }} />
            </button>
          )}
          <button className="btn btn--ghost btn--icon-xs" onClick={() => kernel.restart()} title="Restart kernel">
            <RotateCcwIcon style={{ width: 16, height: 16 }} />
          </button>
          <button className="btn btn--ghost btn--icon-xs" onClick={clearAllOutputs} title="Clear all outputs">
            <XCircleIcon style={{ width: 16, height: 16 }} />
          </button>
        </div>
      </div>

      <div className="notebookViewerBody">
        {loading && (
          <p className="notebookViewerMessage">Loading notebook...</p>
        )}
        {error && <p className="notebookViewerMessage notebookViewerMessage--error">{error}</p>}
        {kernel.status === 'starting' && (
          <p className="notebookViewerMessage">
            Starting kernel... (this may take a moment if the container is starting)
          </p>
        )}
        {kernel.status === 'dead' && kernel.error && (
          <div className="notebookViewerError">
            <p className="notebookViewerError__title">Kernel failed to start</p>
            <p className="notebookViewerError__detail">{kernel.error}</p>
            <button
              className="btn btn--outline btn--sm"
              onClick={() => kernel.connect(defaultKernelName)}
            >
              Retry
            </button>
          </div>
        )}
        {notebook &&
          notebook.cells.map((cell, i) => (
            <div key={cell.id ?? i}>
              <CellInsertDivider onInsert={(type) => handleInsertCell(i, type)} />
              <NotebookCell
                ref={(handle) => {
                  if (handle) {
                    cellRefs.current.set(i, handle);
                  } else {
                    cellRefs.current.delete(i);
                  }
                }}
                cell={cell}
                index={i}
                language={language}
                isExecuting={executingCells.has(i)}
                isSelected={selectedCellIndex === i}
                isFirst={i === 0}
                isLast={i === notebook.cells.length - 1}
                executionDuration={cellDurations.get(i) ?? null}
                onSourceChange={(source) => updateCellSource(i, source)}
                onExecute={() => handleExecuteCell(i)}
                onExecuteAndAdvance={() => handleExecuteAndAdvance(i)}
                onInterrupt={() => kernel.interrupt()}
                onDelete={() => deleteCell(i)}
                onMoveUp={() => moveCell(i, i - 1)}
                onMoveDown={() => moveCell(i, i + 1)}
                onDuplicate={() => duplicateCell(i)}
                onClearOutputs={() => clearCellOutputs(i)}
                onSelect={() => selectCell(i)}
                onEnterEdit={() => setEditMode(true)}
                onExitEdit={exitEditMode}
                onNavigateUp={() => {
                  if (i > 0) {
                    setSelectedCellIndex(i - 1);
                    focusCell(i - 1);
                  }
                }}
                onNavigateDown={() => {
                  if (i < notebook.cells.length - 1) {
                    setSelectedCellIndex(i + 1);
                    focusCell(i + 1);
                  }
                }}
              />
            </div>
          ))}
        {notebook && (
          <div className="notebookAddCells">
            <button
              className="btn btn--outline btn--sm"
              onClick={() => handleInsertCell(notebook.cells.length, 'code')}
            >
              <PlusIcon style={{ width: 12, height: 12 }} />
              Code
            </button>
            <button
              className="btn btn--outline btn--sm"
              onClick={() => handleInsertCell(notebook.cells.length, 'markdown')}
            >
              <PlusIcon style={{ width: 12, height: 12 }} />
              Markdown
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

const CellInsertDivider: FC<{
  onInsert: (type: 'code' | 'markdown') => void;
}> = ({ onInsert }) => (
  <div className="notebookInsertDivider">
    <div className="notebookInsertDivider__line" />
    <div className="notebookInsertDivider__buttons">
      <button
        className="notebookInsertDivider__btn"
        onClick={() => onInsert('code')}
      >
        + Code
      </button>
      <button
        className="notebookInsertDivider__btn"
        onClick={() => onInsert('markdown')}
      >
        + Markdown
      </button>
    </div>
  </div>
);

const statusColors: Record<KernelStatus, string> = {
  disconnected: '#999',
  starting: '#d4a017',
  idle: '#4caf50',
  busy: '#d4a017',
  dead: '#e53935',
};

const KernelStatusIndicator: FC<{
  status: KernelStatus;
  name: string;
}> = ({ status, name }) => (
  <div className="notebookKernelStatus">
    <CircleIcon
      style={{
        width: 8,
        height: 8,
        fill: statusColors[status],
        color: statusColors[status],
      }}
    />
    <span>{name}</span>
  </div>
);
