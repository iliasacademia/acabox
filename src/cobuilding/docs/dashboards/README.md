# CoScientist Mode Dashboards

Version-controlled reference for the SQL behind every Mode dashboard chart we publish. Mode is the runtime source of truth; the files here are the canonical, reviewable copy.

## How the data lands in Redshift

Coscientist telemetry is written as Academia **Arbitrary Super Events** with `event_type = 'CoScientistEvent'`. The Ruby class on the backend inherits from `BaseArbitrarySuperEvent`, which writes each event to a native Redshift table `arbitrary_super_events` — the event-specific body lives in a SUPER `payload` column.

**Why super-events and not regular arbitrary events?** Our `metadata` field is polymorphic — its shape varies per `event_name`. `tool.created` carries `tool_id`/`creation_source`/`creation_prompt`; `chat.message_received` carries `turn_duration_ms`/`tool_call_count`; `briefing.created` carries `briefing_data`/`why_im_suggesting_this`; etc. `BaseArbitraryEvent` would flatten the hash into `metadata__<key>` top-level columns, which is fragile across heterogeneous keys. `SUPER` handles arbitrary nested JSON natively, so the same column slot stores any shape. The choice is about schema shape, not volume.

The Definitions below all read from `arbitrary_super_events` for that reason. (CoScientist rows *also* land in `arbitrary_events.event_columns` via the regular S3+Spectrum pipeline, but we don't query that path — its Spectrum crawler can take an hour or more to create our event_type's typed `coscientistevent__*` columns, and we don't need it when the native table is right there.)

Important properties of `arbitrary_super_events`:

- **Schema** (auto-attached columns):
  - `event_type` (varchar) — `'CoScientistEvent'` for our rows.
  - `occurred_at` (timestamp) — event time, set by the client at emit. Real timestamp; use `DATE()` / `DATE_TRUNC()` directly.
  - `created_at` (timestamp) — when the backend wrote the row. Usually within seconds of `occurred_at`.
  - `user_id` (bigint) — Academia user_id from the session cookie. Auto-attached. Our analytics gates on auth so it's normally populated; use it for cross-Academia joins.
  - `id`, `hit_id`, `auvid` — Academia-internal tracking columns; not used by CoScientist dashboards.
- **`payload` (super)** — every CoScientist-specific field lives inside this one SUPER (JSON-shaped) column: `event_name`, `installation_id`, `session_id`, `release`, `channel`, `surface`, `platform`, `arch`, `os_version`, `metadata`, etc. The base Definition extracts the flat fields out for convenience and leaves `metadata` itself as SUPER.
- **SUPER access syntax** (Redshift):
  - `payload.event_name` — returns SUPER
  - `payload.event_name::varchar` — cast for use in normal SQL contexts (the base Definition does this for you)
  - `payload.metadata.tool_id` — nested object access
  - `payload.metadata.tool_id::varchar` — cast a nested field
  - Missing fields return `NULL`, never an error.
- **Volume tier caveat.** `BaseArbitrarySuperEvent` is documented as intended for low-volume events ("like surveys"). CoScientist will land thousands of events per day. If the data team eventually pushes back on volume, we'd switch the Ruby class to `BaseArbitraryEvent` and pivot the base Definition to point at `arbitrary_events.event_columns`. Document this as a known-future-decision rather than a present-day blocker.

## Shared SQL via Mode Definitions

Dashboards never query `arbitrary_super_events` directly. Instead, they reference **Mode Definitions** — reusable SQL snippets registered in Mode (Settings → Definitions) that the team mirrors in this folder:

| Definition (`@name`) | Body in repo | Role |
|---|---|---|
| `@coscientist_events_recent` | [`shared/coscientist_events_recent.sql`](shared/coscientist_events_recent.sql) | Base subquery — pulls from `arbitrary_super_events`, applies a 90-day `occurred_at` window, extracts the SUPER `payload`'s per-event fields as flat columns. |
| `@coscientist_active_install_predicate` | [`shared/coscientist_active_install_predicate.sql`](shared/coscientist_active_install_predicate.sql) | Returns the one-column table of event names that count as "user is actively engaged". Used as a subquery in `IN (...)` for DAU/MAU "active install" counts. |
| `@coscientist_sessionization` | [`shared/coscientist_sessionization.sql`](shared/coscientist_sessionization.sql) | 15-minute-idle-gap engagement-session derivation. Returns `@coscientist_events_recent` rows plus an `engagement_session_num` column. |

In a query, you reference a Definition with `{{ @name }}` — Mode expands the body inline at run time.

**Naming convention.** Every Definition in this folder is prefixed `coscientist_` — the Mode workspace is shared across all of Academia, so we namespace our Definitions to avoid colliding with other teams.

## Folder layout

```
dashboards/
├── README.md                ← you are here
├── shared/                  ← Mode Definition bodies (one file per @name)
│   ├── coscientist_events_recent.sql
│   ├── coscientist_active_install_predicate.sql
│   └── coscientist_sessionization.sql
└── NN-dashboard-name/       ← one folder per Mode dashboard / report
    ├── README.md            ← dashboard purpose + per-chart caveats
    └── NN-chart-name.sql    ← one file per Mode query (one chart = one query)
```

## Conventions

**One `.sql` file per Mode query.** Each chart in a Mode report is backed by exactly one query; the mapping is 1:1. Diffs stay clean in PRs.

**One `.sql` file per Mode Definition under `shared/`.** Filename matches the Definition name (`coscientist_events_recent.sql` ↔ `@coscientist_events_recent`). All Definition names start with `coscientist_` (workspace is shared across Academia teams).

**File naming.** `NN-kebab-case.sql` where `NN` is a two-digit ordinal that sorts the files in the order the dashboard displays them. Same convention for dashboard folders.

**Header comment block on every file**:

```sql
-- Dashboard:  01 — Alpha Health Overview
-- Chart:      Active DAU
-- Source:     @coscientist_events_recent + @coscientist_active_install_predicate (see ../shared/)
-- Notes:      <any relevant caveat>

SELECT ... ;
```

For shared files, the header is slightly different (see any file in `shared/`).

## Querying conventions

- **Always go through `{{ @coscientist_events_recent }}`** — never query `arbitrary_super_events` directly. The Definition guarantees the `event_type = 'CoScientistEvent'` filter, the 90-day `occurred_at` window, and extracts the SUPER payload's fields as flat columns. Bypassing it means hand-rolling all of that.
- **Active-use predicate** — for any "active user" query, use `WHERE event_name IN (SELECT event_name FROM {{ @coscientist_active_install_predicate }})`. Don't inline the event list. (It's a subquery, not a fragment, because Mode Definitions must be runnable SELECTs.)
- **Per-event fields live in `metadata` (SUPER).** Access nested fields with dot notation and cast: `metadata.tool_id::varchar`, `metadata.duration_ms::int`, `metadata.turn_duration_ms::int`. Missing fields return `NULL`. (You *can* still use `JSON_EXTRACT_PATH_TEXT(metadata, '<field>')` if you prefer — both work on SUPER — but dot notation is cleaner.)
- **`occurred_at` is a real timestamp.** Use `DATE(occurred_at)` or `DATE_TRUNC('day', occurred_at)` directly. No casts needed.
- **Tightening the window.** If your chart only needs the last N days, add `AND occurred_at >= CURRENT_TIMESTAMP - INTERVAL 'N days'` to your chart's WHERE clause. (The base Definition is at 90 days; nothing breaks if you go shorter.)
- **Time zone:** default to UTC for all date bucketing unless a dashboard documents otherwise.
- **Row-level vs. pre-aggregated SQL.** Mode's chart-level "Bin by Day/Week/Month" only works on row-level timestamp columns. If the SQL `GROUP BY DATE(occurred_at)` to return pre-aggregated daily counts, Mode no longer offers week/month bucketing — the data is already in discrete daily buckets. When a chart needs to back multiple-granularity visualizations (e.g. one query → daily/weekly/monthly Bar charts), return **row-level events** and let Mode bin + aggregate in the chart config (X-axis Bin by, Y-axis Count Distinct of `installation_id` etc.). For metrics that don't need granularity-switching (e.g. the existing DAU rolling-window charts), pre-aggregated SQL is fine.
- **`channel` parameter is required on every chart.** Every dashboard has a Mode parameter named `channel` (values: `production`, `development`) so viewers can toggle between the two without duplicating the report. Mode parameters are defined inline at the bottom of each chart's SQL using a Liquid `{% form %} … {% endform %}` block (see [Mode docs](https://mode.com/help/articles/parameters)). The base Definition does **not** filter by channel — that filter lives at the chart level so the Definition stays general-purpose.

  Boilerplate to include in every chart query:

  ```sql
  WHERE …
    AND channel = '{{ channel }}'    -- inside the chart's WHERE clause; quotes are mandatory (Mode does not auto-quote)
    …

  {% form %}

  channel:
    type: select
    default: production
    options: [production, development]

  {% endform %}
  ```

  When multiple queries in a report declare the same parameter name, Mode collapses them into a single dropdown at the top of the report — so the form block can be repeated identically across every chart query without creating multiple controls.

