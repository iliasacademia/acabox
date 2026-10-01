# Acabox review — the chat experience

Reader: chat composer, turns, steps, tool cards, errors, attachments, chat list/search, model picker.
Method: read-only code review of the renderer (`src/cobuilding/renderer/**`), `main/agentSession.ts`,
`main/sessionRegistry.ts`, `main/index.ts` (chat:send / chat:stop), `main/chatActivity.ts`,
`agent-server/index.ts`, the shared chat modules, and the vendored `@assistant-ui` and
`@anthropic-ai/claude-agent-sdk` packages where behaviour depends on them. Nothing was run.
Paths are relative to the repo root; `R/` = `src/cobuilding/renderer/`, `M/` = `src/cobuilding/main/`,
`AS/` = `src/cobuilding/agent-server/`, `SH/` = `src/cobuilding/shared/`.

Audience lens: a scientist who cannot read code, does not use a terminal, and cannot debug a build.

---

## 1. What a non-technical scientist experiences — one turn, start to finish

**Before typing.** Home shows the docked composer with placeholder
`What are we building? — describe a tool, paste a repo, or ask` (`R/components/GlobalComposer.tsx:74`).
"Paste a repo" means nothing to this audience. The empty chat view says `Where to?` /
`Describe a tool, paste a repo, or drop files — it takes it from there.` with three chips:
`Turn a script into an app`, `What's in my folders?`, `Build a PDF → BibTeX tool`
(`R/components/assistant-ui/thread.tsx:98-111,147-148`). Two of the three assume the user has scripts
or knows what BibTeX is. The header of a new chat reads `New chat · <Model> · <Effort> · NAMES ITSELF AFTER
THE FIRST REPLY` (`R/components/command-desk/ChatHeader.tsx:113-119`) — good, honest copy.

**Send.** Enter sends, Shift+Enter is a newline (assistant-ui default). While a turn runs, Enter is blocked
(`node_modules/@assistant-ui/react/dist/primitives/composer/ComposerInput.js:91`) and the send arrow becomes a
square Stop (`GlobalComposer.tsx:97-103`, `chat-composer.tsx:52-58`). Esc also stops (`R/index.tsx:206-224`,
undocumented). The chat list re-sorts immediately (`M/chatActivity.ts:109-114`). A Haiku call names the chat
after the first message (`M/index.ts:2184-2190`, 1 call per new chat).

**Indicator.** `THINKING…` (mono, uppercase), upgraded to `WORKING — STARTING AGENT SERVICE...` or
`WORKING — WAITING FOR AGENT...` on a cold boot (`thread.tsx:320-343`; strings from
`M/agentSession.ts:533-535,550`), or `RECONNECTING…` if no event arrives for 45 s while main says the turn is
alive (`R/chatAdapter.ts:24,200-214`). The header shows a pulsing `GENERATING` chip (`ChatHeader.tsx:121-126`),
the rail/Home/Chats rows get an amber dot (`ChatMarkDot.tsx:17-23`, title `Working — a reply is streaming`), and
the status bar reads `AGENTS 1 LIVE` (`StatusBar.tsx:77`). "Agent service", "agent", "AGENTS … LIVE" are all
engineering words for "Acabox is starting up" / "Acabox is working".

**Steps.** Every run of tool calls between two pieces of prose is one line. While a step runs:
`● bash  python3 -c "import pandas as pd; df = pd.read_csv('MyResearch/data.csv'); …"  14S`
(`R/components/assistant-ui/turn-steps.tsx:74-99`, display from `tool-card-display.ts:42-48`). When the run
finishes: `Ran 3 commands, read 2 files · 5 STEPS` and, if anything failed, `· 1 FAILED` in red
(`turn-steps.tsx:156-166`; phrasing in `turnSteps.ts:160-227`). Opening a line shows flat rows per step. Thinking
blocks show as a collapsible `Thinking` / `Thought` (`thinking-indicator.tsx:43`). A task checklist renders as
`Tasks 2/5` with icons (`todo-write.tsx:49-66`).

**Tool cards (expanded).** Row: dot · icon · mono name · key args · right meta · chevron. Names are
`bash`, `install`, `read`, `write`, `edit`, `notebook`, `glob`, `grep`, `web`, `fetch`, `agent`, `skill`,
`todo`, `tool search`, `plan`, `app`, `workspace`, or the MCP server name (`tool-card-display.ts:34-101`).
Meta: `RUNNING · 4S`, `4S`, `41 LINES`, `CANCELLED`, `EXIT 1` or `ERROR` (`tool-fallback.tsx:63-79,124-156`).
Expanded body: the raw tool output in a `<pre>` (`tool-fallback.tsx:117-119`). For Bash the row shows the
**raw shell command**; the model's plain-English `description` argument is used only when the command is empty
(`tool-card-display.ts:48`: `args: cmd || str(a.description)`). The old label mapper that preferred the
description (`tool-labels.ts:29-35`, "Reading data.csv", "Searching files") is dead code — nothing imports it.

