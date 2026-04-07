import { useState, useEffect, useCallback, useRef } from 'react';
import type { NotebookDocument, NotebookCell, CellOutput } from './types';

export function createEmptyNotebook(kernelName = 'python3', language = 'python'): NotebookDocument {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: {
        name: kernelName,
        display_name: kernelName === 'python3' ? 'Python 3' : kernelName,
        language,
      },
      language_info: { name: language },
    },
    cells: [
      {
        cell_type: 'code',
        source: [],
        metadata: {},
        outputs: [],
        execution_count: null,
        id: crypto.randomUUID(),
      },
    ],
  };
}

export function useNotebook(filePath: string) {
  const [notebook, setNotebook] = useState<NotebookDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const notebookRef = useRef<NotebookDocument | null>(null);

  useEffect(() => {
    notebookRef.current = notebook;
  }, [notebook]);

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError(null);
    setDirty(false);

    window.filesAPI.readFile(filePath).then((result) => {
      if (stale) return;
      if ('error' in result) {
        setError('File too large to open');
        setLoading(false);
        return;
      }
      if (result.type !== 'text') {
        setError('Cannot read notebook file');
        setLoading(false);
        return;
      }
      const content = result.content.trim();
      let doc: NotebookDocument;

      if (!content) {
        doc = createEmptyNotebook();
        window.filesAPI.writeFile(filePath, JSON.stringify(doc, null, 1) + '\n');
      } else {
        try {
          doc = JSON.parse(content) as NotebookDocument;
        } catch {
          setError('Invalid notebook JSON');
          setLoading(false);
          return;
        }
      }

      // Normalize source to string arrays
      for (const cell of doc.cells) {
        if (typeof cell.source === 'string') {
          cell.source = [cell.source];
        }
        if (!cell.id) {
          cell.id = crypto.randomUUID();
        }
      }
      setNotebook(doc);
      setLoading(false);
    });

    return () => {
      stale = true;
    };
  }, [filePath]);

  const updateCells = useCallback(
    (updater: (cells: NotebookCell[]) => NotebookCell[]) => {
      setNotebook((prev) => {
        if (!prev) return prev;
        return { ...prev, cells: updater(prev.cells) };
      });
      setDirty(true);
    },
    [],
  );

  const updateCellSource = useCallback(
    (index: number, source: string) => {
      updateCells((cells) =>
        cells.map((c, i) =>
          i === index
            ? {
                ...c,
                source: source.split('\n').map((line, j, arr) =>
                  j < arr.length - 1 ? line + '\n' : line,
                ),
              }
            : c,
        ),
      );
    },
    [updateCells],
  );

  const updateCellOutputs = useCallback(
    (index: number, outputs: CellOutput[]) => {
      updateCells((cells) =>
        cells.map((c, i) => (i === index ? { ...c, outputs } : c)),
      );
    },
    [updateCells],
  );

  const updateCellExecutionCount = useCallback(
    (index: number, count: number | null) => {
      updateCells((cells) =>
        cells.map((c, i) =>
          i === index ? { ...c, execution_count: count } : c,
        ),
      );
    },
    [updateCells],
  );

  const addCell = useCallback(
    (index: number, cellType: 'code' | 'markdown') => {
      updateCells((cells) => {
        const newCell: NotebookCell = {
          cell_type: cellType,
          source: [],
          metadata: {},
          id: crypto.randomUUID(),
          ...(cellType === 'code'
            ? { outputs: [], execution_count: null }
            : {}),
        };
        const next = [...cells];
        next.splice(index, 0, newCell);
        return next;
      });
    },
    [updateCells],
  );

  const deleteCell = useCallback(
    (index: number) => {
      updateCells((cells) => cells.filter((_, i) => i !== index));
    },
    [updateCells],
  );

  const moveCell = useCallback(
    (from: number, to: number) => {
      updateCells((cells) => {
        const next = [...cells];
        const [cell] = next.splice(from, 1);
        next.splice(to, 0, cell);
        return next;
      });
    },
    [updateCells],
  );

  const clearCellOutputs = useCallback(
    (index: number) => {
      updateCells((cells) =>
        cells.map((c, i) =>
          i === index ? { ...c, outputs: [], execution_count: null } : c,
        ),
      );
    },
    [updateCells],
  );

  const clearAllOutputs = useCallback(() => {
    updateCells((cells) =>
      cells.map((c) =>
        c.cell_type === 'code'
          ? { ...c, outputs: [], execution_count: null }
          : c,
      ),
    );
  }, [updateCells]);

  const changeCellType = useCallback(
    (index: number, newType: 'code' | 'markdown') => {
      updateCells((cells) =>
        cells.map((c, i) => {
          if (i !== index || c.cell_type === newType) return c;
          if (newType === 'code') {
            return { ...c, cell_type: 'code', outputs: [], execution_count: null };
          }
          // Converting to markdown: remove outputs and execution_count
          const { outputs, execution_count, ...rest } = c;
          return { ...rest, cell_type: 'markdown' };
        }),
      );
    },
    [updateCells],
  );

  const duplicateCell = useCallback(
    (index: number) => {
      updateCells((cells) => {
        const original = cells[index];
        if (!original) return cells;
        const copy: NotebookCell = {
          ...JSON.parse(JSON.stringify(original)),
          id: crypto.randomUUID(),
          execution_count: null,
          outputs: [],
        };
        const next = [...cells];
        next.splice(index + 1, 0, copy);
        return next;
      });
    },
    [updateCells],
  );

  const save = useCallback(async () => {
    const current = notebookRef.current;
    if (!current) return;
    const json = JSON.stringify(current, null, 1) + '\n';
    await window.filesAPI.writeFile(filePath, json);
    setDirty(false);
  }, [filePath]);

  return {
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
  };
}