## Sync workflow (Mode ↔ this repo)

The files here are the canonical reference; Mode is the runtime. The two must be kept in sync by discipline — there's no automatic mirror.

**When you add or change a Mode Definition:**

1. Edit (or create) the matching file in `shared/`.
2. In Mode: Settings → Definitions → find or create the Definition by the same `@name`.
3. Paste the body (everything below the header comments) into Mode's Definition editor and Save.
4. Open any query that uses it and re-run to confirm the expansion still works.

**When you add or change a chart query:**

1. Edit (or create) the `.sql` file in the matching dashboard folder.
2. Paste the SQL into the Mode query for that chart (or create a new query if it's a new chart).
3. Re-run to confirm the result.
4. Publish the Mode report.

**When you change something in Mode without touching the repo:**

Mirror the change here in the same PR / same day. Otherwise the repo rots and new contributors get confused about which source is authoritative.

## How to add a new query

1. Find the right dashboard folder (or create `NN-name/` if it's a new dashboard).
2. Pick the next ordinal — `ls NN-name/ | grep -E '^[0-9]'`.
3. Create `NN-chart-name.sql` with the header block + the SQL, referencing the `@`-Definitions where appropriate.
4. Update that dashboard's `README.md` chart list.
5. Paste the SQL into Mode and publish the chart.

## How to add a new dashboard

1. `mkdir NN-dashboard-name/`
2. Create `NN-dashboard-name/README.md` (copy structure from an existing one).
3. Add the dashboard to the index below.
4. Create the Mode report and start adding queries.

## How to add a new Mode Definition

1. Create `shared/<name>.sql` with the header block (use an existing file as a template) + the body.
2. In Mode → Settings → Definitions → add a new Definition named `@<name>`. Paste the body.
3. Add a row to the Definition table at the top of this README.
4. Reference as `{{ @<name> }}` in queries.

## Dashboard index

| # | Name | Status |
|---|---|---|
| 01 | Alpha Health Overview | scaffolding |
| 02 | Tools | scaffolding |

(Status: `scaffolding` = SQL drafted, `published` = live in Mode, `archived` = no longer in use.)
