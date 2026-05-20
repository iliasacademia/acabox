-- Mode Definition: @coscientist_events_recent
-- Used as:    FROM {{ @coscientist_events_recent }}
-- Purpose:    Base subquery — pulls CoScientistEvent rows from the
--             `arbitrary_super_events` native Redshift table, applies
--             a 90-day occurred_at window, and extracts the SUPER
--             payload's per-event fields as flat columns.
-- Sync flow:  Edit this file → copy the body below into Mode →
--             Settings → Definitions → @coscientist_events_recent → Save.
--
-- Why this source (not arbitrary_events.event_columns):
--   The Ruby class inherits from `BaseArbitrarySuperEvent`, which writes
--   each event to a native Redshift table `arbitrary_super_events` with
--   the event-specific body in a SUPER `payload` column. Super-events
--   are the right base class for CoScientistEvent because our `metadata`
--   field is polymorphic — its shape varies per event_name (the TS
--   discriminated union: `tool.created` has `tool_id`/`creation_source`,
--   `chat.message_received` has `turn_duration_ms`/`tool_call_count`,
--   etc.). `BaseArbitraryEvent` would flatten this into `metadata__<key>`
--   columns, which is fragile across heterogeneous keys; SUPER handles
--   arbitrary nested JSON natively.
--
--   Side benefits of querying arbitrary_super_events directly:
--     - typed columns exist immediately — no Spectrum crawler lag
--     - no streamed_date partition discipline required
--     - no Spectrum quota cost
--
-- Schema of arbitrary_super_events (the columns we use):
--   occurred_at  timestamp           — event time (already real timestamp)
--   user_id      bigint              — Academia user_id, auto-attached
--   event_type   varchar             — 'CoScientistEvent' for our rows
--   payload      super               — the JSON-shaped event body
--                                      (all our per-event fields live here)
--
-- SUPER access syntax (Redshift):
--   payload.event_name              — returns SUPER
--   payload.event_name::varchar     — cast to varchar for normal SQL use
--   payload.metadata.tool_id        — nested object access
--   Missing fields return NULL (no error).
--
-- Note on volume:
--   `BaseArbitrarySuperEvent` is sometimes described as "for low-volume
--   events like surveys" — that framing is about a side-effect of the
--   tier (data goes straight to a real Redshift table, so it's expensive
--   to dump huge volumes there), not about why we're using it. We're
--   here for the polymorphic-payload reason above. If our volume ever
--   pressures the warehouse team, the conversation is about routing
--   specific high-frequency event_names (heartbeat, chat deltas) to a
--   different pipeline — not about converting the base class wholesale.

SELECT
  occurred_at,
  user_id,
  payload.event_name::varchar      AS event_name,
  payload.installation_id::varchar AS installation_id,
  payload.session_id::varchar      AS session_id,
  payload.release::varchar         AS release,
  payload.channel::varchar         AS channel,
  payload.surface::varchar         AS surface,
  payload.platform::varchar        AS platform,
  payload.arch::varchar            AS arch,
  payload.os_version::varchar      AS os_version,
  payload.metadata                 AS metadata
FROM arbitrary_super_events
WHERE event_type = 'CoScientistEvent'
  AND occurred_at >= CURRENT_TIMESTAMP - INTERVAL '90 days'
