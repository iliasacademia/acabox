import React, { useState, useCallback } from 'react';
import { EditItem, ExecutionState } from '../hooks/usePlanExecution';

interface PlanModeViewProps {
  summary: string;
  edits: EditItem[];
  onExecute: (approved: EditItem[]) => void;
  onDismiss: () => void;
  executionState?: ExecutionState | null;
}

interface EditRowState {
  enabled: boolean;
  description: string;
  find?: string;
  replacement?: string;
  content?: string;
  expanded: boolean;
  editingDescription: boolean;
}

function EditRow({
  edit,
  index,
  rowState,
  onChange,
  completedSteps,  // number of edits fully done (0-indexed: edit i is done when completedSteps > i)
  isRunning,
  allDone,
}: {
  edit: EditItem;
  index: number;
  rowState: EditRowState;
  onChange: (patch: Partial<EditRowState>) => void;
  completedSteps: number;
  isRunning: boolean;
  allDone: boolean;
}) {
  const isComplete = completedSteps > index;
  const isCurrent = !isComplete && isRunning;
  const isPending = !isComplete && !isRunning && !allDone;
  const inEditMode = isRunning || allDone || completedSteps > 0;

  let rowClass = 'planEditRow';
  if (inEditMode) {
    if (isComplete) rowClass += ' complete';
    else if (isCurrent) rowClass += ' current';
    else if (isPending) rowClass += ' pending';
  } else if (!rowState.enabled) {
    rowClass += ' disabled';
  }

  return (
    <div className={rowClass}>
      <div className="planEditRowHeader">
        {!inEditMode && (
          <input
            type="checkbox"
            className="planEditCheckbox"
            checked={rowState.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
          />
        )}
        {inEditMode && (
          <span className="planEditStatusIcon" aria-hidden="true">
            {isComplete ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M3 8l3.5 3.5 6.5-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            ) : isCurrent ? (
              <span className="planSpinner" />
            ) : (
              <span className="planStepDot" />
            )}
          </span>
        )}
        <span className="planEditNumber">{index + 1}.</span>
        {rowState.editingDescription && !inEditMode ? (
          <input
            className="planEditDescriptionInput"
            value={rowState.description}
            autoFocus
            onChange={(e) => onChange({ description: e.target.value })}
            onBlur={() => onChange({ editingDescription: false })}
            onKeyDown={(e) => { if (e.key === 'Enter') onChange({ editingDescription: false }); }}
          />
        ) : (
          <span
            className={`planEditDescription${!inEditMode ? ' editable' : ''}`}
            onClick={!inEditMode ? () => onChange({ editingDescription: true }) : undefined}
          >
            {rowState.description}
          </span>
        )}
        {(edit.type === 'replace' || edit.type === 'insert' || edit.type === 'delete') && !inEditMode && (
          <button
            type="button"
            className="planEditExpandBtn"
            onClick={() => onChange({ expanded: !rowState.expanded })}
            aria-label={rowState.expanded ? 'Collapse' : 'Expand'}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              style={{ transform: rowState.expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
            >
              <path d="M1 3l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        )}
      </div>

      {rowState.expanded && !inEditMode && (
        <div className="planEditDetails">
          {edit.type === 'replace' && (
            <>
              <label className="planEditLabel">Find</label>
              <textarea
                className="planEditTextarea"
                value={rowState.find ?? ''}
                onChange={(e) => onChange({ find: e.target.value })}
                rows={2}
              />
              <label className="planEditLabel">Replace with</label>
              <textarea
                className="planEditTextarea"
                value={rowState.replacement ?? ''}
                onChange={(e) => onChange({ replacement: e.target.value })}
                rows={2}
              />
            </>
          )}
          {edit.type === 'insert' && (
            <>
              <label className="planEditLabel">Content to insert</label>
              <textarea
                className="planEditTextarea"
                value={rowState.content ?? ''}
                onChange={(e) => onChange({ content: e.target.value })}
                rows={3}
              />
            </>
          )}
          {edit.type === 'delete' && (
            <>
              <label className="planEditLabel">Text to delete</label>
              <textarea
                className="planEditTextarea planEditTextareaReadonly"
                value={edit.text ?? ''}
                readOnly
                rows={2}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function PlanModeView({ summary, edits, onExecute, onDismiss, executionState }: PlanModeViewProps) {
  const [rowStates, setRowStates] = useState<EditRowState[]>(() =>
    edits.map((e) => ({
      enabled: true,
      description: e.description,
      find: e.find,
      replacement: e.replacement,
      content: e.content,
      expanded: false,
      editingDescription: false,
    }))
  );

  const updateRow = useCallback((index: number, patch: Partial<EditRowState>) => {
    setRowStates((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  }, []);

  const approvedCount = rowStates.filter((r) => r.enabled).length;
  const completedSteps = executionState?.currentStep ?? 0;
  const allDone = executionState != null && !executionState.isRunning;
  const inEditMode = executionState != null;

  const handleExecute = () => {
    const enabledIndices = new Set(rowStates.map((r, i) => r.enabled ? i : -1).filter(i => i >= 0));
    const approved = edits
      .filter((_, i) => enabledIndices.has(i))
      .map((e) => {
        const s = rowStates[edits.indexOf(e)];
        return {
          ...e,
          description: s.description,
          ...(e.type === 'replace' ? { find: s.find, replacement: s.replacement } : {}),
          ...(e.type === 'insert' ? { content: s.content } : {}),
        };
      });
    onExecute(approved);
  };

  const currentStep = executionState?.currentStep ?? 0;
  const totalSteps = executionState?.totalSteps ?? edits.filter((_, i) => rowStates[i].enabled).length;

  return (
    <div className="planModeView">
      <div className="planModeHeader">
        {inEditMode ? (
          <>
            <span className="planModeTitle">
              {allDone
                ? executionState!.stopped
                  ? 'Stopped'
                  : executionState!.error
                  ? 'Error'
                  : 'Edits applied'
                : 'Applying edits\u2026'}
            </span>
            {!allDone && (
              <span className="planModeStepCounter">
                Step {currentStep} of {totalSteps}
              </span>
            )}
          </>
        ) : (
          <span className="planModeSummary">{summary}</span>
        )}
      </div>

      <div className="planEditList">
        {edits.map((edit, i) => (
          <EditRow
            key={edit.id}
            edit={edit}
            index={i}
            rowState={rowStates[i]}
            onChange={(patch) => updateRow(i, patch)}
            completedSteps={completedSteps}
            isRunning={executionState?.isRunning ?? false}
            allDone={allDone}
          />
        ))}
      </div>

      {executionState?.error && (
        <div className="planModeError">{executionState.error}</div>
      )}

      <div className="planModeActions">
        {!inEditMode ? (
          <>
            <button
              type="button"
              className="planExecuteBtn"
              disabled={approvedCount === 0}
              onClick={handleExecute}
            >
              Execute Plan{approvedCount !== edits.length ? ` (${approvedCount})` : ''}
            </button>
            <button type="button" className="planDismissBtn" onClick={onDismiss}>
              Dismiss
            </button>
          </>
        ) : executionState!.isRunning ? (
          <button type="button" className="planStopBtn" onClick={onDismiss}>
            Stop
          </button>
        ) : (
          <button type="button" className="planDismissBtn" onClick={onDismiss}>
            Close
          </button>
        )}
      </div>
    </div>
  );
}
