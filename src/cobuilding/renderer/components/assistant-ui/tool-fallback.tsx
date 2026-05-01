import React, { memo, useCallback, useRef, useState } from 'react';
import {
  AlertCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  LoaderIcon,
  XCircleIcon,
} from 'lucide-react';
import {
  useScrollLock,
  type ToolCallMessagePartStatus,
  type ToolCallMessagePartComponent,
} from '@assistant-ui/react';
import { FindAndReplaceSuggestion } from './find-and-replace-suggestion';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui/collapsible';
import { getToolLabel } from './tool-labels';
import { useToolElapsed, useSubagentProgress } from '../../progressStore';

const ANIMATION_DURATION = 200;

export type ToolFallbackRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  'open' | 'onOpenChange'
> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
};

function ToolFallbackRoot({
  className,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  children,
  ...props
}: ToolFallbackRootProps) {
  const collapsibleRef = useRef<HTMLDivElement>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION);

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        lockScroll();
      }
      if (!isControlled) {
        setUncontrolledOpen(open);
      }
      controlledOnOpenChange?.(open);
    },
    [lockScroll, isControlled, controlledOnOpenChange],
  );

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="tool-fallback-root"
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={`toolFallbackRoot${className ? ` ${className}` : ''}`}
      {...props}
    >
      {children}
    </Collapsible>
  );
}

type ToolStatus = ToolCallMessagePartStatus['type'];

const statusIconMap: Record<ToolStatus, React.ElementType> = {
  running: LoaderIcon,
  complete: CheckIcon,
  incomplete: XCircleIcon,
  'requires-action': AlertCircleIcon,
};

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

function ToolFallbackTrigger({
  toolName,
  toolCallId,
  status,
  args,
  argsText,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  toolName: string;
  toolCallId?: string;
  status?: ToolCallMessagePartStatus;
  args?: Record<string, unknown>;
  argsText?: string;
}) {
  const statusType = status?.type ?? 'complete';
  const isRunning = statusType === 'running';
  const isCancelled =
    status?.type === 'incomplete' && status.reason === 'cancelled';
  const elapsed = useToolElapsed(toolCallId ?? '');

  const Icon = statusIconMap[statusType];
  const humanLabel = isCancelled
    ? 'Cancelled tool'
    : getToolLabel(toolName, args, argsText);

  return (
    <CollapsibleTrigger
      data-slot="tool-fallback-trigger"
      className={`toolFallbackTrigger${className ? ` ${className}` : ''}`}
      {...props}
    >
      <Icon
        data-slot="tool-fallback-trigger-icon"
        className={`toolFallbackTriggerIcon${isCancelled ? ' toolFallbackTriggerIcon--cancelled' : ''}${isRunning ? ' toolFallbackTriggerIcon--running' : ''}`}
      />
      <span
        data-slot="tool-fallback-trigger-label"
        className={`toolFallbackTriggerLabel${isCancelled ? ' toolFallbackTriggerLabel--cancelled' : ''}`}
      >
        <span>{humanLabel}</span>
      </span>
      {isRunning && elapsed !== null && (
        <span className="toolElapsedTime">{formatElapsed(elapsed)}</span>
      )}
      <ChevronDownIcon
        data-slot="tool-fallback-trigger-chevron"
        className="toolFallbackChevron"
      />
    </CollapsibleTrigger>
  );
}

function ToolFallbackContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="tool-fallback-content"
      className={className}
      {...props}
    >
      <div className="toolFallbackContentInner">{children}</div>
    </CollapsibleContent>
  );
}

function ToolFallbackArgs({
  argsText,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  argsText?: string;
}) {
  if (!argsText) return null;

  return (
    <div
      data-slot="tool-fallback-args"
      className={`toolFallbackArgs${className ? ` ${className}` : ''}`}
      {...props}
    >
      <pre className="toolFallbackArgsValue">{argsText}</pre>
    </div>
  );
}

