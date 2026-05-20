-- Dashboard:  01 — Alpha Health Overview
-- Chart:      Active DAU
-- Source:     @coscientist_events_recent + @coscientist_active_install_predicate
--             (see ../shared/)
-- Parameter:  {{ channel }} — select param defined in the form block below
--             ('production' | 'development'). Mode renders a dropdown at
--             the top of the report so viewers can toggle channels without
--             duplicating the dashboard.
-- Notes:      "Active" = at least one chat.message_sent, tool.opened, or
--             briefing.opened in the window. Predicate body in
--             ../shared/coscientist_active_install_predicate.sql.

SELECT
  DATE(occurred_at) AS day,
  COUNT(DISTINCT installation_id) AS active_dau
FROM {{ @coscientist_events_recent }}
WHERE occurred_at >= CURRENT_DATE - INTERVAL '30 days'
  AND channel = '{{ channel }}'
  AND event_name IN (
    SELECT event_name FROM {{ @coscientist_active_install_predicate }}
  )
GROUP BY 1
ORDER BY 1;

{% form %}

channel:
  type: select
  default: production
  options: [production, development]

{% endform %}
