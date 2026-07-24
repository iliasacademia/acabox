/**
 * Shared type definitions for CoScientist product analytics.
 *
 * Every event posted by the analytics emit modules conforms to
 * `CoScientistEventEnvelope`. The discriminated union `CoScientistEvent`
 * narrows the per-event `metadata` payload by event_name — adding a new
 * event = adding a union member, which surfaces drift at compile time.
 *
 * See `src/cobuilding/docs/ANALYTICS.md` for the strategy overview and
 * the current catalog of events being emitted.
 */

export type CoScientistChannel = 'production' | 'development';

/**
 * UI surface that emitted the event. Hardcoded per emit site —
 * never derived from process state. `background` is used for
 * events that fire when no user-facing surface is involved
 * (scheduled tasks, background-agent-initiated briefing creates).
 */
export type CoScientistSurface =
  | 'main'
  | 'word-overlay'
  | 'popup'
  | 'quick-chat'
  | 'paper-monitor'
  | 'reactions'
  | 'background';

/** Narrowed from NodeJS.Platform — only desktop platforms we ship. */
export type CoScientistPlatform = 'darwin' | 'win32' | 'linux';

/** Narrowed from NodeJS.Architecture — only architectures we ship. */
export type CoScientistArch = 'x64' | 'arm64';

/**
 * Top-level context attached to every event. These fields live at the
 * top of `data` (not inside `metadata`) so dashboard SQL can extract
 * them with a single JSON path segment.
 */
export interface TelemetryContext {
  installation_id: string;
  release: string;
  channel: CoScientistChannel;
  surface: CoScientistSurface;
  platform: CoScientistPlatform;
  arch: CoScientistArch;
  os_version: string;
  electron_version: string;
  chromium_version: string;
  node_version: string;
}

// ---------------------------------------------------------------------------
// Event catalog — one union member per event we emit.
// Adding a new event: add a member here, then call track({ name: ..., metadata: ... })
// somewhere. The compiler will catch any drift.
// ---------------------------------------------------------------------------

export type CoScientistEvent =
  // ---- Slice 1: App lifecycle ------------------------------------------
  | { name: 'app.launched'; metadata: { cold_start: boolean } }
  | { name: 'app.first_launch'; metadata: Record<string, never> }
  | { name: 'app.heartbeat'; metadata: { interval_seconds: number } }

  // ---- Slice 2: Chat ---------------------------------------------------
  | { name: 'chat.thread_created'; metadata: { thread_id: string } }
  | {
      name: 'chat.message_sent';
      metadata: {
        thread_id: string;
        message_length: number;
        attachment_count: number;
        model: string;
      };
    }
  | {
      name: 'chat.message_received';
      metadata: {
        thread_id: string;
        response_length: number;
        model: string;
        turn_duration_ms: number;
        tool_call_count: number;
      };
    }

  // ---- Slice 3: Tool lifecycle ----------------------------------------
  | {
      name: 'tool.created';
      metadata: {
        tool_id: string;
        creation_source: 'chat';
        name: string;
        description: string;
        creation_prompt: string;
        tool_type: string;
        truncated?: boolean;
        original_total_bytes?: number;
      };
    }
  | {
      name: 'tool.opened';
      metadata: {
        tool_id: string;
        days_since_created: number;
        open_count_so_far: number;
      };
    }
  | { name: 'tool.build_started'; metadata: { tool_id: string } }
  | { name: 'tool.build_completed'; metadata: { tool_id: string; duration_ms: number } }
  | {
      name: 'tool.build_failed';
      metadata: {
        tool_id: string;
        duration_ms: number;
        error_class: string;
        error_message: string;
      };
    }

  // ---- Slice 4: Briefings ---------------------------------------------
  | {
      name: 'briefing.created';
      metadata: {
        briefing_id: string;
        type: string;
        source_report_id: string | null;
        briefing_data: string;
        why_im_suggesting_this: string;
        truncated?: boolean;
        original_total_bytes?: number;
      };
    }
  | {
      name: 'briefing.opened';
      metadata: { briefing_id: string; seconds_since_created: number };
    }
  | {
      name: 'briefing.dismissed';
      metadata: {
        briefing_id: string;
        seconds_since_created: number;
        was_ever_opened: boolean;
      };
    };

/** Event names extracted from the union, useful for runtime guards. */
export type CoScientistEventName = CoScientistEvent['name'];

/** Schema version embedded on every event. Bump on breaking changes. */
export const ANALYTICS_SCHEMA_VERSION = 1 as const;

/** Backend event_type discriminator. */
export const COSCIENTIST_EVENT_TYPE = 'AcaboxEvent' as const;

/**
 * The full data blob posted to `POST /api/v0/arbitrary_event`.
 * Backend auto-attaches actor_id, timestamp, ip, user_agent.
 */
export interface CoScientistEventEnvelope {
  v: typeof ANALYTICS_SCHEMA_VERSION;
  event_name: CoScientistEventName;
  installation_id: string;
  session_id: string;
  release: string;
  channel: CoScientistChannel;
  surface: CoScientistSurface;
  platform: CoScientistPlatform;
  arch: CoScientistArch;
  os_version: string;
  electron_version: string;
  chromium_version: string;
  node_version: string;
  metadata: Record<string, unknown>;
}

/** Names of events whose `metadata` should be run through the truncation helper. */
export const CONTENT_BEARING_EVENTS: ReadonlySet<CoScientistEventName> = new Set<CoScientistEventName>([
  'tool.created',
  'briefing.created',
]);

/**
 * Greedy truncator for content-bearing event payloads. Trims the longest
 * string field until the JSON-serialized payload fits under `maxBytes`,
 * tagging the result with `truncated=true` and `original_total_bytes`.
 * Other fields are left alone.
 */
export function truncatePayload(
  payload: Record<string, unknown>,
  maxBytes = 4000,
): Record<string, unknown> {
  const originalBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (originalBytes <= maxBytes) return payload;

  const result: Record<string, unknown> = { ...payload };
  const MARKER = '…[truncated]';

  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxBytes) {
    let longestKey: string | null = null;
    let longestLen = 0;
    for (const [k, v] of Object.entries(result)) {
      if (typeof v === 'string' && v.length > longestLen) {
        longestKey = k;
        longestLen = v.length;
      }
    }
    if (!longestKey || longestLen <= MARKER.length) {
      // Nothing more to trim. Give up rather than infinite-loop; the backend
      // will reject and we'll see it in error tracking.
      break;
    }
    const current = result[longestKey] as string;
    const newLen = Math.max(MARKER.length, Math.floor(current.length * 0.6));
    result[longestKey] = current.slice(0, newLen - MARKER.length) + MARKER;
  }

  result.truncated = true;
  result.original_total_bytes = originalBytes;
  return result;
}
