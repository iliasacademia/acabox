-- Dashboard:  02 — Tools
-- Chart:      Tools Created (one query → three charts at day/week/month)
-- Source:     @coscientist_events_recent (see ../shared/)
-- Parameter:  {{ channel }} — select param defined in the form block below
--             ('production' | 'development').
-- Notes:      Returns ROW-LEVEL `tool.created` events. Each tool fires this
--             event exactly once. Build three charts on top of this query:
--
--               • Tools Created (Daily)   — X: occurred_at, Bin by Day,
--                                            Y: tool_id, Count Distinct
--               • Tools Created (Weekly)  — same, Bin by Week
--               • Tools Created (Monthly) — same, Bin by Month
--
--             COUNT(DISTINCT tool_id) is functionally equivalent to COUNT(*)
--             here (one event per tool), but the distinct form is
--             defensive against any accidental duplicate emissions.
--
--             `creation_source` ('chat' | 'suggestion') is included so the
--             chart can optionally split the series by creation path —
--             useful for measuring how many tools are coming from briefing
--             suggestions vs. user-initiated chats.

SELECT
  occurred_at,
  installation_id,
  metadata.tool_id::varchar          AS tool_id,
  metadata.creation_source::varchar  AS creation_source,
  metadata.tool_type::varchar        AS tool_type
FROM {{ @coscientist_events_recent }}
WHERE occurred_at >= CURRENT_DATE - INTERVAL '180 days'
  AND channel = '{{ channel }}'
  AND event_name = 'tool.created'
ORDER BY occurred_at;

{% form %}

channel:
  type: select
  default: production
  options: [production, development]

{% endform %}