function ToolFallbackResult({
  result,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  result?: unknown;
}) {
  if (result === undefined) return null;

  return (
    <div
      data-slot="tool-fallback-result"
      className={`toolFallbackResult${className ? ` ${className}` : ''}`}
      {...props}
    >
      <p className="toolFallbackResultHeader">Result:</p>
      <pre className="toolFallbackResultContent">
        {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
      </pre>
    </div>
  );
}

function ToolFallbackError({
  status,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  status?: ToolCallMessagePartStatus;
}) {
  if (status?.type !== 'incomplete') return null;

  const error = status.error;
  const errorText = error
    ? typeof error === 'string'
      ? error
      : JSON.stringify(error)
    : null;

  if (!errorText) return null;

  const isCancelled = status.reason === 'cancelled';
  const headerText = isCancelled ? 'Cancelled reason:' : 'Error:';

  return (
    <div
      data-slot="tool-fallback-error"
      className={`toolFallbackErrorSection${className ? ` ${className}` : ''}`}
      {...props}
    >
      <p className="toolFallbackErrorHeader">{headerText}</p>
      <p className="toolFallbackErrorReason">{errorText}</p>
    </div>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

function SubagentStatusLine({ parentToolCallId }: { parentToolCallId: string }) {
  const progress = useSubagentProgress(parentToolCallId);
  if (!progress) return null;

  const isRunning = progress.status === 'running';
  const isDone = progress.status === 'completed';
  const isFailed = progress.status === 'failed' || progress.status === 'stopped';

  let statusText: string;
  if (isRunning) {
    const parts: string[] = [];
    if (progress.lastToolName) {
      parts.push(getToolLabel(progress.lastToolName, undefined));
    }
    if (progress.summary) {
      parts.push(progress.summary);
    }
    statusText = parts.join(' \u2014 ') || 'Working...';
  } else {
    statusText = progress.summary || (isDone ? 'Completed' : 'Failed');
  }

  return (
    <div className={`subagentStatusLine${isFailed ? ' subagentStatusLine--failed' : isDone ? ' subagentStatusLine--done' : ''}`}>
      {isRunning && <LoaderIcon className="subagentStatusIcon subagentStatusIcon--running" />}
      {isDone && <CheckIcon className="subagentStatusIcon subagentStatusIcon--done" />}
      {isFailed && <XCircleIcon className="subagentStatusIcon subagentStatusIcon--failed" />}
      <span className="subagentStatusText">{statusText}</span>
      {(progress.durationMs > 0 || progress.toolUseCount > 0) && (
        <span className="subagentStatusMeta">
          {progress.toolUseCount > 0 && `${progress.toolUseCount} tool${progress.toolUseCount !== 1 ? 's' : ''}`}
          {progress.toolUseCount > 0 && progress.durationMs > 0 && ' \u00b7 '}
          {progress.durationMs > 0 && formatDuration(progress.durationMs)}
        </span>
      )}
    </div>
  );
}

const ToolFallbackImpl: ToolCallMessagePartComponent = (props: any) => {
  const { toolName, toolCallId, args, argsText, result, status } = props;

  // Delegate to suggestion card for find_and_replace proposals from any host app.
  if (
    toolName === 'mcp__ms-word__find_and_replace' ||
    toolName === 'mcp__obsidian__find_and_replace'
  ) {
    return <FindAndReplaceSuggestion {...props} />;
  }

  const isCancelled =
    status?.type === 'incomplete' && status.reason === 'cancelled';
  const isAgent = toolName === 'Agent';

  return (
    <ToolFallbackRoot
      className={isCancelled ? 'toolFallbackRoot--cancelled' : ''}
    >
      <ToolFallbackTrigger toolName={toolName} toolCallId={toolCallId} status={status} args={args} argsText={argsText} />
      {isAgent && <SubagentStatusLine parentToolCallId={toolCallId} />}
      <ToolFallbackContent>
        <p className="toolFallbackDetailHeader">Used tool: {toolName}</p>
        <ToolFallbackError status={status} />
        <ToolFallbackArgs
          argsText={argsText}
          className={isCancelled ? 'toolFallbackArgs--cancelled' : undefined}
        />
        {!isCancelled && <ToolFallbackResult result={result} />}
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
};

const ToolFallback = memo(
  ToolFallbackImpl,
) as unknown as ToolCallMessagePartComponent & {
  Root: typeof ToolFallbackRoot;
  Trigger: typeof ToolFallbackTrigger;
  Content: typeof ToolFallbackContent;
  Args: typeof ToolFallbackArgs;
  Result: typeof ToolFallbackResult;
  Error: typeof ToolFallbackError;
};

ToolFallback.displayName = 'ToolFallback';
ToolFallback.Root = ToolFallbackRoot;
ToolFallback.Trigger = ToolFallbackTrigger;
ToolFallback.Content = ToolFallbackContent;
ToolFallback.Args = ToolFallbackArgs;
ToolFallback.Result = ToolFallbackResult;
ToolFallback.Error = ToolFallbackError;

export {
  ToolFallback,
  ToolFallbackRoot,
  ToolFallbackTrigger,
  ToolFallbackContent,
  ToolFallbackArgs,
  ToolFallbackResult,
  ToolFallbackError,
};
