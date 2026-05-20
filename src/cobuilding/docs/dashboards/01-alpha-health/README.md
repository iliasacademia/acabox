# 01 — Alpha Health Overview

The one-screen dashboard the team checks every morning to answer "is the alpha working?"

## What it answers

- How many people opened the app today/this week/this month?
- How many of those actually used it?
- How many net-new installs landed?
- Are returning users coming back?
- Is the ingestion pipeline healthy (i.e. did events flow at all)?

## Charts

| # | File | Description |
|---|---|---|
| 01 | `01-active-dau.sql` | Distinct `installation_id` per day with at least one active-use event. |
| 02 | `02-active-wau.sql` | Distinct `installation_id` per day with an active-use event in the trailing 7 days. |
| 03 | `03-active-mau.sql` | Distinct `installation_id` per day with an active-use event in the trailing 30 days. |
| 04 | `04-new-installs.sql` | First-ever `app.first_launch` per `installation_id`, bucketed by day. |
| 05 | `05-returning-install-ratio.sql` | % of installs that fired an event ≥ 24h after their first launch. |
| 06 | `06-total-events-per-day.sql` | Sanity-check counter — a sudden zero means ingestion broke. |

Charts 01–04 are scaffolded; 05–06 are TODO.

## Parameters

This dashboard has one Mode parameter, defined inline in each chart's SQL via a Liquid `{% form %}` block (see the top-level README for the boilerplate and the rationale):

- **`channel`** — select parameter, values `production` and `development`. Every chart filters on it via `AND channel = '{{ channel }}'`. Mode renders a single dropdown at the top of the report; switching it re-runs all three queries against the chosen channel. Default is `production`.

## Caveats

- **Active-use predicate is `chat.message_sent OR tool.opened OR briefing.opened`.** See `../shared/coscientist_active_install_predicate.sql` (Mode Definition `@coscientist_active_install_predicate`) for the full rationale; `briefing.created` is deliberately excluded because background agents fire it.
- **Post-login only.** No events fire until the user has authenticated for the running app process. Installs that open the app and bail before logging in are invisible to this dashboard — that's intentional.
- **Time zone is UTC** for all date bucketing on this dashboard.
- **"New install"** means "first authenticated session on this device" (`app.first_launch`), not "first time the binary ran." A user could install the app and never log in; we won't see them.
- **`installation_id` is the join key everywhere.** It's set client-side in every event and is the primary identifier for "who did this." For cross-Academia joins, use the auto-attached `user_id` column (bigint, set by the backend from the session cookie).

## How to read the dashboard

**DAU / WAU / MAU as a trio.** Plotted on the same axis with the same active-use predicate; by construction DAU ≤ WAU ≤ MAU on any given day. The three answer different questions:
- **DAU** — how many people used the product *today*?
- **WAU** — how many people are in our weekly orbit?
- **MAU** — how many people have used the product *recently at all*?

**DAU / MAU ratio is the headline engagement number.** Industry rule-of-thumb:
- ~0.5+ = daily-habit product (Slack, Twitter)
- ~0.2 = weekly-habit product (Notion, GitHub)
- < 0.1 = irregular / try-and-bounce
For an alpha, expect noisy numbers — the trend over time matters more than the daily value.

**WAU / MAU ratio** is the same idea on a shorter window. A drifting-down WAU/MAU with stable MAU means the product is acquiring users but losing them within the month.
