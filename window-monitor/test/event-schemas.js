/**
 * Zod schemas for window-monitor events.
 *
 * These schemas define the expected structure for all event types
 * emitted by the window-monitor binary.
 */

const { z } = require('zod');

// Platform enum
const PlatformSchema = z.literal('macos');

// App info schema - present in all events
const AppInfoSchema = z.object({
  pid: z.number().int().positive(),
  name: z.string().min(1),
  identifier: z.string().min(1),
  identifierType: z.literal('bundleId'),
});

// Window bounds schema
const WindowBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

// Window info schema - present in window events
const WindowInfoSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullable(),
  documentPath: z.string().nullable(),
  bounds: WindowBoundsSchema.nullable(),
  contentBounds: WindowBoundsSchema.optional(),
});

// Window info with required bounds - for most window events
const WindowInfoWithBoundsSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullable(),
  documentPath: z.string().nullable(),
  bounds: WindowBoundsSchema,
  contentBounds: WindowBoundsSchema.optional(),
});

// Base event schema - common fields for all events
const BaseEventSchema = z.object({
  timestamp: z.string().datetime(),
  platform: PlatformSchema,
  app: AppInfoSchema,
});

// ============================================
// App-level event schemas (no window info)
// ============================================

const AppExistingEventSchema = BaseEventSchema.extend({
  event: z.literal('APP_EXISTING'),
});

const AppLaunchedEventSchema = BaseEventSchema.extend({
  event: z.literal('APP_LAUNCHED'),
});

const AppTerminatedEventSchema = BaseEventSchema.extend({
  event: z.literal('APP_TERMINATED'),
});

const AppFocusedEventSchema = BaseEventSchema.extend({
  event: z.literal('APP_FOCUSED'),
});

const AppUnfocusedEventSchema = BaseEventSchema.extend({
  event: z.literal('APP_UNFOCUSED'),
});

// ============================================
// Window-level event schemas (with window info)
// ============================================

const WindowExistingEventSchema = BaseEventSchema.extend({
  event: z.literal('WINDOW_EXISTING'),
  window: WindowInfoWithBoundsSchema,
});

const WindowCreatedEventSchema = BaseEventSchema.extend({
  event: z.literal('WINDOW_CREATED'),
  window: WindowInfoWithBoundsSchema,
});

// WINDOW_DESTROYED may have null bounds and title (window no longer exists)
const WindowDestroyedEventSchema = BaseEventSchema.extend({
  event: z.literal('WINDOW_DESTROYED'),
  window: WindowInfoSchema,
});

const WindowFocusedEventSchema = BaseEventSchema.extend({
  event: z.literal('WINDOW_FOCUSED'),
  window: WindowInfoWithBoundsSchema,
});

const WindowRepositioningEventSchema = BaseEventSchema.extend({
  event: z.literal('WINDOW_REPOSITIONING'),
  window: WindowInfoWithBoundsSchema,
});

const WindowRepositionedEventSchema = BaseEventSchema.extend({
  event: z.literal('WINDOW_REPOSITIONED'),
  window: WindowInfoWithBoundsSchema,
});

const WindowDocumentPathChangedEventSchema = BaseEventSchema.extend({
  event: z.literal('WINDOW_DOCUMENT_PATH_CHANGED'),
  window: WindowInfoWithBoundsSchema,
});

// ============================================
// Text selection event schemas
// ============================================

const SelectionBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const TextSelectionInfoSchema = z.object({
  filePath: z.string().min(1),
  length: z.number().int().nonnegative(),
  bounds: SelectionBoundsSchema.optional(),
});

const WindowTextSelectedEventSchema = BaseEventSchema.extend({
  event: z.literal('WINDOW_TEXT_SELECTED'),
  window: WindowInfoWithBoundsSchema,
  selection: TextSelectionInfoSchema,
});

const WindowTextSelectionClearedEventSchema = BaseEventSchema.extend({
  event: z.literal('WINDOW_TEXT_SELECTION_CLEARED'),
  window: WindowInfoWithBoundsSchema,
});

const WindowTextSelectionRepositioningEventSchema = BaseEventSchema.extend({
  event: z.literal('WINDOW_TEXT_SELECTION_REPOSITIONING'),
  window: WindowInfoWithBoundsSchema,
  selection: z.object({
    bounds: SelectionBoundsSchema,
  }),
});

const WindowTextSelectionRepositionedEventSchema = BaseEventSchema.extend({
  event: z.literal('WINDOW_TEXT_SELECTION_REPOSITIONED'),
  window: WindowInfoWithBoundsSchema,
  selection: z.object({
    bounds: SelectionBoundsSchema,
  }),
});

// ============================================
// Document text event schema
// ============================================

const DocumentTextInfoSchema = z.object({
  filePath: z.string().min(1),
  characterCount: z.number().int().nonnegative(),
  byteSize: z.number().int().nonnegative(),
});

const WindowDocumentTextChangedEventSchema = BaseEventSchema.extend({
  event: z.literal('WINDOW_DOCUMENT_TEXT_CHANGED'),
  window: WindowInfoWithBoundsSchema,
  document: DocumentTextInfoSchema,
});

// ============================================
// Union schema for any event
// ============================================

