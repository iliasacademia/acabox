-- Dashboard:  02 — Tools
-- Chart:      Tools Opened (one query → three charts at day/week/month)
-- Source:     @coscientist_events_recent (see ../shared/)
-- Parameter:  {{ channel }} — select param defined in the form block below
--             ('production' | 'development').
-- Notes:      Returns ROW-LEVEL `tool.opened` events. Tools fire this event
--             every time a user navigates to them (mount of MiniAppViewer).
--             Build three charts on top of this query:
--
--               • Tools Opened (Daily)   — X: occurred_at, Bin by Day,
--                                          Y: count (see below)
--               • Tools Opened (Weekly)  — same, Bin by Week
--               • Tools Opened (Monthly) — same, Bin by Month
--
--             Three possible Y-axis aggregations, each measuring something
--             slightly different — pick per chart:
--
--               • COUNT (or COUNT of occurred_at)
--                   → "total tool opens" — engagement intensity
--                     (one tool opened 10× counts as 10)
--               • COUNT DISTINCT tool_id
--                   → "distinct tools used" — breadth of tool usage
--                     (one tool opened 10× counts as 1)
--               • COUNT DISTINCT installation_id
--                   → "distinct users opening tools" — tool-using
--                     active install count
--
--             Default recommendation: total opens, since it's the most
--             intuitive engagement signal. Add a sibling chart with
--             "Distinct tools" or "Distinct users" if the breadth angle
--             becomes interesting.

SELECT
  occurred_at,
  installation_id,
  metadata.tool_id::varchar AS tool_id
FROM {{ @coscientist_events_recent }}
WHERE occurred_at >= CURRENT_DATE - INTERVAL '180 days'
  AND channel = '{{ channel }}'
  AND event_name = 'tool.opened'
ORDER BY occurred_at;

{% form %}

channel:
  type: select
  default: production
  options: [production, development]

{% endform %}
