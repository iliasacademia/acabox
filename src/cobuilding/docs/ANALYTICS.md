# CoScientist Product Analytics

What we track, where we track it from, and why. This doc reflects **what is actually implemented in code** — when an event is added or changed, update the table here in the same commit. Treat any drift as a bug.

## Strategy in one paragraph

Every CoScientist product/behavioral event lands in Academia's `arbitrary_events` Redshift table with `event_type='CoScientistEvent'`, posted via the existing `POST /api/v0/arbitrary_event` pipeline (→ Firehose → Redshift), then visualized in Mode dashboards. The emit module is **auth-gated**: no events fire until the user has a valid authenticated session for the running app process. This is by design — installs that never log in are invisible to telemetry, but in exchange we avoid anonymous events, NULL `actor_id` rows, and any pre-login queue. Pre-login state is silently dropped.

## Non-obvious decisions

- **Auth gating, no queue.** Pre-login events are dropped, not buffered. The drop happens in the emit module itself (both renderer and main).
- **Single source of truth for envelope construction.** The main process owns `SESSION_ID`, telemetry context, and the auth gate. Renderer windows call a `telemetry:track` IPC that ships the event_name + metadata to main, which builds the full envelope and POSTs it. This avoids drift between renderer copies and the main process.
- **Per-process `session_id`, derived "engagement sessions" in SQL.** One UUID per Electron process. Engagement sessions are computed at query time in Mode via a 15-minute idle gap. Both views are useful — process-lifetime sessions and bursts-of-activity sessions.
- **Top-level vs metadata.** Always-present fields (`installation_id`, `session_id`, `release`, `channel`, `surface`, device fingerprint) sit at the top of `data`. Per-event payload lives in `data.metadata`. Saves a JSON path segment in every dashboard query.
- **Content fields piggyback on the parent event.** No separate `.content` events — `tool.created` carries the creation prompt; `briefing.created` carries the briefing text. A truncation helper trims long strings to fit the 5KB envelope cap and sets `metadata.truncated = true` + `metadata.original_total_bytes` when capping kicks in.
- **No client-side dedup.** Same event firing twice produces two rows. Dashboards dedup at query time via `DISTINCT ON` (e.g. funnel queries take `MIN(timestamp)` per `installation_id + event_name`).
- **Naming convention.** `.started` / `.completed` / `.failed` for operations; past-tense bare names (`launched`, `opened`, `created`) for one-shot lifecycle events. No standalone `outcome` field — encoded in the suffix.

## What never leaves the device

Chat message content, file contents, full file paths, OAuth tokens, API keys, email/calendar content, Obsidian/Apple-Notes/Zotero library contents.

## Event envelope

```ts
{
  arbitrary_event: {
    event_type: 'CoScientistEvent',
    data: {
      v: 1,
      event_name: 'tool.created',
      installation_id, session_id,
      release, channel, surface,
      platform, arch, os_version,
      electron_version, chromium_version, node_version,
      metadata: { /* per-event payload */ },
    }
  }
}
```

Backend auto-attaches `actor_id`, `timestamp`, `ip`, `user_agent`. Schema source of truth: `src/cobuilding/shared/analyticsTypes.ts`.

## Events currently tracked

The catalog below mirrors what's wired up in code right now. Slices not yet implemented are listed in the plan but **not** in this table.

