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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui/collapsible';
import { getToolLabel } from './tool-labels';

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

function ToolFallbackTrigger({
  toolName,
  status,
  args,
  argsText,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  toolName: string;
  status?: ToolCallMessagePartStatus;
  args?: Record<string, unknown>;
  argsText?: string;
}) {
  const statusType = status?.type ?? 'complete';
  const isRunning = statusType === 'running';
  const isCancelled =
    status?.type === 'incomplete' && status.reason === 'cancelled';

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

const ToolFallbackImpl: ToolCallMessagePartComponent = ({
  toolName,
  args,
  argsText,
  result,
  status,
}: any) => {
  const isCancelled =
    status?.type === 'incomplete' && status.reason === 'cancelled';

  return (
    <ToolFallbackRoot
      className={isCancelled ? 'toolFallbackRoot--cancelled' : ''}
    >
      <ToolFallbackTrigger toolName={toolName} status={status} args={args} argsText={argsText} />
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