**Answer.** Markdown (GFM only) with tables, code blocks with a `Copy` button in the header
(`markdown-text.tsx:150-166`), bare DOIs autolinked, and backticked paths like `` `output/summary.csv` `` turned
into blue clickable text that opens the file in Acabox's viewer (`markdown-text.tsx:85,205-262`; handler
`R/index.tsx:775-784`). Links open in the system browser. A 7 px pulsing dot trails the last token while streaming.

**Fold.** When the turn ends, everything before the final answer collapses to
`Worked for 4m 12s · 26 steps` (`turnSteps.ts:240-246`), with `N failed` in red; results (app cards, the last
checklist) stay visible; the time `14:02` closes the message (`thread.tsx:361-370`). Clicking the fold restores
the running layout. On reload the duration is recomputed from row timestamps (`historyMessageConverter.ts:79-99`).

**The trap in the fold.** `finalAnswerStart` is "the first part after the LAST tool call", and the module's own
doc says it is `parts.length` "when the turn ended on a tool call, so it all folds" (`turnSteps.ts:117-127`;
pinned by `__tests__/turnSteps.test.ts:52`). The agent is instructed to maintain a TodoWrite checklist and mark
items `completed` as it finishes (`src/cobuilding/CLAUDE.md:103-105`), and the natural end of such a turn is
"final prose, then a TodoWrite marking everything done" or "prose, then `build_and_open_mini_application`". In
that shape the **prose answer is inside the fold**: the user sees `Worked for 3m 40s · 14 steps`, a checklist
with everything ticked, and no sentence from Acabox until they click the fold. The root CLAUDE.md already records
one instance: "the turn that called the tool produced no prose reply, only a collapsed tool card — the right
answer was inside it". For a non-technical user "where is the answer?" is the whole experience.

**After.** If the user was elsewhere (or Acabox was not the frontmost window), the chat gets a blue unread dot
(`A reply you haven't seen yet`) and the rail shows `Chats • N` with a dot (`Rail.tsx:136-146`). There is no
OS notification unless the agent itself calls `mcp__notification__show_notification`
(`M/mcpServers/notificationMcpServer.ts:17-80`; the acabox skill tells it to: `skills/acabox/SKILL.md:255`).
No overall elapsed clock is shown while the turn runs (only per-step), so a 10-minute analysis reads as a
pulsing `GENERATING` with a step clock that resets every step.

---

## 2. Control over a running turn

### Stop — exists, and does far more than "stop"
Wired: `ComposerPrimitive.Cancel` → assistant-ui aborts the run → `abortSignal` → `window.chatAPI.stopResponding`
(`R/chatAdapter.ts:171`) → preload `chat:stop` (`M/preload.ts:854-857`) → `unregisterSession` (`M/index.ts:2397-2402`)
→ `session.destroy()` → `POST /sessions/:id/stop` (`M/agentSession.ts:1008-1025`) → `queryInstance.close()` and the
session is deleted server-side (`AS/index.ts:1171-1190`). `close()` ends the CLI subprocess (SIGTERM +2 s, SIGKILL +7 s
per the root CLAUDE.md).

Consequences for the user:
1. **The partial reply is discarded on the next message.** Assistant rows were inserted as they streamed
   (`agentSession.ts:1265-1267`) but no `result` row follows a stop. The next `createAgentSession` for that chat runs
   `cleanupOrphanTurnRows` (`agentSession.ts:485-491`), which deletes every `assistant`/`tool_result` row after the
   last `result` (`M/db/chatRepository.ts:329-345`). The user's bubble stays; what Acabox had written before Stop
   vanishes from the chat (the SDK transcript keeps it, so the model remembers something the user can no longer see).
2. The SDK exposes a soft `interrupt()` that ends the turn and keeps the session (`node_modules/@anthropic-ai/
   claude-agent-sdk/sdk.d.ts:2713`, with an `interrupt_receipt_v1` contract); Acabox never calls it — grep for
   `interrupt` in `AS/index.ts` finds only the route comment at line 17.