| Event | Slice | Fires from | Purpose | Metadata |
|---|---|---|---|---|
| `app.launched` | 1 | `main/index.ts` `auth:checkLogin` and `auth:verifyQRCode` handlers (via `markAuthenticated`) | "User is in" marker — fires once per process when the auth gate flips on. Drives DAU/MAU "opens" count. | `cold_start: boolean` (true on the first auth in this Electron process) |
| `app.first_launch` | 1 | Same site as `app.launched`, gated by sentinel file at `userData/.coscientist-first-launch-seen` | One-time-per-install "new user" marker. Drives "new installs per day" + retention cohort assignment. | _(no payload-specific fields)_ |
| `app.heartbeat` | 1 | `setInterval` in `coscientistAnalytics.startHeartbeat()` (10-min tick); emits only if a CoScientist window has focus AND auth gate is on | Time-in-app signal — `COUNT(heartbeats) × 10min ≈ minutes focused`. Cheaper than focus/blur events; not part of active-use predicate. | `interval_seconds: number` (currently 600) |
| `chat.thread_created` | 2 | `renderer/chatAdapter.ts` — when the send is the first message of the thread (`messages.length === 1 && messages[0].role === 'user'`). assistant-ui hydrates `messages` from persisted thread history before calling `run()`, so this check is deterministic across renderer reloads and across app launches. | Marks the start of a new chat conversation. Fires exactly once per thread, regardless of renderer/app restarts. | `thread_id: string` |
| `chat.message_sent` | 2 | `renderer/chatAdapter.ts` — after `messageId` is minted, before the stream begins | User submitted a message. Part of the active-use predicate (DAU/MAU). | `thread_id: string`, `message_length: number`, `attachment_count: number`, `model: string` (`'unknown'` if not set) |
| `chat.message_received` | 2 | `renderer/chatAdapter.ts` — when the SSE stream emits `turn-complete` | Assistant turn finished successfully. `turn_duration_ms` is wall-clock from message_sent to turn-complete. `response_length` sums all `text-delta` + `text` bytes. `tool_call_count` counts `tool-call-start` + `tool-call` events. | `thread_id: string`, `response_length: number`, `model: string`, `turn_duration_ms: number`, `tool_call_count: number` |
| `tool.created` | 3 | `main/index.ts` `tool:opened` handler — fires once per tool, gated by the `creation_pending: true` flag that `manage_mini_app.mjs` writes into `manifest.json` at scaffold time. The handler deletes the flag synchronously after consuming it, so re-opens don't re-fire. Tools predating instrumentation (no `creation_pending` in their manifest) get a lazy-minted `tool_id` silently without firing this event. | One-shot "this tool exists now" marker. `tool_id` is a UUID v4 minted by `manage_mini_app.mjs` at scaffold time (or lazy-minted by `tool:opened` for pre-existing tools). `creation_source` is set from a "pending source" slot that the renderer flips at the point the user initiates creation: `handleBuildSuggested` → `'suggestion'`, `handleCreateTool` → `'chat'`. `creation_prompt` is captured from chatAdapter when it detects the agent invoking `manage_mini_app.mjs` (the most recent user message at that moment). Both slots time out after 30 min and are consumed (cleared) only when a creation_pending=true open is observed — pre-existing-tool opens leave them intact for the eventual real new tool. | `tool_id: string`, `creation_source: 'chat' \| 'suggestion'`, optional `source_briefing_id: string` (only when `creation_source === 'suggestion'`), `name: string`, `description: string`, `creation_prompt: string` (the user message that triggered the agent's `manage_mini_app.mjs` invocation; empty if not detected), `tool_type: string` (`'prebuilt'` for pre-built apps, otherwise `'user'`), plus optional `truncated`, `original_total_bytes` if content was capped |
| `tool.opened` | 3 | `main/index.ts` `tool:opened` handler, called by `MiniAppViewer.tsx` mount via `window.toolAnalyticsAPI.opened(dirName)` | User opened a tool. Increments `open_count` in `manifest.json` and reports the post-increment value. `days_since_created` is computed from `manifest.created_at`. Part of the active-use predicate. | `tool_id: string`, `days_since_created: number`, `open_count_so_far: number` |
| `tool.build_started` | 3 | `MiniAppViewer.handleRebuild` (renderer) — before invoking esbuild | esbuild starts on a tool. | `tool_id: string` |
| `tool.build_completed` | 3 | `MiniAppViewer.handleRebuild` — after a successful esbuild + container overlay sync | esbuild succeeded. `duration_ms` is wall-clock since `tool.build_started`. | `tool_id: string`, `duration_ms: number` |
| `tool.build_failed` | 3 | `MiniAppViewer.handleRebuild` — either non-zero esbuild exit code or a thrown error in the renderer code path | esbuild failed. `error_message` truncated to 500 chars; `error_class` is `'esbuild_exit_nonzero'` for compile errors or `err.constructor.name` for thrown JS errors. | `tool_id: string`, `duration_ms: number`, `error_class: string`, `error_message: string` |
| `briefing.created` | 4 | `main/db/briefingsRepository.ts` `createBriefing()` — fires immediately after the INSERT succeeds. Always tagged `surface: 'background'` because briefings are exclusively agent-generated (workspace scans, scheduled tasks, in-chat agents). | One-shot "this briefing exists now" marker. Carries the briefing's payload (truncated to fit envelope) so dashboards can answer "what kinds of briefings get ignored?" by joining open-rate to content. **Excluded from active-use predicate** for DAU/MAU — agent emits don't count as user activity. | `briefing_id: string`, `type: 'suggested_action' \| 'suggested_tool' \| 'paper' \| 'citation' \| 'grant' \| 'writing_agent'`, `source_report_id: string \| null`, `briefing_data: string` (truncated JSON of the briefing payload), `why_im_suggesting_this: string` (truncated), plus optional `truncated`, `original_total_bytes` |
| `briefing.opened` | 4 | `main/db/briefingsRepository.ts` `setBriefingStatus()` — fires only on the `new → opened` transition (not on re-opens). | User clicked an unread briefing. Part of the active-use predicate. `seconds_since_created` is computed from the row's `created_at`. | `briefing_id: string`, `seconds_since_created: number` |
| `briefing.dismissed` | 4 | `main/db/briefingsRepository.ts` `setBriefingStatus()` — fires on any transition to `dismissed` (not on re-dismissals of an already-dismissed row). | User dismissed a briefing. `was_ever_opened` is `true` if the prior status was `opened`, `false` if it was `new` (dismissed without reading). | `briefing_id: string`, `seconds_since_created: number`, `was_ever_opened: boolean` |

