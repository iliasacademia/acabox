-- Dashboard:  02 — Tools
-- Chart:      Tool Inventory (Table visualization)
-- Source:     @coscientist_events_recent (see ../shared/)
-- Parameter:  {{ channel }} — select param defined in the form block below
--             ('production' | 'development').
-- Notes:      One row per tool ever created. Columns chosen for human
--             browsing in a Mode Table visualization (sortable headers,
--             search box, scroll). `open_count` is computed by counting
--             matching tool.opened events — gives 0 for tools that were
--             created but never opened, which is itself a useful signal.
--
--             Use Mode's Table chart type (not Line/Bar) for this query.
--             Default sort is reverse-chronological by creation; viewer
--             can re-sort by clicking any column header.
--
--             Limited to 500 rows to keep the table snappy. The base
--             Definition's 90-day occurred_at window is the real ceiling
--             — most alpha tools fit comfortably within both bounds.

WITH tools_created AS (
  SELECT
    occurred_at                                      AS created_at,
    metadata.name::varchar                           AS name,
    metadata.description::varchar                    AS description,
    metadata.tool_type::varchar                      AS tool_type,
    metadata.creation_source::varchar                AS creation_source,
    metadata.source_briefing_id::varchar             AS source_briefing_id,
    metadata.tool_id::varchar                        AS tool_id,
    installation_id
  FROM {{ @coscientist_events_recent }}
  WHERE channel = '{{ channel }}'
    AND event_name = 'tool.created'
),
tool_open_counts AS (
  SELECT
    metadata.tool_id::varchar AS tool_id,
    COUNT(*) AS open_count
  FROM {{ @coscientist_events_recent }}
  WHERE channel = '{{ channel }}'
    AND event_name = 'tool.opened'
  GROUP BY 1
)
SELECT
  c.created_at,
  c.name,
  c.description,
  c.tool_type,
  c.creation_source,
  COALESCE(o.open_count, 0) AS open_count,
  c.source_briefing_id,
  c.tool_id,
  c.installation_id
FROM tools_created c
LEFT JOIN tool_open_counts o
  ON o.tool_id = c.tool_id
ORDER BY c.created_at DESC
LIMIT 500;

{% form %}

channel:
  type: select
  default: production
  options: [production, development]

{% endform %}