3. Whether an in-flight long Bash child (a 10-minute Python run) dies with the CLI is not established by the code
   (open question; the SDK doc at `sdk.d.ts:4340` says an interrupt without a stop_task declaration "kills
   background tasks" — this is about interrupt, not close).

### Edit & resend, regenerate, branch/fork, copy a reply — none
No `ActionBarPrimitive`, `BranchPicker`, `EditComposer`, `reload`, or "regenerate" exists in the renderer
(grep over `R/` returns only `ErrorBoundary.tsx:29` `window.location.reload()`). `thread.tsx` renders user and
assistant messages with no hover actions. The thread-list adapter's `archive()`/`unarchive()` are no-ops and
`generateTitle` returns an empty stream (`R/sessionListAdapter.ts:35-41`). The only copy affordances are the code
block header (`markdown-text.tsx:150-166`) and the selection → `Quote` toolbar (`QuoteToolbar.tsx:168-171`), which
puts the text into the composer, not the clipboard. A user who wants to paste Acabox's answer into a paper has to
select-all and ⌘C. Compared with Claude.ai/ChatGPT (copy, edit, retry, thumbs, branch on edit), this is the
largest feature-level gap in the thread itself.

### See which files a turn changed — no
Nothing lists changed files or shows a diff (grep for `changedFiles|filesChanged|diff` across the chat components
finds only unrelated hits). A `write` card shows `write  .applications/x/src/App.tsx · 312 LINES`; an `edit` card
shows the path and line count of `new_string` (`tool-fallback.tsx:143-149`). `tool-write.tsx` (a streaming content
preview card) exists but is registered nowhere (`thread.tsx:377-381` registers only `Fallback`, `TodoWrite`,
`EnterPlanMode`) — dead code.

### Approve / deny risky actions — never asked
`BASE_AGENT_ALLOWED_TOOLS` auto-approves Bash/Write/Edit/WebFetch/… (`SH/agentAllowedTools.ts:43-81`) and its header
states "there is no `canUseTool` handler anywhere in Acabox". No `permissionMode` is ever set (grep). The
`Allow once / Always allow / Deny` buttons (`approval-buttons.tsx:6`) are a text pattern-matcher: they appear only
when a paragraph or list in the reply happens to contain all three phrases (`approval-buttons.tsx:21-24`), and
clicking one just sends that phrase as a new user message (`:52-57`). Nothing in this fork produces that text;
the component is inherited from the Word-overlay era and styled with inline hex colours off the design system
(`:40-85`). For the user: Acabox never asks before deleting/overwriting a file in a read-write folder; read-only
folders are advisory (root CLAUDE.md hazards).

### Plan mode — the UI exists but cannot show a plan
`EnterPlanMode`/`ExitPlanMode` are auto-approved names (`agentAllowedTools.ts:62`). The UI registers a card for
`EnterPlanMode` only and renders `args.plan` (`enter-plan-mode.tsx:19-26`); the CLI's EnterPlanMode takes no
arguments, so that card reads `Plan` / `Thinking through the plan…` forever. `ExitPlanMode`, which carries the
plan text, falls to the generic fallback and shows `plan` with empty args (`tool-card-display.ts:80-82`). Both are
"outcome" parts that sit outside the fold (`turnSteps.ts:53-58`). Whether ExitPlanMode's approval round-trip
resolves at all in a headless session is unverified (see open questions). Net: plan mode is invisible to the user.

### Clarifying questions — prose only
The SDK ships a structured `AskUserQuestion` tool (1-4 questions, 2-4 options each, chips/labels —
`node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts:1102-1150`). Acabox has no renderer for it, no
`canUseTool`, and the SDK comment says that without a prompt surface "'ask' decisions are terminal" denials
(`sdk.d.ts:5291`). `system/permission_denied` events are ignored by `processQueryMessage`
(`agentSession.ts:1439-1589` handles `stream_event`, `tool_progress`, `system/task_*`, `assistant`, `user` only).
So the agent asks in a sentence, the turn ends, and the user types an answer — one extra round trip, and a denied
tool is reported to nobody.

---

## 3. Attachments

**Types and routing** (`R/attachmentAdapter.ts`, composite order 241-248):
- `image/*` (jpeg/png/gif/webp) inlined as base64 up to **7 MB** source / 10 MB encoded (`:40-50`); HEIC, TIFF,
  BMP, AVIF converted to PNG via macOS `sips`, SVG falls through to a path (`:72-93`).
- `application/pdf` inlined up to **2 MB**; `text/plain|html|markdown|csv` inlined up to **256 KB** (`:131-139`).
- Everything else (xlsx, docx, json, tsv, h5ad, fcs, large files): `file_reference` → copied into the workspace and the
  agent is told `[Attached file: name]\nThis file has been placed in the workspace. You may need to preprocess it
  before use.` (`AS/index.ts` `buildContentBlocks`). Hard cap **30 MB** default (`M/index.ts:227`, Settings).
- Screenshot button (one click inside Acabox, system picker outside; `ScreenshotButton.tsx`) and on-device dictation
  (`DictationButton.tsx`, errors like `Microphone access is off. Turn it on in System Settings › Privacy & Security
  › Microphone.` `R/hostDictationAdapter.ts:33-40`) feed the same composer.
- Paste of files/images works (assistant-ui `addAttachmentOnPaste` default true, `ComposerInput.js:35,105-118`).
- Quote-to-composer: select text in a reply, tool card, file viewer or mini-app → `Quote` → chip with provenance
  (`your earlier reply`, `the Bash tool output`, `…/dir/file.csv · truncated`), capped at 8,000 chars (`SH/quotes.ts:66`).
- Chat links: paste `acabox://chat/<id>` → chip with the live title; the agent gets a reference block and reads via
  `read_chat` (`SH/chatLinks.ts`, `chat-link-chip.tsx`).

**Rendering of sent attachments.** A chip: icon · filename · size (`3.1M`) (`thread.tsx:237-267`). Images are
**never shown as thumbnails after sending**; history rows persist only `{type, mediaType, name}`
(`agentSession.ts:891-901`, `historyMessageConverter.ts:155-162`), so a screenshot sent five minutes ago cannot be
viewed again. The composer preview does show image thumbnails (`composer-attachments.tsx:7-26`).

**Bugs found by reading:**
1. **Oversize files fail silently.** `FileReferenceAttachmentAdapter.add` throws
   `File is too large (31.2 MB). Maximum allowed size is 30 MB.` (`attachmentAdapter.ts:204-208`), but every caller
   swallows it: the dropzone `console.error`s (`ComposerAttachmentDropzone.js` `handleDrop`), the attach button
   fires `addAttachment(file)` without awaiting (`ComposerAddAttachment.js` `input.onchange`), paste catches and logs
   (`ComposerInput.js:112-118`). Nothing reaches the screen.
2. **Files dragged from an already-shared folder are duplicated into the workspace root.** `send()` references in
   place only if the native path starts with the workspace path (`attachmentAdapter.ts:221-229`); shared folders
   are symlinks, so Finder's real path (`/Users/x/Data/MyResearch/a.csv`) never matches and the file is copied to the
   workspace root (`M/fileHandlers.ts:280-305`). Main's later path translation (`agentSession.ts:961-977`) sees only
   the bare name. The Files tab fills with copies; large CSVs are duplicated on disk.
3. **Drag-and-drop onto the main chat view has no dropzone.** `Thread` wraps the viewport in
   `ComposerPrimitive.AttachmentDropzone` only when it owns a composer (`thread.tsx:85-93`); the Chats view mounts
   `<Thread variant="full" hideComposer />` (`R/index.tsx:1357`) and `GlobalComposer` has no dropzone (grep:
   `AttachmentDropzone` appears only in `thread.tsx`). The empty state still says "drop files". Drop works in the tool
   side panel (which owns its composer). Open question: whether a dropped file navigates the window (Electron's
   default for a file drop is to load `file://…`, and `SH/urlTargets.ts` treats `file:` as internal).
4. The side-panel composer has no attach button by design (`chat-composer.tsx:10-14`); paste and drop still work there.
5. Folder drop: Chromium hands a directory as a `File` with empty type → `file_reference` → `fs.cp(recursive)`
   (`fileHandlers.ts:293-298`) — may work by accident; unverified.

---

## 4. Errors, long turns, and every host-authored string

Delivery path: `emitError` → `chat:error` IPC → preload pushes `{done:true, error}` → `stream.next()` rejects
(`M/preload.ts:765-786`) → the chat adapter's `await` throws → assistant-ui marks the message
`incomplete/error` → `MessagePrimitive.Error` renders the text in a red mono strip (`thread.tsx:346-354`,
`phaseB.css:486-497`). Strings a user can see:

| Situation | String | Where |
|---|---|---|
| No key | `No Anthropic API key configured. Add one in Settings.` | `M/index.ts:486`, `AS/index.ts` startQuery guard |
| Key rejected after refresh | `Your Anthropic API key was rejected. Update it in Settings and try again.` | `agentSession.ts:822` |
| Agent never started (5 min) | `Agent failed to start. Check the Debug panel for details.` | `agentSession.ts:526` |
| Stopped while booting | `Session stopped while waiting for agent` | `agentSession.ts:563` |
| Context overflow | `This conversation is too long for the model's context window, so the request was rejected before the model saw it. Its history has been reset — the next message will start from a clean context, without the earlier turns in this chat.` (as an assistant text, persisted) | `agentSession.ts:100-103,1313-1327` |
| Swallowed resume turn | `The agent did not answer that message. Its turn was spent on a background command left over from the previous session, and a second attempt came back empty as well. Send it again.` | `agentSession.ts:198-200` |
| Unparseable SSE error | `Unknown agent error` | `agentSession.ts:1395,1403` |
| Auth retry exhausted (server) | `Failed to authenticate. API Error: 401` | `AS/index.ts:709` |
| SSE transport dead after 5 retries (~7.75 s) | raw Node error, e.g. `connect ECONNREFUSED 127.0.0.1:23201` | `agentSession.ts:794-850` |
| Boot status in indicator | `Starting agent service...` / `Waiting for agent...` | `agentSession.ts:533-535,550` |

**API error, rate limit (429), overloaded (529), network down.** The CLI retries internally and emits
`system/api_retry` with `attempt`, `max_retries`, `retry_delay_ms`, `error_status` (`sdk.d.ts:3433-3450`), plus
`rate_limit_event` (`sdk.d.ts:5410`). Acabox ignores both (`processQueryMessage` has no branch; grep `api_retry` in
`M/` finds nothing), so the user sees `THINKING…` for the whole retry window with no hint. When retries are
exhausted the CLI's synthetic "API Error: …" assistant text renders as an ordinary Acabox sentence and the
`result` row's `is_error` is stored but never displayed (`historyMessageConverter.ts:102-123` skips `result`
rows). Evidence this is what users get: the overflow incident in the root CLAUDE.md, where every turn "came back
`Prompt is too long`" as the reply before the host-authored explanation was added. For a non-technical user there
is no visual difference between "Anthropic is overloaded" and Acabox speaking. (Plausible from code; not run.)

