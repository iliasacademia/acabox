// Event and state types for window-monitor.
// Mirrors the Zod schemas in window-monitor/test/event-schemas.js.

// --- Shared sub-structures ---

export interface AppInfo {
  pid: number;
  name: string;
  identifier: string;
  identifierType: 'bundleId';
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowInfo {
  id: string;
  title: string | null;
  documentPath: string | null;
  bounds: WindowBounds | null;
  contentBounds?: WindowBounds;
}

export interface WindowInfoWithBounds {
  id: string;
  title: string | null;
  documentPath: string | null;
  bounds: WindowBounds;
  contentBounds?: WindowBounds;
}

// --- Event types ---

interface BaseEvent {
  timestamp: string;
  platform: 'macos';
  app: AppInfo;
}

export interface AppExistingEvent extends BaseEvent {
  event: 'APP_EXISTING';
}

export interface AppLaunchedEvent extends BaseEvent {
  event: 'APP_LAUNCHED';
}

export interface AppTerminatedEvent extends BaseEvent {
  event: 'APP_TERMINATED';
}

export interface AppFocusedEvent extends BaseEvent {
  event: 'APP_FOCUSED';
}

export interface AppUnfocusedEvent extends BaseEvent {
  event: 'APP_UNFOCUSED';
}

export interface WindowExistingEvent extends BaseEvent {
  event: 'WINDOW_EXISTING';
  window: WindowInfoWithBounds;
}

export interface WindowCreatedEvent extends BaseEvent {
  event: 'WINDOW_CREATED';
  window: WindowInfoWithBounds;
}

export interface WindowDestroyedEvent extends BaseEvent {
  event: 'WINDOW_DESTROYED';
  window: WindowInfo;
}

export interface WindowFocusedEvent extends BaseEvent {
  event: 'WINDOW_FOCUSED';
  window: WindowInfoWithBounds;
}

export interface WindowRepositioningEvent extends BaseEvent {
  event: 'WINDOW_REPOSITIONING';
  window: WindowInfoWithBounds;
}

export interface WindowRepositionedEvent extends BaseEvent {
  event: 'WINDOW_REPOSITIONED';
  window: WindowInfoWithBounds;
}

export interface WindowDocumentPathChangedEvent extends BaseEvent {
  event: 'WINDOW_DOCUMENT_PATH_CHANGED';
  window: WindowInfoWithBounds;
}

export interface TextSelectionInfo {
  filePath: string;
  length: number;
  bounds?: WindowBounds;
}

export interface SelectionPositionInfo {
  bounds: WindowBounds;
}

export interface WindowTextSelectedEvent extends BaseEvent {
  event: 'WINDOW_TEXT_SELECTED';
  window: WindowInfoWithBounds;
  selection: TextSelectionInfo;
}

export interface WindowTextSelectionClearedEvent extends BaseEvent {
  event: 'WINDOW_TEXT_SELECTION_CLEARED';
  window: WindowInfoWithBounds;
}

export interface WindowTextSelectionRepositioningEvent extends BaseEvent {
  event: 'WINDOW_TEXT_SELECTION_REPOSITIONING';
  window: WindowInfoWithBounds;
  selection: SelectionPositionInfo;
}

export interface WindowTextSelectionRepositionedEvent extends BaseEvent {
  event: 'WINDOW_TEXT_SELECTION_REPOSITIONED';
  window: WindowInfoWithBounds;
  selection: SelectionPositionInfo;
}

export interface DocumentTextInfo {
  filePath: string;
  characterCount: number;
  byteSize: number;
}

export interface WindowDocumentTextChangedEvent extends BaseEvent {
  event: 'WINDOW_DOCUMENT_TEXT_CHANGED';
  window: WindowInfoWithBounds;
  document: DocumentTextInfo;
}

export type WindowMonitorEvent =
  | AppExistingEvent
  | AppLaunchedEvent
  | AppTerminatedEvent
  | AppFocusedEvent
  | AppUnfocusedEvent
  | WindowExistingEvent
  | WindowCreatedEvent
  | WindowDestroyedEvent
  | WindowFocusedEvent
  | WindowRepositioningEvent
  | WindowRepositionedEvent
  | WindowDocumentPathChangedEvent
  | WindowTextSelectedEvent
  | WindowTextSelectionClearedEvent
  | WindowTextSelectionRepositioningEvent
  | WindowTextSelectionRepositionedEvent
  | WindowDocumentTextChangedEvent;

// --- State types ---

export interface WindowState {
  id: string;
  title: string | null;
  documentPath: string | null;
  bounds: WindowBounds | null;
  contentBounds: WindowBounds | null;
  selectionBounds: WindowBounds | null;
  isFocused: boolean;
  isRepositioning: boolean;
  selectedText: TextSelectionInfo | null;
  documentText: DocumentTextInfo | null;
}

export interface AppState {
  pid: number;
  name: string;
  identifier: string;
  identifierType: 'bundleId';
  isFocused: boolean;
  focusedWindowId: string | null;
  windows: WindowState[];
}

export interface SystemState {
  apps: AppState[];
  focusedAppIdentifier: string | null;
  focusedAppPid: number | null;
  lastEventTimestamp: string | null;
}
