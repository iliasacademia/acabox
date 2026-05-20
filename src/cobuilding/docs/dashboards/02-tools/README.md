# 02 — Tools

The "what are users building?" view. Quantifies tool creation, tool engagement (opens), and surfaces a browsable inventory of every tool that's been created.

## What it answers

- How many new tools are users creating per day / week / month?
- How often are existing tools being opened?
- What specifically are users making — and how often is each tool being used?
- How many tools came from briefing suggestions vs. user-initiated chat?

## Charts

| # | File | Visualization | Description |
|---|---|---|---|
| 01 | `01-tools-created.sql` | 3× Line/Bar (Day/Week/Month) | Row-level `tool.created` events; chart-level COUNT DISTINCT `tool_id`. |
| 02 | `02-tools-opened.sql`  | 3× Line/Bar (Day/Week/Month) | Row-level `tool.opened` events; chart-level COUNT of opens. |
| 03 | `03-tools-table.sql`   | Table                        | One row per tool with name, description, type, creation source, open count. |

Each of charts 01 and 02 is **one Mode Query backing three Charts** (Daily / Weekly / Monthly). The query returns row-level data; the chart's "Bin by" setting controls the bucket size. See the top-level README for why this pattern requires row-level SQL.

## Parameters

This dashboard has one Mode parameter, defined inline in each chart's SQL via a Liquid `{% form %}` block:

- **`channel`** — select parameter, values `production` and `development`. Every chart filters on it via `AND channel = '{{ channel }}'`. Mode renders a single dropdown at the top of the report; switching it re-runs all three queries against the chosen channel. Default is `production`.

## Caveats

- **`creation_prompt` is intentionally omitted from the Tools Table.** The prompt can be long, may contain sensitive content, and is most useful for forensic deep-dives rather than at-a-glance browsing. If you need to inspect a specific tool's prompt, query `metadata.creation_prompt::varchar` directly against `@coscientist_events_recent` filtered by `tool_id`.
- **`open_count` may be off by some opens that happened before instrumentation shipped.** Tools created before Slice 3 was deployed exist in workspace SQLite but never fired `tool.created`, so they won't appear in the table; `tool.opened` events for those tools also won't be attributed to a tool row in this dashboard. Expect a brief period of incomplete data covering tools that existed pre-instrumentation.
- **The 180-day chart window may exceed the base Definition's 90-day window** — the chart query says `INTERVAL '180 days'` but `@coscientist_events_recent` is capped at 90 days inside the Definition. Effective window is `min(chart, definition) = 90 days`. Bump the Definition's window if we ever need longer retention on the dashboards.
- **Tool open events fire on every navigation,** not just opens of distinct tools. A user clicking back and forth between two tools five times fires 10 `tool.opened` events. That's intentional — engagement intensity is the metric — but be aware when interpreting per-day numbers.

## How to read

The two trend charts (Created vs. Opened) should ideally diverge over time:
- **Created** is bounded by the rate of new ideas — for an alpha, a few per active user per week is healthy.
- **Opened** is bounded by reuse — if tools get created and never re-opened, the ratio Opened/Created stays near 1.0 (each tool opened ~once). A healthy product shows Opened growing faster than Created over time (each tool gets opened multiple times).

The **Tool Inventory table** is the most actionable surface for alpha — read it like a product diary. Sort by `open_count` descending to see which tools are sticking; sort by `created_at` descending to see what's been built lately. If many recent tools have `open_count = 0`, that's a signal that creation is happening but reuse isn't.