**Agent server crash mid-turn.** `containerService` auto-restarts the server; the session's SSE reconnect loop
retries 250/500/1000/2000/5000 ms against the old session id. If the server is still down, the user gets the raw
`ECONNREFUSED` strip above. If it came back, `GET /sessions/:id/events` for a now-unknown id returns a 404 body with
no SSE events; `res.on('end')` resolves `connectSSE` as a *clean* termination (`agentSession.ts:1410`) →
`emitDone` → `chat:done` → the adapter loop breaks without `turn-complete` → the reply ends truncated with no
message at all (`chatAdapter.ts:225`). Partial rows are then swept on the next message (section 2). Plausible; flagged
as a risk to verify.

**Long turns (2 min, 15 min).** There is no turn timeout: the stall watchdog only fires on 45 s of total silence
(heartbeats every 15 s keep it alive, `agentSession.ts:456-461`); server idle eviction is 10 min of *inactivity*
(`AS/index.ts:125`); the renderer unsubscribes after 60 s idle but re-subscribes on turn end
(`useSessionSubscription.ts:8`). What the user sees at minute 2 or 15: `GENERATING`, the amber dots, `AGENTS 1 LIVE`,
and the running step line with its per-step clock (`bash … 7M 12S` only if the SDK reports `tool_progress`, else a
local clock that restarts per step, `turn-steps.tsx:84-88`). No "Worked for" total until the end. If they switch
to another app: nothing happens when it finishes except the unread dot, unless the agent remembers to call the
notification tool.

