import React from "react";
import { LoaderIcon, PlayIcon } from "lucide-react";
import type { UseKernelActionResult } from "./useKernelAction";

// Standard "Run" button for a kernel-backed mini-app.
//
// Drives all the visual state from `useKernelAction`'s result: spinner
// while running, elapsed seconds, disabled while running. The agent only
// has to decide the label and the additional `disabled` condition (e.g.
// "no input file selected").

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
      className={`flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-medium transition-colors ${
        isDisabled
          ? "bg-gray-200 text-gray-400 cursor-not-allowed"
          : "bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800"
      }`}
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