## Implementation map

| Concern | File |
|---|---|
| Type definitions (event union, envelope) + truncation helper | `src/cobuilding/shared/analyticsTypes.ts` |
| Main-side emit + IPC handlers (`telemetry:track`, `telemetry:getContext`, `telemetry:subscribe-auth-state`) | `src/cobuilding/main/coscientistAnalytics.ts` |
| Renderer-side emit (forwards `event_name` + `metadata` to main via IPC) | `src/cobuilding/renderer/coscientistAnalytics.ts` |
| `window.telemetryAPI` + `window.toolAnalyticsAPI` exposure | `src/cobuilding/main/preload.ts` |
| Window type declarations | `src/cobuilding/renderer/types.d.ts` |
| Init at app boot (`initAnalytics`, `registerAnalyticsIpc`, `startHeartbeat`) | `src/cobuilding/main/index.ts` (in `app.whenReady`) |
| Init at renderer boot (`initCoScientistAnalytics`) | `src/cobuilding/renderer/index.tsx` |
| Auth gate flip (`markAnalyticsAuthenticated` / `setAnalyticsAuthenticated(false)`) | `src/cobuilding/main/index.ts` — `auth:checkLogin` (persisted session), `auth:verifyQRCode` (fresh QR), `auth:logout` |
| `app.heartbeat` `setInterval` (10-min tick, focus-gated) | `src/cobuilding/main/coscientistAnalytics.ts` (`startHeartbeat`) |
| Chat event emits | `src/cobuilding/renderer/chatAdapter.ts` |
| Tool open + create detection (`ensureToolId`, manifest mutation) | `src/cobuilding/main/index.ts` — `tool:opened` IPC handler |
| Tool build event emits | `src/cobuilding/renderer/components/MiniAppViewer.tsx` (`handleRebuild`) |
| Briefing event emits | `src/cobuilding/main/db/briefingsRepository.ts` |

## Manifest schema additions (mini-apps)

Slice 3 extends `.applications/<dirName>/manifest.json` with:
- `tool_id: string` — UUID v4. Written by `manage_mini_app.mjs` at scaffold time for new tools; lazy-minted by `tool:opened` (silently, no analytics event) for tools that predate instrumentation. Stable identity for all tool events.
- `creation_pending: true` — written by `manage_mini_app.mjs` alongside `tool_id`. Consumed and deleted by `tool:opened` on the tool's very first open, which is when `tool.created` fires. Absence of this flag is what tells the IPC handler "this is a pre-existing tool — don't fire tool.created."
- `created_at: string` — ISO timestamp, written on first `tool:opened` if absent (defaults to "now"; for tools created before this slice landed, `created_at` will reflect the first open after upgrade rather than the real creation date — an accepted limitation).
- `open_count: number` — incremented on every `tool:opened` IPC call.

