import React from "react";
import { UploadIcon, XIcon } from "lucide-react";

// One-line file picker for an input slot managed by `useAppState`.
//
// Replaces the dance of:
//   - reading `params[slot]` to know if a file is set
//   - rendering an upload button vs. a filename + clear control
//   - wiring `selectInput(slot, filters)` and `clearInput(slot)`
//
// Pass the entire `useAppState` result as `state` and the slot name; the
// component handles everything else.

interface SlotState<P extends Record<string, unknown>> {
  params: P;
  selectInput: (
    slot: keyof P & string,
    filters?: { name: string; extensions: string[] }[],
  ) => Promise<string | null>;
  clearInput: (slot: keyof P & string) => Promise<void>;
}

interface FileSlotPickerProps<P extends Record<string, unknown>> {
  state: SlotState<P>;
  slot: keyof P & string;
  label: string;
  filters?: { name: string; extensions: string[] }[];
}

export function FileSlotPicker<P extends Record<string, unknown>>({
  state,
  slot,
  label,
  filters,
}: FileSlotPickerProps<P>) {
  const value = state.params[slot];
  const path = typeof value === "string" ? value : "";
  const filename = path ? path.split("/").pop() ?? path : "";

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-gray-600 w-44 flex-shrink-0">{label}</span>
      {path ? (
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-sm text-gray-800 truncate" title={path}>
            {filename}
          </span>
          <button
            onClick={() => state.clearInput(slot)}
            className="text-gray-400 hover:text-gray-600"
            aria-label={`Clear ${label}`}
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <button
          onClick={() => state.selectInput(slot, filters)}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50 transition-colors"
        >
          <UploadIcon className="w-4 h-4" />
          Choose file
        </button>
      )}
    </div>
  );
}
