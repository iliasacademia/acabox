import React, {
  memo,
  useCallback,
  useRef,
  useState,
  type FC,
  type PropsWithChildren,
} from 'react';
import { ChevronDownIcon, LoaderIcon } from 'lucide-react';
import { useScrollLock } from '@assistant-ui/react';
import { SuggestionGroupProvider, SuggestionBatchHeader } from './find-and-replace-suggestion';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui/collapsible';

const ANIMATION_DURATION = 200;

type ToolGroupVariant = 'outline' | 'ghost' | 'muted';

export type ToolGroupRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  'open' | 'onOpenChange'
> & {
  variant?: ToolGroupVariant;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
};

function ToolGroupRoot({
  className,
  variant = 'outline',
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  children,
  ...props
}: ToolGroupRootProps) {
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
      data-slot="tool-group-root"
      data-variant={variant}
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={`toolGroupRoot toolGroupRoot--${variant}${className ? ` ${className}` : ''}`}
      {...props}
    >
      {children}
    </Collapsible>
  );
}

function ToolGroupTrigger({
  count,
  active = false,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  count: number;
  active?: boolean;
}) {
  const label = `${count} tool ${count === 1 ? 'call' : 'calls'}`;

  return (
    <CollapsibleTrigger
      data-slot="tool-group-trigger"
      className={`toolGroupTrigger${className ? ` ${className}` : ''}`}
      {...props}
    >
      {active && (
        <LoaderIcon
          data-slot="tool-group-trigger-loader"
          className="toolGroupTriggerLoader"
        />
      )}
      <span
        data-slot="tool-group-trigger-label"
        className="toolGroupTriggerLabel"
      >
        <span>{label}</span>
      </span>
      <ChevronDownIcon
        data-slot="tool-group-trigger-chevron"
        className="toolGroupChevron"
      />
    </CollapsibleTrigger>
  );
}

function ToolGroupContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="tool-group-content"
      className={className}
      {...props}
    >
      <div className="toolGroupContentInner">{children}</div>
    </CollapsibleContent>
  );
}

type ToolGroupComponent = FC<
  PropsWithChildren<{ startIndex: number; endIndex: number }>
> & {
  Root: typeof ToolGroupRoot;
  Trigger: typeof ToolGroupTrigger;
  Content: typeof ToolGroupContent;
};

const ToolGroupImpl: FC<
  PropsWithChildren<{ startIndex: number; endIndex: number }>
> = ({ children }) => {
  return (
    <SuggestionGroupProvider>
      <SuggestionBatchHeader />
      {children}
    </SuggestionGroupProvider>
  );
};

const ToolGroup = memo(ToolGroupImpl) as unknown as ToolGroupComponent;

ToolGroup.displayName = 'ToolGroup';
ToolGroup.Root = ToolGroupRoot;
ToolGroup.Trigger = ToolGroupTrigger;
ToolGroup.Content = ToolGroupContent;

export {
  ToolGroup,
  ToolGroupRoot,
  ToolGroupTrigger,
  ToolGroupContent,
};
