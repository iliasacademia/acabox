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
});

// Window info with required bounds - for most window events
const WindowInfoWithBoundsSchema = z.object({
  id: z.string().min(1),
  title: z.string().nullable(),
  documentPath: z.string().nullable(),
  bounds: WindowBoundsSchema,
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
};

/**
 * Validate an event against its expected schema.
 * @param {object} event - The event object to validate
 * @returns {{ success: boolean, error?: string, eventType?: string }}
 */
function validateEvent(event) {
  const result = WindowMonitorEventSchema.safeParse(event);
  if (result.success) {
    return { success: true, eventType: event.event };
  } else {
    return {
      success: false,
      eventType: event.event,
      error: result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    };
  }
}

/**
 * Validate an array of events.
 * @param {object[]} events - Array of events to validate
 * @returns {{ valid: number, invalid: number, errors: Array<{index: number, eventType: string, error: string}> }}
 */
function validateEvents(events) {
  const errors = [];
  let valid = 0;
  let invalid = 0;

  events.forEach((event, index) => {
    const result = validateEvent(event);
    if (result.success) {
      valid++;
    } else {
      invalid++;
      errors.push({
        index,
        eventType: result.eventType,
        error: result.error,
      });
    }
  });

  return { valid, invalid, errors };
}

module.exports = {
  // Individual schemas
  PlatformSchema,
  AppInfoSchema,
  WindowBoundsSchema,
  WindowInfoSchema,
  WindowInfoWithBoundsSchema,
  BaseEventSchema,

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

  // Union schema
  WindowMonitorEventSchema,

  // Helpers
  EventSchemaMap,
  APP_EVENTS,
  WINDOW_EVENTS,
  validateEvent,
  validateEvents,
};