**Jargon in error/system copy for this audience:** "agent service", "Agent failed to start", "Debug panel",
"context window", "resume", "background command left over from the previous session", "API Error: 401",
`ECONNREFUSED`, `EXIT 1`.

---

## 5. Chat organisation

- **List** (`thread-list.tsx`): `N CONVERSATIONS` / `Chats` / `Every conversation you've had with me. Most recent
  first.`; rows show title, tool chip (`Chat for <tool>`), preview `You: … · CS: …`, relative date, ⋮ menu with
  `Rename` and `Delete` (confirm: `Are you sure you want to delete "X"? This action cannot be undone.`).
  **"CS:"** is Coscientist jargon (`thread-list.tsx:303`, `R/chatPreviewStore.ts:69`) — the product is Acabox and
  the agent is told never to call itself Claude (`M/hostApps/identityPreamble.ts`), yet the list calls it "CS".
- **Row date is `createdAt`**, while the list is sorted by last activity (`thread-list.tsx:238,318-320`;
  `chatRepository.ts:149` sorts by `updated_at`). A chat that just moved to the top can read `1 week ago`
  (acknowledged in the root CLAUDE.md as "Seen, not changed").
- **Search**: titles + message prose (FTS5 trigram), 150 ms debounce, up to 3 highlighted hit lines + `+N more`,
  `No chats mention "x".` (`thread-list.tsx:148-174,299-313`; `R/useProseSearch.ts`; `SH/proseSnippet.ts`). Tool
  output is deliberately not indexed; a hit opens the chat but does not scroll to the message (root CLAUDE.md
  "Not built: jump-to-message"). Home's `Search chats, tools, files…` (⌘K) just navigates to the Chats page.