const WindowMonitorEventSchema = z.discriminatedUnion('event', [
  AppExistingEventSchema,
  AppLaunchedEventSchema,
  AppTerminatedEventSchema,
  AppFocusedEventSchema,
  AppUnfocusedEventSchema,
  WindowExistingEventSchema,
  WindowCreatedEventSchema,
  WindowDestroyedEventSchema,
  WindowFocusedEventSchema,
  WindowRepositioningEventSchema,
  WindowRepositionedEventSchema,
  WindowDocumentPathChangedEventSchema,
  WindowTextSelectedEventSchema,
  WindowTextSelectionClearedEventSchema,
  WindowTextSelectionRepositioningEventSchema,
  WindowTextSelectionRepositionedEventSchema,
  WindowDocumentTextChangedEventSchema,
]);

// ============================================
// Event type categories
// ============================================

const APP_EVENTS = [
  'APP_EXISTING',
  'APP_LAUNCHED',
  'APP_TERMINATED',
  'APP_FOCUSED',
  'APP_UNFOCUSED',
];

const WINDOW_EVENTS = [
  'WINDOW_EXISTING',
  'WINDOW_CREATED',
  'WINDOW_DESTROYED',
  'WINDOW_FOCUSED',
  'WINDOW_REPOSITIONING',
  'WINDOW_REPOSITIONED',
  'WINDOW_DOCUMENT_PATH_CHANGED',
  'WINDOW_TEXT_SELECTED',
  'WINDOW_TEXT_SELECTION_CLEARED',
  'WINDOW_TEXT_SELECTION_REPOSITIONING',
  'WINDOW_TEXT_SELECTION_REPOSITIONED',
  'WINDOW_DOCUMENT_TEXT_CHANGED',
];

// Map event types to their specific schemas
const EventSchemaMap = {
  APP_EXISTING: AppExistingEventSchema,
  APP_LAUNCHED: AppLaunchedEventSchema,
  APP_TERMINATED: AppTerminatedEventSchema,
  APP_FOCUSED: AppFocusedEventSchema,
  APP_UNFOCUSED: AppUnfocusedEventSchema,
  WINDOW_EXISTING: WindowExistingEventSchema,
  WINDOW_CREATED: WindowCreatedEventSchema,
  WINDOW_DESTROYED: WindowDestroyedEventSchema,
  WINDOW_FOCUSED: WindowFocusedEventSchema,
  WINDOW_REPOSITIONING: WindowRepositioningEventSchema,
  WINDOW_REPOSITIONED: WindowRepositionedEventSchema,
  WINDOW_DOCUMENT_PATH_CHANGED: WindowDocumentPathChangedEventSchema,
  WINDOW_TEXT_SELECTED: WindowTextSelectedEventSchema,
  WINDOW_TEXT_SELECTION_CLEARED: WindowTextSelectionClearedEventSchema,
  WINDOW_TEXT_SELECTION_REPOSITIONING: WindowTextSelectionRepositioningEventSchema,
  WINDOW_TEXT_SELECTION_REPOSITIONED: WindowTextSelectionRepositionedEventSchema,
  WINDOW_DOCUMENT_TEXT_CHANGED: WindowDocumentTextChangedEventSchema,
};

/**
 * Validate an event against its specific schema based on event type.
 * @param {object} event - The event object to validate
 * @returns {{ success: boolean, error?: string, eventType?: string, schemaUsed?: string }}
 */
function validateEvent(event) {
  const eventType = event?.event;

  // Check if we have a specific schema for this event type
  const specificSchema = EventSchemaMap[eventType];
  if (!specificSchema) {
    return {
      success: false,
      eventType: eventType || 'unknown',
      schemaUsed: null,
      error: `Unknown event type: ${eventType}`,
    };
  }

  // Validate against the specific schema for this event type
  const result = specificSchema.safeParse(event);
  if (result.success) {
    return { success: true, eventType, schemaUsed: eventType };
  } else {
    return {
      success: false,
      eventType,
      schemaUsed: eventType,
      error: result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    };
  }
}

module.exports = {
  // Individual schemas
  PlatformSchema,
  AppInfoSchema,
  WindowBoundsSchema,
  SelectionBoundsSchema,
  WindowInfoSchema,
  WindowInfoWithBoundsSchema,
  BaseEventSchema,
  TextSelectionInfoSchema,
  DocumentTextInfoSchema,

  // Event schemas
  AppExistingEventSchema,
  AppLaunchedEventSchema,
  AppTerminatedEventSchema,
  AppFocusedEventSchema,
  AppUnfocusedEventSchema,
  WindowExistingEventSchema,
  WindowCreatedEventSchema,
  WindowDestroyedEventSchema,
  WindowFocusedEventSchema,
  WindowRepositioningEventSchema,
  WindowRepositionedEventSchema,
  WindowDocumentPathChangedEventSchema,
  WindowTextSelectedEventSchema,
  WindowTextSelectionClearedEventSchema,
  WindowTextSelectionRepositioningEventSchema,
  WindowTextSelectionRepositionedEventSchema,
  WindowDocumentTextChangedEventSchema,

  // Union schema
  WindowMonitorEventSchema,

  // Helpers
  EventSchemaMap,
  APP_EVENTS,
  WINDOW_EVENTS,
  validateEvent,
};
