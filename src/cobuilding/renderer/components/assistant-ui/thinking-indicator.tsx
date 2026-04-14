import React, { memo, useCallback, useRef, useState } from 'react';
import { ChevronDownIcon, LoaderIcon } from 'lucide-react';
import { useMessagePartReasoning, useScrollLock } from '@assistant-ui/react';
import type { ReasoningMessagePartComponent } from '@assistant-ui/react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui/collapsible';

const ANIMATION_DURATION = 200;

const ReasoningImpl: ReasoningMessagePartComponent = () => {
  const { text, status } = useMessagePartReasoning();
  const collapsibleRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION);
  const isRunning = status.type === 'running';

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) lockScroll();
      setIsOpen(open);
    },
    [lockScroll],
  );

  return (
    <Collapsible
      ref={collapsibleRef}
      open={isOpen}
      onOpenChange={handleOpenChange}
      className="reasoningRoot"
    >
      <CollapsibleTrigger className="reasoningTrigger">
        {isRunning && (
          <LoaderIcon className="reasoningIcon reasoningIcon--running" />
        )}
        <span className="reasoningLabel">
          {isRunning ? 'Thinking' : 'Thought'}
        </span>
        <ChevronDownIcon className="reasoningChevron" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="reasoningContent">
          <pre className="reasoningText">{text}</pre>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};

export const Reasoning = memo(ReasoningImpl) as unknown as ReasoningMessagePartComponent;
Reasoning.displayName = 'Reasoning';