- **No pin, no folders/projects, no archive, no bulk delete, no export** (adapter `archive()` no-op). Rail shows
  `Recents` (top 5) and `More`; Home shows `Jump back in` with `relTimeShort(updated_at)`.
- **Tool-linked chats**: a tool can own many chats; the side panel header is a dropdown `Chats for this tool` with
  `New chat`, each row `title · 3h` or `EMPTY`, plus `Open as full chat` and `Collapse panel`
  (`ToolWorkspace.tsx:275-370`). Chats are auto-linked when the agent scaffolds/opens a tool.
- **Titles**: 1 Haiku call per new chat, `5 words or less` (`M/index.ts:2184-2190`); rename inline from the header or
  the list; `Copy link to this chat` → `Copied` (`ChatHeader.tsx:144-154`).
- **Quick chat**: a hidden `Alt+Shift+A` global shortcut opens a Spotlight-style window (`M/index.ts:1252`,
  `R/QuickChatInput.tsx:85` placeholder `Ask anything...`), context capture is stubbed to empty
  (`M/quickChat.ts:24-26`), it always starts a *new* chat and auto-sends (`R/index.tsx:108-112`), and no UI or
  doc mentions it (grep). Undiscoverable and half-finished.

---

## 6. Model and effort picker

`Fable 5.1 — Highest intelligence, premium cost`, `Opus 5.5 — Newest Opus, most capable for ambitious work`,
`Opus 5 — Previous-generation Opus` (default), `Opus 4.8 — Older Opus`, `Sonnet 5 — Most efficient for everyday
tasks`, `Haiku 4.5 — Fastest for quick answers` (`SH/models.ts:48-55`); discovered models get `New from Anthropic —
may need an Acabox update` (`:156`). Effort `Low / Medium / High (Default) / Extra / Max` with the blurb `Higher effort
means more thorough responses, but takes longer and uses your limits faster.` and `Best on the most capable
models` on Max (`ModelSelector.tsx:42-50,250-262`). Pinned chats show a locked chip:
`This chat runs on Opus 5 · High, fixed when it started. Start a new chat to use a different model.`
(`ModelSelector.tsx:195-213`) — the pin rule is well explained.

For a scientist the names (Fable/Opus/Sonnet/Haiku, 4.8 vs 5 vs 5.5) carry no meaning; "premium cost" is the only
price signal and there is no relative-cost indicator; the default is the second-most expensive tier. The picker is
only in the docked composer and the tool-panel header (`ToolWorkspace.tsx:367`), so a chat opened from the Chats
page in detail view relies on the header meta line for what it runs on.

---

## 7. Markdown rendering

- **Tables** (GFM) are styled well (`phaseB.css:421-446`), **code blocks** have a language label + Copy, inline
  code is tinted; **task lists/strikethrough** via `remark-gfm` (`markdown-text.tsx:141`).
- **LaTeX/math: none.** No `remark-math`/`rehype-katex` in `package.json`; `R/latex.d.ts` declares a `latex.js`
  module that is not a dependency (stale). `$\alpha$` renders as literal dollars — a real gap for scientists.
- **Images in replies do not render.** No `img` component override (`markdown-text.tsx:197-264`), so
  `![plot](output/plot.png)` resolves against the renderer origin and breaks; CSP already allows
  `img-src 'self' data: local-file:` (`R/index.html:6`), so a `local-file://` rewrite is feasible. The only way
  to "see a plot" is for the agent to write it to disk and the user to open the file viewer, or to build a tool.
- **File links.** Backticked paths with a known extension become clickable and open the in-app viewer
  (`markdown-text.tsx:85,237-252`). A Markdown link to a local path (`[results](output/results.csv)`) goes to
  `AnchorWithDoi` → `shell.openExternal` → `validateExternalUrl` refuses anything but https
  (`src/utils/urlValidation.ts:38-45`) → **silent no-op**. Plain-text paths are inert.
- **HTML replies.** If a reply starts with `<`, it is sanitized and rendered as HTML with Word-overlay-era styles
  (`markdown-text.tsx:20-24,135-137`, `WritingAgentView.css`). Legacy path; a reply that begins with `<details>` or
  a pasted tag gets different typography than everything else.

---

## 8. Compared with Claude.ai / ChatGPT (concrete gaps)