Existing manifest fields (`name`, `description`, `icon`, `lastOpened`, `chatSessionId`, `preBuilt`) are preserved.

## Tool creation attribution (creation_source + creation_prompt)

Attribution is keyed by the **chat thread that created the tool**. This makes concurrent background tool builds work correctly — each thread carries its own attribution and prompt, and the lookup at tool open time resolves the right one via the manifest's `chatSessionId` (== thread_id).

### Flow

1. User clicks **"Build it"** on a `suggested_tool` briefing (in `ToolsPage`, `HomePage`, or `BriefingHistory`) → the handler calls `pushPendingAttribution(briefing.id)` (renderer-side FIFO queue of `{ source: 'suggestion', briefing_id, set_at }` entries; 30s freshness window).
2. The handler runs `switchToNewThread()` and `composer.send(prompt)`.
3. `chatAdapter.run()` fires for the new thread. The brand-new-thread branch shifts one entry off the queue and IPC-sends `tool:setThreadAttribution(threadId, attribution)`. Main stores it in `attributionByThread`.
4. The agent invokes `manage_mini_app.mjs`. As soon as `chatAdapter` sees `manage_mini_app.mjs` in the tool-call args, it IPC-sends `tool:setThreadCreationPrompt(threadId, userText)`. Main stores it in `promptByThread` (16KB cap at the IPC boundary).
5. `manage_mini_app.mjs` writes the manifest with `creation_pending: true` (and `tool_id`).
6. User opens the tool → `tool:opened` IPC sees `creation_pending=true`. It resolves `chatSessionId` from the manifest, falling back to `findSessionForApp(workspaceId, dirName)` (matches assistant messages mentioning `manage_mini_app.mjs` or `open_mini_application` plus the dirName) if not yet present. The resolved id is persisted into the manifest so future opens skip the search.
7. Main looks up `attributionByThread.get(chatSessionId)` and `promptByThread.get(chatSessionId)`, both `take`-style (read + delete + drop if older than 30 min), and uses the values on the `tool.created` event. Missing/expired → defaults (`creation_source: 'chat'`, empty prompt).

### Why thread_id and not a global slot?

The earlier design used a single global "pending slot" per kind (`pendingCreationSource`, `pendingCreationPrompt`) in main. That worked for one-at-a-time creations but silently mis-attributed under any concurrent pattern — two Build-it clicks, a Build-it concurrent with a chat-creation, two background-thread agents creating tools simultaneously. The thread-keyed `Map` design fixes all of those.

### `chatSessionId` is the linkage

The manifest's `chatSessionId` field already existed (written by `sessions:findForApp` to associate a tool with its chat). We reuse it as the attribution-lookup key. `findSessionForApp` finds it by scanning messages for either `manage_mini_app.mjs` or `open_mini_application` calls that mention the dirName, plus the synthetic "connected to the application" user-side marker — so the link is recoverable even if `sessions:findForApp` hasn't yet been called when `tool:opened` runs.

The prompt is **never written to `manifest.json`** — it lives only in the emitted analytics event.

### Known limitations

- **Click-but-no-chat orphans.** A user who clicks Build-it then closes the app or cancels the chat will leave an entry in the renderer-side queue. The 30s freshness window ensures it can't leak attribution onto a later unrelated brand-new-thread send.
- **Multiple tools in one chat turn.** If the agent creates two tools in one turn, both share the thread's attribution and prompt. The first tool to open consumes both maps; the second tool falls back to defaults. Acceptable for alpha (multi-tool turns are rare).
- **Pre-existing tools opened post-instrumentation.** No `creation_pending` flag in their manifests, so `tool.created` doesn't fire — by design.

## Known TODOs

- **POST failure handling is "log and drop."** No local queue, no retry. Add only if data loss bites in alpha.
