-- Mode Definition: @coscientist_sessionization
-- Used as:    FROM {{ @coscientist_sessionization }}
-- Purpose:    Derive "engagement sessions" — bursts of user activity
--             bracketed by 15-minute idle gaps. Finer than the client-side
--             session_id (which is per Electron process lifetime).
-- Sync flow:  Edit this file → copy the body below into Mode → Settings →
--             Definitions → @coscientist_sessionization → Save.
-- Notes:      - Returns rows from @coscientist_events_recent with an extra
--               `engagement_session_num` column (a per-installation_id
--               integer that increments on each 15-minute idle gap).
--             - Use `engagement_session_num` as a session boundary for
--               "events per session" or "session length" queries.
--             - For app-launch session counts, use `session_id` directly
--               from @coscientist_events_recent — no need for this Definition.

SELECT
  events.*,
  SUM(
    CASE
      WHEN prev_ts IS NULL
        OR occurred_at - prev_ts > INTERVAL '15 minutes'
      THEN 1
      ELSE 0
    END
  ) OVER (
    PARTITION BY installation_id
    ORDER BY occurred_at
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS engagement_session_num
FROM (
  SELECT
    installation_id,
    session_id,
    event_name,
    occurred_at,
    LAG(occurred_at) OVER (
      PARTITION BY installation_id
      ORDER BY occurred_at
    ) AS prev_ts
  FROM {{ @coscientist_events_recent }}
) events