| Modern chat UI | Acabox today |
|---|---|
| Copy reply, edit & resend, retry/regenerate, branch on edit | none; only code-block copy and Quote |
| Stop keeps what was written so far | Stop kills the process and the partial reply is deleted on the next message |
| Structured questions with option chips | prose questions; turn ends |
| Permission prompts for risky actions / plan approval | everything auto-approved; plan invisible |
| Inline images/plots, LaTeX | neither |
| Image attachments viewable in history | chip with filename only |
| Clear error states ("rate limit, retrying", "connection lost") | THINKING… then an API error in Claude's voice or a raw ECONNREFUSED |
| Pin/folders/projects/archive/export | rename and delete only |
| Completion notification when you're away | only if the agent calls a tool |
| Jump to the matched message from search | opens the chat at the bottom |

What Acabox does that they do not: collapsible steps with a measured `Worked for`, a running-step clock, quote
with provenance from any surface, chat-to-chat links, per-chat model pin with explanation, screenshot and
on-device dictation, host-authored explanations for overflow/swallowed turns, prose search with snippets.

---

## 9. Dead code and stale guidance in this area

- `tool-write.tsx` (unregistered card), `tool-labels.ts` (unused; still maps `mcp__ms-word__*`, `mcp__obsidian__*`,
  `mcp__apple-notes__*`, `mcp__google-docs__*`, `mcp__google-drive__*` — all dropped integrations),
  `approval-buttons.tsx` (pattern-matcher with no producer), `latex.d.ts` (module not installed), the
  `looksLikeHtml` + `WritingAgentView.css` path in `markdown-text.tsx`, and the quick-chat window with a stubbed
  `captureContext`. `App.css:1759-1870` styles todo/plan lists with hardcoded greys (`#555`, `#999`, `#bbb`) off the
  token system.
- `skills/acabox/SKILL.md:266-268` tells the agent mini-apps are "not shareable except as an exported zip" —
  sharing via `share.acabox.us` has shipped (root CLAUDE.md 2026-09-16), so the chat will give users a wrong "no".
- `AS/index.ts:1-11` header still says "runs inside the Podman container".

---

## 10. Ranked gaps (for the target audience)

1. **High — Stop destroys the session and discards the partial reply.** `agentSession.ts:1008-1025`,
   `AS/index.ts:1171-1190`, `chatRepository.ts:329-345`. SDK `interrupt()` unused (`sdk.d.ts:2713`).
2. **High — Final answer hidden when a turn ends on a tool call** (TodoWrite completion, build/open).
   `turnSteps.ts:117-127`, `turn-steps.tsx:236-266`, `src/cobuilding/CLAUDE.md:103-105`.
3. **High — No message actions**: copy, edit & resend, regenerate, branch. grep; `sessionListAdapter.ts:35-41`.
4. **High — Tool cards speak shell**: raw command on the row, `bash/grep/glob/fetch`, `EXIT 1`, raw stdout;
   model's `description` ignored. `tool-card-display.ts:42-101`, `tool-fallback.tsx:63-119`.
5. **High — API/rate-limit/network failures are invisible or in Claude's voice.** `agentSession.ts:1439-1589`
   ignores `api_retry`, `rate_limit_event`, `permission_denied`; `historyMessageConverter.ts:102-123` drops `result`.
6. **Medium — Oversize attachments fail silently** (`attachmentAdapter.ts:204-208` + vendored callers).
7. **Medium — Files from shared folders get duplicated into the workspace root** (`attachmentAdapter.ts:221-229`).
8. **Medium — No dropzone on the main chat view** despite "drop files" copy (`thread.tsx:85-93,148`; `index.tsx:1357`).
9. **Medium — Sent images not viewable** (`historyMessageConverter.ts:155-162`, `thread.tsx:247-260`).
10. **Medium — No inline images/plots, no LaTeX** (`markdown-text.tsx:141,197-264`; `package.json`).
11. **Medium — Local-path markdown links silently do nothing** (`doi-link.tsx:46-57`, `urlValidation.ts:38-45`).
12. **Medium — Clarifying questions are prose-only; `permission_denied` never surfaced** (`sdk-tools.d.ts:1102`).
13. **Medium — Plan mode cards can never show a plan** (`enter-plan-mode.tsx:19-37`, `thread.tsx:380`,
    `tool-card-display.ts:80-82`).
14. **Medium — Approval buttons are a dead, misleading pattern-matcher** (`approval-buttons.tsx:21-57`).
15. **Medium — Agent-server crash mid-turn ends the reply silently or with `ECONNREFUSED`** (`agentSession.ts:794-850,1410`).
16. **Medium — No completion notification for work finished while away** unless the agent calls the tool.
17. **Low — "CS:" jargon in previews/search hits; row date is createdAt** (`thread-list.tsx:238,303,318`).
18. **Low — Jargon in copy**: "paste a repo", "agent service", "Debug panel", "AGENTS 1 LIVE", "EXIT 1".
19. **Low — Model picker is a brand list, not a choice a scientist can make** (`models.ts:48-55`).
20. **Low — Quick chat (Alt+Shift+A) is undiscoverable and half-finished** (`quickChat.ts:24-26`).
21. **Low — Dead code / stale skill text** (section 9).

