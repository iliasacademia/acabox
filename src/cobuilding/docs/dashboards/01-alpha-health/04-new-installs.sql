-- Dashboard:  01 — Alpha Health Overview
-- Chart:      New Installs (one query → three charts at day/week/month)
-- Source:     @coscientist_events_recent (see ../shared/)
-- Parameter:  {{ channel }} — select param defined in the form block below
--             ('production' | 'development').
-- Notes:      Returns ROW-LEVEL `app.first_launch` events — one row per
--             event, not pre-aggregated. Mode then bins by day/week/month
--             at chart-configuration time (X-axis "Bin by"), with Y-axis
--             "COUNT DISTINCT installation_id". This lets one query back
--             three charts at different granularities. If we GROUP BY day
--             in SQL, Mode's chart-level "Bin by" no longer offers
--             week/month — the data is already pre-aggregated to discrete
--             daily buckets.
--
--             "New install" = first authenticated session on a device.
--             `app.first_launch` fires once per installation_id, gated by
--             userData/.coscientist-first-launch-seen. COUNT DISTINCT at
--             the chart level is defensive in case the sentinel ever gets
--             blown away and the event fires twice — we still count the
--             install once per granularity bucket.
--
--             Excludes binary launches where the user never logged in
--             (events are post-auth only). Treat the number as "first
--             authenticated session," not "first time the .dmg ran."

SELECT
  occurred_at,
  installation_id
FROM {{ @coscientist_events_recent }}
WHERE occurred_at >= CURRENT_DATE - INTERVAL '180 days'
  AND channel = '{{ channel }}'
  AND event_name = 'app.first_launch'
ORDER BY occurred_at;

{% form %}

channel:
  type: select
  default: production
  options: [production, development]

{% endform %}
