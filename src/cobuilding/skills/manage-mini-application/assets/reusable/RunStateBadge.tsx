import React from "react";
import { AlertTriangleIcon } from "lucide-react";
import type { Freshness } from "./useAppState";

// "Results out of date" badge driven by `useAppState`'s `freshness`.
//
// Renders nothing when freshness is `'never'` or `'fresh'`. Shows the tag
// when freshness is `'stale'` — i.e. the user has changed a param since the
// last `markRunComplete` and any displayed results no longer reflect the
// current configuration.
//
// Stale is a *busy-adjacent* state, not an error: nothing is broken, the
// numbers are just behind. It reads in the token palette's amber rather than
// error red for that reason.

interface RunStateBadgeProps {
  freshness: Freshness;
}

export function RunStateBadge({ freshness }: RunStateBadgeProps) {
  if (freshness !== "stale") return null;
  return (
    <span className="ab-tag ab-tag--warn ab-tag--text">
      <AlertTriangleIcon className="w-3.5 h-3.5" />
      Results out of date — params have changed since last run
    </span>
  );
}