## 11. Ideas (model calls per use · effort)

1. **Soft Stop**: call `interrupt()` instead of `/stop` for a user Stop; write a `result` row with
   `subtype:'cancelled'` so partial output survives `cleanupOrphanTurnRows`; keep the session for the next message.
   0 model calls · M.
2. **Never fold the answer**: compute the fold boundary as "last non-blank text part" when the trailing tool calls are
   checklist/outcome tools; or render the last prose part outside the fold always. 0 · S.
3. **Plain-English tool rows**: show Bash `description` on the row (command in the expanded body), relabel
   `bash→Ran a command`, `grep/glob→Searched files`, `fetch→Read a web page`, `EXIT 1→Failed`; summary line stays. 0 · S.
4. **Honest error states**: map `api_retry` → `Anthropic is busy — retrying in 8s (2 of 10)`, `rate_limit_event` →
   `Usage limit reached, resets at 14:30`, `error_status:null` → `Can't reach Anthropic — check your connection`,
   `result.is_error` → a red strip instead of prose; handle `permission_denied` → `Acabox wasn't allowed to run X`.
   0 · M.
5. **Attachment failures as a composer notice** (reuse `cdMicNotice`): too large, unsupported, copy failed. 0 · S.
6. **Reference shared-folder files in place**: resolve the native path through `user_directory_paths` before deciding
   to copy; copy strangers into `attachments/` not the root. 0 · S.
7. **Dropzone on the full chat** (wrap the Chats detail column) and a visible drop target. 0 · S.
8. **Inline images + viewable sent images**: `img` override mapping workspace-relative `src` to `local-file://`
   with a lightbox; persist a small thumbnail for sent images. 0 · M.
9. **Message action bar**: Copy (markdown), Edit & resend, Retry. Copy 0; Edit-resend/Retry = 1 turn each,
   user-initiated (replaces a retype, so net neutral). S/M. Branching needs a message-tree model: L.
10. **Structured questions**: add `canUseTool` relay (host answers via the renderer) and render `AskUserQuestion`
    as option chips; the answer continues the same turn, saving the extra round trip. 0 extra · L.
11. **"Changed N files" line at turn end** derived from Write/Edit/NotebookEdit parts already in the message,
    click-to-open; later a diff from Edit's `old_string/new_string`. 0 · S (list) / M (diff).
12. **Finish notification from main**: when a turn ends unseen (`chatActivity` already knows) and ran > 30 s, show an
    OS notification that opens the chat; drop the reliance on the agent's tool call. 0 · S.
13. **Chat organisation**: pin (`sessions.pinned`), last-activity date on rows, `Acabox:` instead of `CS:`, multi-select
    delete; search hit → scroll to message. 0 · S–M.
14. **LaTeX**: `remark-math` + `rehype-katex` with bundled fonts (offline). 0 · S.
15. **Model picker for scientists**: three presets (`Best / Balanced / Fast`) with relative-cost dots and the raw list
    under `More models`; keep the pin chip. 0 · S.
16. **Plan mode**: either drop `EnterPlanMode/ExitPlanMode` from the allowlist (simplify) or render ExitPlanMode's
    plan with Approve/Revise via the same `canUseTool` relay. 0 · S (remove) / L (real).
17. **Delete dead code**: `tool-write.tsx`, `tool-labels.ts`, `approval-buttons.tsx`, `latex.d.ts`, HTML-reply path,
    quick-chat window (or finish and advertise it). 0 · S.
18. **Overall turn clock** in the `GENERATING` chip (`GENERATING · 2m 14s`). 0 · S.

## 12. Open questions (need a live run)

- Does `queryInstance.close()` on Stop kill in-flight Bash children (long Python runs), or do they outlive the turn?
- On SDK 0.3.280 with no `canUseTool`, is a tool outside `allowedTools` auto-denied (SDK doc `sdk.d.ts:5291`) or run
  anyway (root CLAUDE.md's measurement "allowedTools: [] still ran Bash")? This decides what AskUserQuestion and
  ExitPlanMode do today.
- Does dropping a file on the full chat view navigate the window to `file://…` (no dropzone; `file:` is "internal" in
  `SH/urlTargets.ts`)?
- Agent-server crash mid-turn: raw `ECONNREFUSED` strip, or a silently truncated reply (404 on `/events` resolving
  as a clean end)?
- Does a dropped folder reach `copyToWorkspace` as a directory (and therefore already "work")?
- How often does `api_retry` appear in production `cobuilding.log`? (Sizes the value of idea 4.)
