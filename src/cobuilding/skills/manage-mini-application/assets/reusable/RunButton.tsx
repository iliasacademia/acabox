import React from "react";
import { LoaderIcon, PlayIcon } from "lucide-react";
import type { UseKernelActionResult } from "./useKernelAction";

// Standard "Run" button for a kernel-backed mini-app.
//
// Drives all the visual state from `useKernelAction`'s result: spinner
// while running, elapsed seconds, disabled while running. The agent only
// has to decide the label and the additional `disabled` condition (e.g.
// "no input file selected").
//
// Styling comes from `ab-btn` in `_vendor/acabox.css` rather than Tailwind
// colour utilities, so the button tracks the design tokens instead of pinning
// a hex that has to be chased when the palette moves.

interface RunButtonProps {
  action: UseKernelActionResult;
  onRun: () => void;
  /** Additional disabled condition beyond "currently running". */
  disabled?: boolean;
  /** Button label when idle. Defaults to "Run". */
  children?: React.ReactNode;
}

export function RunButton({
  action,
  onRun,
  disabled = false,
  children = "Run",
}: RunButtonProps) {
  const isRunning = action.phase === "running";
  const isDisabled = isRunning || disabled;

  return (
    <button
      onClick={onRun}
      disabled={isDisabled}
      className="ab-btn ab-btn--primary ab-btn--lg"
    >
      {isRunning ? (
        <>
          <LoaderIcon className="w-4 h-4 animate-spin" />
          Running... ({action.elapsedSeconds}s)
        </>
      ) : (
        <>
          <PlayIcon className="w-4 h-4" />
          {children}
        </>
      )}
    </button>
  );
}
