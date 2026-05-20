-- Dashboard:  01 — Alpha Health Overview
-- Chart:      Active WAU (7-day rolling)
-- Source:     @coscientist_events_recent + @coscientist_active_install_predicate
-- Parameter:  {{ channel }} — select param defined in the form block below
--             ('production' | 'development').
-- Notes:      For each day D, counts distinct installation_id that fired
--             any active-use event in the trailing 7 days [D-6, D].
--             "Active" = chat.message_sent / tool.opened / briefing.opened.
--             Series only includes days that have at least one active event
--             (no empty-day spine — fine for alpha; revisit if we ever need
--             a "zero days" signal).

WITH active_events AS (
  SELECT
    DATE(occurred_at) AS event_day,
    installation_id
  FROM {{ @coscientist_events_recent }}
  WHERE occurred_at >= CURRENT_TIMESTAMP - INTERVAL '37 days'
    AND channel = '{{ channel }}'
    AND event_name IN (
      SELECT event_name FROM {{ @coscientist_active_install_predicate }}
    )
),
days AS (
  SELECT DISTINCT event_day AS day FROM active_events
  WHERE event_day >= CURRENT_DATE - 30
)
SELECT
  d.day,
  COUNT(DISTINCT e.installation_id) AS active_wau
FROM days d
JOIN active_events e
  ON e.event_day BETWEEN d.day - 6 AND d.day
GROUP BY 1
ORDER BY 1;

{% form %}

channel:
  type: select
  default: production
  options: [production, development]

{% endform %}
