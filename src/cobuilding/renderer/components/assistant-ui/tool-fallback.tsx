import React, { memo, useEffect, useState } from 'react';
import type { ToolCallMessagePartComponent, ToolCallMessagePartStatus } from '@assistant-ui/react';
import { MSymbol } from '../command-desk/MSymbol';
import { useToolElapsed, useToolFinalElapsed, useSubagentProgress } from '../../progressStore';
import {
  getToolCardDisplay,
  resolveToolArgs,
  toolResultToText,
  formatToolSeconds,
} from './tool-card-display';

/**
 * Tool-call card — an instrument readout, not a chat bubble (Phase B spec).
 * Collapsed row: status dot · tool icon · mono name · key args · right meta ·
 * chevron. Expanded: the result tail in a mono <pre>. Errors tint the card
 * and auto-expand on completion.
 */

function SubagentStatusLine({ parentToolCallId }: { parentToolCallId: string }) {
  const progress = useSubagentProgress(parentToolCallId);
  if (!progress) return null;

  const parts: string[] = [];
  if (progress.status === 'running') {
    if (progress.summary) parts.push(progress.summary);
    else parts.push('WORKING');
  } else {
    parts.push(progress.summary || progress.status.toUpperCase());
  }
  if (progress.toolUseCount > 0) parts.push(`${progress.toolUseCount} TOOLS`);
  if (progress.durationMs > 0) parts.push(formatToolSeconds(progress.durationMs / 1000));

  return <div className="cdTool__subline">{parts.join(' · ')}</div>;
}

const ToolFallbackImpl: ToolCallMessagePartComponent = (props: any) => {
  const { toolName, toolCallId, args, argsText, result, isError, status } = props as {
    toolName: string;
    toolCallId: string;
    args?: Record<string, unknown>;
    argsText?: string;
    result?: unknown;
    isError?: boolean;
    status?: ToolCallMessagePartStatus;
  };

  const statusType = status?.type ?? 'complete';
  const isRunning = statusType === 'running';
  const isCancelled = statusType === 'incomplete' && (status as any)?.reason === 'cancelled';
  const failed = !isRunning && (isError === true || (statusType === 'incomplete' && !isCancelled));

  const [open, setOpen] = useState(false);
  // Errors auto-expand once, when the failure lands.
  useEffect(() => {
    if (failed) setOpen(true);
  }, [failed]);

  const display = getToolCardDisplay(toolName, args, argsText);
  const elapsed = useToolElapsed(toolCallId);
  const finalElapsed = useToolFinalElapsed(toolCallId);
  const outputText = toolResultToText(result);

  let meta: React.ReactNode = null;
  if (isRunning) {
    meta = (
      <span className="cdTool__meta cdTool__meta--running">
        {elapsed != null ? `RUNNING · ${formatToolSeconds(elapsed)}` : 'RUNNING'}
      </span>
    );
  } else if (isCancelled) {
    meta = <span className="cdTool__meta">CANCELLED</span>;
  } else if (failed) {
    meta = <span className="cdTool__meta cdTool__meta--error">{extractExitMeta(toolName, args, argsText, outputText) ?? 'ERROR'}</span>;
  } else if (finalElapsed != null) {
    meta = <span className="cdTool__meta">{formatToolSeconds(finalElapsed)}</span>;
  } else {
    const lineMeta = resultLineMeta(toolName, args, argsText, outputText);
    if (lineMeta) meta = <span className="cdTool__meta">{lineMeta}</span>;
  }

  const expandable = outputText.length > 0;
  const dotClass = isRunning
    ? 'cdDot--busy cdDot--pulse'
    : failed
      ? 'cdDot--error'
      : isCancelled
        ? 'cdDot--sleeping'
        : 'cdDot--running';

  return (
    <div className={`cdTool${failed ? ' cdTool--error' : ''}${open && expandable ? ' cdTool--open' : ''}`}>
      <button
        type="button"
        className="cdTool__row"
        onClick={() => expandable && setOpen((v) => !v)}
        aria-expanded={open && expandable}
      >
        <span className={`cdDot ${dotClass}`} />
        <MSymbol name={display.icon} size={15} className="cdTool__icon" />
        <span className="cdTool__name">{display.name}</span>
        <span className="cdTool__args">{display.args}</span>
        {meta}
        {expandable && (
          <MSymbol name={open ? 'expand_less' : 'expand_more'} size={16} className="cdTool__chevron" />
        )}
      </button>
      {toolName === 'Agent' && <SubagentStatusLine parentToolCallId={toolCallId} />}
      {open && expandable && (
        <pre className={`cdTool__out${failed ? ' cdTool__outError' : ''}`}>{outputText}</pre>
      )}
    </div>
  );
};

/** "EXIT 1" when a Bash failure reports its exit code; null otherwise. */
function extractExitMeta(
  toolName: string,
  args: Record<string, unknown> | undefined,
  argsText: string | undefined,
  output: string,
): string | null {
  if (toolName !== 'Bash') return null;
  const m = output.match(/exit(?:ed with)?(?: code| status)?[ :]+(\d+)/i);
  return m ? `EXIT ${m[1]}` : null;
}

/** Line-count meta for file and shell instruments when no duration is known. */
function resultLineMeta(
  toolName: string,
  args: Record<string, unknown> | undefined,
  argsText: string | undefined,
  output: string,
): string | null {
  if (toolName === 'Write' || toolName === 'Edit') {
    const a = resolveToolArgs(args, argsText);
    const content = a?.content ?? a?.new_string;
    if (typeof content === 'string' && content.length > 0) {
      return `${content.split('\n').length} LINES`;
    }
    return null;
  }
  if ((toolName === 'Read' || toolName === 'Bash') && output) {
    const lines = output.split('\n').length;
    if (lines > 1) return `${lines} LINES`;
  }
  return null;
}

const ToolFallback = memo(ToolFallbackImpl) as unknown as ToolCallMessagePartComponent;
(ToolFallback as any).displayName = 'ToolFallback';

export { ToolFallback };
