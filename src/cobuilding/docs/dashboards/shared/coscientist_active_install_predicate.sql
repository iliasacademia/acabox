-- Mode Definition: @coscientist_active_install_predicate
-- Used as:    WHERE event_name IN (
--               SELECT event_name FROM {{ @coscientist_active_install_predicate }}
--             )
-- Purpose:    The canonical list of event names that count as
--             "user is actively engaged" on a given day. Reused for
--             DAU/WAU/MAU and any "active user" count.
-- Sync flow:  Edit this file → copy the body below into Mode → Settings →
--             Definitions → @coscientist_active_install_predicate → Save.
-- Why a SELECT, not a fragment:
--             Mode Definitions must be runnable SELECT statements (they're
--             closer to views than to text macros). So we return the
--             active-event list as a one-column table and reference it
--             as a subquery in the IN clause.
-- Notes:      - chat.message_sent → user typed and submitted a message
--             - tool.opened       → user navigated to a tool
--             - briefing.opened   → user clicked an unread briefing
--             briefing.created is EXCLUDED because background agents create
--             briefings without user action; including it would mark installs
--             as "active" on days the user never touched the app.
--             app.heartbeat is EXCLUDED because it's a passive presence signal,
--             not engagement.

SELECT 'chat.message_sent' AS event_name
UNION ALL SELECT 'tool.opened'
UNION ALL SELECT 'briefing.opened'
