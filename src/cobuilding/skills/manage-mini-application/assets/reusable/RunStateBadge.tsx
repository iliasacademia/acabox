import React from "react";
import { AlertTriangleIcon } from "lucide-react";
import type { Freshness } from "./useAppState";

// "Results out of date" badge driven by `useAppState`'s `freshness`.
//
// Renders nothing when freshness is `'never'` or `'fresh'`. Shows the amber
// pill when freshness is `'stale'` — i.e. the user has changed a param
// since the last `markRunComplete` and any displayed results no longer
// reflect the current configuration.

interface RunStateBadgeProps {
  freshness: Freshness;
}

export function RunStateBadge({ freshness }: RunStateBadgeProps) {
  if (freshness !== "stale") return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800">
      <AlertTriangleIcon className="w-3.5 h-3.5" />
      Results out of date — params have changed since last run
    </span>
  );
}
