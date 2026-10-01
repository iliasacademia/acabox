# Acabox review — Mini-app ("tool") lifecycle

Reader: tools-lifecycle. Read-only pass over the renderer, main-process and
skill/asset code that governs a tool from "ask for it" to "share it". Every
claim below is anchored to a file:line in the repo
(`/Users/iliasbeshimov/Documents/Dev Folders/Acabox`, paths relative to
`src/cobuilding/` unless they start with `src/` or `docs/`). Judged throughout
for a non-technical scientist who can describe what they want but cannot read
code, use a terminal, or debug a build.

---

## 0. One-paragraph verdict

The lifecycle is unusually well instrumented for a desktop app (host-owned
jobs, truthful status chips, "being written" vs "broken" distinction, durable
tool-data, archive, export/import, a share pipeline). What it lacks is the
three things every consumer vibecoding product treats as table stakes: **a way
back** (no version history, undo, or restore for a tool after a bad edit), **a
way to point** (the selection shim quotes text; it cannot identify an element),
and **a way out of a stuck install** (a failed `pip` wave leaves the tool
cycling FAILED → QUEUED → INSTALLING forever with no button, and the one piece
of advice the code knows — "Install Python 3 via Homebrew… then restart
Acabox" — is thrown away before it can reach a screen). Several agent-facing
instructions are stale in a way that produces tools which fail on their first
Run (the R kernel is still the leading example in the skill).

---

## 1. Walkthrough — what the scientist actually experiences

### 1.1 Asking for a tool

Three entry points, all of which end in a chat turn:

- Home → the dashed card **"Build a new tool" / "Describe it below — ACABOX
  scaffolds it"** (`renderer/components/command-desk/CommandDesk.tsx:149-150`)
  only focuses the docked composer. "Scaffolds" is developer vocabulary.
- Tools page → **"Ask me to do something or build a tool"** card
  (`renderer/components/ToolsPage.tsx:398-399`) opens a modal **"Create a
  tool"** with placeholder *"e.g. Analyze scratch assay images and produce
  closure curves..."* (`:745`) and a **"Create Tool"** button (`:763`). It
  composes `Create a tool for me that does the following:\n\n<text>` into a
  NEW thread and sends it (`:253-258`). Good: a real, discoverable, low-jargon
  starting point.
- Any chat message; the `manage-mini-application` skill triggers on "make an
  app / build a tool / create an interface" (`skills/manage-mini-application/SKILL.md:11-13`).

Cost: one agent turn (the user's own). Nothing here adds model calls.

### 1.2 The card appears; "BEING WRITTEN"

The agent runs `manage_mini_app.mjs --name … --description … --icon …`
(`SKILL.md:27-34`). The scaffold writes `manifest.json`, `src/index.html`,
`src/index.tsx`, `notebook.ipynb`, `dist/`, and the `input`/`output` symlinks
into `tool-data/<dir>/` (`skills/manage-mini-application/scripts/manage_mini_app.mjs:67-87, 179-302`).
The tool card exists on Home and the Tools page from this moment, before any
UI code exists.

If the user clicks it now, main refuses to run esbuild because `src/App.tsx`
is missing (`main/miniAppBuilder.ts:97-109`, `reason: 'source-missing'`), and
the viewer shows a non-error screen:

> **BEING WRITTEN · 14:02** — "Claude is still writing this tool." — "It
> appeared here as soon as it was scaffolded, but its source has not been saved
> yet. This view will build it on its own the moment the file lands."
> Buttons: **Check again**, **Open the chat**
> (`renderer/components/miniAppBuildState.tsx:76-92`)

It polls for `src/App.tsx` every 2 s and builds on its own
(`renderer/components/MiniAppViewer.tsx:263-276`). This is a genuinely good
piece of UX. The header chip reads **BEING WRITTEN** (`MiniAppViewer.tsx:448`).
Nothing in this state shows *what the agent is writing* — there is no streaming
or partial preview (see §2.3).

### 1.3 Build and first boot

- Build: the agent calls `build_and_open_mini_application`, which runs esbuild
  on the host (`main/controllers/AgentInfrastructureController.ts:200-206`,
  `main/miniAppBuilder.ts:120-130`). On failure the *agent* receives
  `Build failed for <dir>:\n<esbuild stderr>` and is told to fix and retry
  (`agent-server/index.ts:291-292`). So build errors already have an agent-side
  auto-fix loop within the turn. The chat card reads **"Building tool" /
  "Build failed" / "Tool built"** (`renderer/components/assistant-ui/tool-labels.ts:167-171`)
  and the tool opens only on a successful build (`renderer/index.tsx:566-601`).
- Dependencies: `BackgroundBuilder` watches `.applications/` and starts pip/npm
  waves as soon as `requirements.txt` / `package.json` / `setup/*.sh` appear
  (`main/backgroundBuilder.ts:55-93`), so installs begin before the user opens
  the tool. When they open it before deps are ready, the viewer replaces the
  iframe with a checklist:

  > **FIRST BOOT — INSTALLING 4 PACKAGES** · 1/4, one row per package with
  > **DONE / INSTALLING… / QUEUED / FAILED**, a count-based progress bar, and
  > the last pip line (`▸ Downloading torch-2.x…`)
  > (`MiniAppViewer.tsx:684-697, 650-668`)

  "FIRST BOOT" is the header chip (`:458`, `toolStatusDisplay.ts:31`). The
  skill tells the agent to say once that "deps are still installing in the
  background" and let the in-app UI take over (`SKILL.md:109`) — correct
  guidance, except that it calls the screen *"Installing software…"*, a label
  that no longer exists (stale, minor).

**What goes wrong here is severe for this audience** (§4, F1/F2). The gate's
retry is unconditional: `ensureAppDeps` rejects → `console.error` →
`setTimeout(attemptEnsureDeps, 3000)` (`MiniAppViewer.tsx:836-841`); the
installer then re-queues the failed packages (`main/packageInstaller.ts:120-151`),
so the rows cycle **FAILED → QUEUED → INSTALLING… → FAILED** indefinitely. There
is no "Skip", no "Ask Claude to fix it", no visible error text (the pip error
is only in the dev console), and the tool UI is never reached even when the
failing package is irrelevant to rendering. If system Python is missing the
code knows exactly what to say — `'Install Python 3 via Homebrew (brew install
python) or from python.org, then restart Acabox.'`
(`main/pythonSetup.ts:155-163`) — but that `userActionable` field is dropped
when the installer rewraps the error (`main/packageInstaller.ts:278-283`) and,
per `grep userActionable`, no UI anywhere renders it.

### 1.4 Open and use

Opening (card, "Use" button, or the agent's tool) adds a pinned tab and
switches to tool detail (`renderer/index.tsx:786-814`). The layout is a tab
bar, a header, the iframe, and a chat side panel (320–560 px, draggable,
collapsible; `renderer/components/command-desk/ToolWorkspace.tsx:27-28, 212`).
The side panel is pointed at the tool's own chat(s), selectable from a
dropdown **"Chats for this tool"** with **"New chat"**
(`ToolWorkspace.tsx:301-321`). This chat↔tool link is made deterministically at
scaffold time (`main/appChatLink.ts`) — the single most important iteration
affordance, and it works.

Inside the tool, what the user sees is whatever the agent composed from the
`@reusable` kit (§2.6): typically a **"Choose file"** picker
(`assets/reusable/FileSlotPicker.tsx:72`), a **Run** button that reads
**"Running... (12s)"** while a kernel cell executes
(`assets/reusable/RunButton.tsx:43`), an amber **"Results out of date — params
have changed since last run"** tag (`RunStateBadge.tsx:25`), Plotly charts,
and an **"Output Files"** card with per-file **Download** and an **"Open output
folder"** icon (`OutputFileList.tsx:35-45, 80-86`).

Parameters and chosen files are persisted to the tool's `notebook.ipynb`
parameters cell by `useAppState` (`assets/reusable/useAppState.ts:5-14,
326-394`) so they survive tab switches and restarts. Long work is host-owned
(`main/jobRegistry.ts`), so the home card reads **WORKING** with no viewer
open, **RAN WHILE CLOSED / INTERRUPTED** after a restart, and the header shows
**Stop** while working (`MiniAppViewer.tsx:464-476`,
`toolStatusDisplay.ts:28-37`). Activity lists "Running now / Recently finished
/ Needs attention" with honest wording ("Ran while Acabox was closed — result
unknown") (`renderer/components/command-desk/ActivityPanel.tsx:69-79`).

### 1.5 Iterating ("make the threshold a slider")

The user types into the tool's side-panel chat. The agent edits `App.tsx`,
calls `build_and_open_mini_application`, main broadcasts `miniApps:built`,
and the open tab remounts the iframe (`main/index.ts:1031-1042`,
`renderer/index.tsx:686-694`). `useAppState` re-hydrates, so params survive;
transient UI state (open sections, zoom) does not. This loop is sound. What it
lacks:

- **No undo.** If the edit breaks or worsens the tool there is nothing to
  click. See §2.1.
- **No way to point at the thing.** The user must describe the element in
  words. The selection shim lets them quote visible text from the tool into
  the composer (`main/miniAppSelectionShim.ts`, `MiniAppViewer.tsx:987-1015`),
  which helps for labels, and the screenshot button lets them attach a
  picture. Neither identifies an element or a component. See §2.2.
- **No rename / description edit in the UI.** `grep -i rename` across
  ToolsPage, MiniAppViewer and ToolWorkspace returns nothing; the only path is
  asking the agent to edit `manifest.json` (`SKILL.md:48, 470`).

### 1.6 Errors

**Build failed** (esbuild). The iframe is replaced by:

> **BUILD FAILED · 14:07** — "Build failed." — "The rebundle didn't come up.
> Full output:" `<pre>` with raw esbuild text — **Rebuild** · **Send to chat —
> let it fix itself** · **Copy output** (`MiniAppViewer.tsx:585-604`)

"Send to chat" composes `The build for \`<dir>\` failed. Diagnose and fix
it.\n\nBuild output:…` into the tool's chat and expands the panel if collapsed
(`:284-291`). It is also surfaced on Home/rail as **BUILD FAILED** with no
viewer mounted, because `buildHealth` persists it (`main/buildHealth.ts:6-19`),
and on Activity as *"This tool doesn't build, so it can't run. Last tried 4m
ago."* with **"Ask Claude to fix it"** (`ActivityPanel.tsx:210-215, 159-167`).
Both fix paths cost exactly one agent turn, triggered by the user. Good.

**Runtime exception inside the iframe.** `_bridge/error-capture.ts` hooks
`error`, `unhandledrejection`, `console.error`, non-2xx `fetch`, and resource
failures (`assets/bridge/error-capture.ts:41-123`); `<ErrorDisplay>` renders a
fixed bottom-right red stack: **"2 errors"** / **Clear all**, each row labelled
**Exception / Unhandled rejection / console.error / HTTP error / Resource
error** with an expandable stack and a **Fix** button that flips to **Sending…
→ Sent to chat** (`assets/reusable/ErrorDisplay.tsx:34-40, 135, 150, 253-278`).
`Fix` posts a structured prompt into the tool's chat asking Claude to first
decide whether it is bad input or a code bug (`MiniAppViewer.tsx:45-62,
1137-1143`). Two defects for this audience:

1. A React render crash leaves the app **blank**: the scaffolded
   `ErrorBoundary.render` returns `null` on error
   (`scripts/manage_mini_app.mjs:220-222`), so the user sees an empty white
   pane with a small red box in the corner and no "this tool crashed" message.
2. `requestFix` does **not** expand a collapsed chat panel (`:1137-1143`,
   contrast `:286` for the build-error path), so with the panel collapsed the
   button says "Sent to chat" and nothing visible happens except an amber dot
   on the collapsed strip.

The labels themselves ("console.error", "Unhandled rejection", stack traces)
are developer vocabulary; the Fix button is what makes the panel usable.

**Where "Ask Claude to fix it" does NOT exist:** the first-boot install
checklist (§1.3), the kernel-gateway start failure
(`'Kernel gateway exited before becoming healthy … Is jupyter installed in
<venv>?'`, `main/containerService.ts:1030-1033`; `'No kernel connection — is
the kernel gateway running?'`, `renderer/components/notebook/kernelRegistry.ts:229`)
— these reach the ErrorDisplay overlay only if the tool was already running
and the user pressed Run, and the agent cannot act on them (installs of Python
are hook-blocked, `hooks/block-host-installs.sh:41-42, 73-76`).

**Iframe load failure** shows developer text: *"Could not load application
`<dirName>`. Expected: `<abs path>/src/index.html`"* (`MiniAppViewer.tsx:1240-1246`).

### 1.7 Data

Working files live in `tool-data/<dir>/{input,output}` behind symlinks
(`main/toolDataMigration.ts:6-15`); deleting a tool removes code only and the
data surfaces on the Tools page under **"Saved data"** — *"Working files kept
from tools you deleted. Delete the data here when you no longer need it."* —
with **Finder / Browse / Delete data** and an in-page viewer
(`ToolsPage.tsx:577-651`). `tool-data/` is not dot-prefixed, so it is also
browsable in the Files tab. This is a strong, honest design and the right
default for scientists.

### 1.8 Export / import / archive / delete

- Export is the header **More ▸ Download** item (`MiniAppViewer.tsx:550-553`)
  → a save dialog for `<dir>.zip` with input/output dereferenced
  (`main/fileHandlers.ts:637-682`). Named "Download" in the viewer but the
  Tools page footer says **"Import tool"** (`ToolsPage.tsx:658`) — the pair
  does not read as a pair, and "Download" collides with the per-file Download
  inside tools.
- Import picks a zip, suffixes collisions `_1`, re-splits input/output, opens
  the tool, kicks deps (`fileHandlers.ts:684-735`, `ToolsPage.tsx:261-276`).
- Archive/Restore via the row's **Settings** panel (`ToolsPage.tsx:504-510,
  561-564`); archived tools leave Home/rail (`renderer/index.tsx:830-832`).
- Delete: confirm modal *"Delete <name>? This removes the tool's code. Any
  input and output files it saved are kept and stay browsable under Saved
  data."* (`ToolsPage.tsx:666-668`), then `rm -rf` of the code dir with no
  trash (`fileHandlers.ts:629-631`). Combined with §2.1 this means the code of
  a deleted tool is unrecoverable unless it was exported.

### 1.9 Sharing

**What the user must set up.** Settings → Sharing asks for **Site URL**, **API
URL**, **Publish token** and offers **Test**
(`renderer/components/SharingSettings.tsx:106-170`). Its hint says the setup
*"lives in `src/share-workers/README.md`"* (`:98-104`) — a path inside the
source repository, which the end user does not have. The README's path to a
working deployment is: Cloudflare account, `npx wrangler login`, create an R2
bucket (dashboard + payment method per CLAUDE.md), deploy two Workers, create
a Zero Trust team, create a Google OAuth client in Google Cloud Console, create
an Access application and policy, copy the AUD tag into `wrangler.toml`,
redeploy, then paste URLs and a token generated with `openssl rand -hex 32`
(`src/share-workers/README.md:107-269`). Labelled "~1 hour"; for the target
audience it is not achievable at all. The realistic model is the one CLAUDE.md
records as already live — operator-hosted `share.acabox.us` — in which case
the user needs only the two URLs and a token, but the token is a **single
shared `PUBLISH_TOKEN`** that *"writes everything… Anyone holding it can
replace or delete any artifact"* (`docs/design/sharing.md`, Hazards). Handing
it to many scientists is a real risk (§4, F10).

**Who can open a shared tool.** Anyone with an `@academia.edu` Google account,
via Cloudflare Access (`README.md:49-52, 212-221`); the `/` listing shows
every published item to every viewer (`listingPage.ts:52`, *"Nothing published
yet."*); free for 50 distinct viewers, the 51st is blocked
(`README.md:223-229`). No per-tool audience, no link-only mode, no external
collaborators.

**What works read-only.** The shim serves `readFile`/`readDirectory` from the
snapshot, `downloadFile`, `openExternal`; everything else (Run, kernel,
Claude, APIs, writes) refuses with *"This is a shared, read-only snapshot. Open
the tool in Acabox to run it."* (`shared/share.ts:102-103`), and the viewer
banner adds *"This tool tried to run something; shared copies are read-only."*
(`src/share-workers/web/viewer/viewer.ts:32`). `useAppState` re-renders the
last run's results from the snapshotted notebook, so charts and tables of the
last run are visible and interactive; nothing can be recomputed. The publish
dialog shows a size table (Code/Output/Input/Vendor/Total), an **"Include
input data"** checkbox (default on), *"Viewers need an @academia.edu Google
account. Everything in the table is uploaded."*, and
Publish/Refresh/Unpublish with a two-step unpublish
(`renderer/components/share/SharePublishDialog.tsx:201-286`). **SHARED ·
BEHIND** appears when the local tool has changed since publishing
(`ToolsPage.tsx:137`). The mechanics are good; the onboarding is the problem.

---

## 2. The specific questions

### 2.1 Version history, undo, rollback — none

Checked rather than assumed: `grep -rln "workspace-file-backups|rollback|
version history|simple-git|isomorphic-git|git init" main/` hits only
`main/skills.ts` (backups of skill/hook files on restore) and
`main/mcpHost/index.ts` (a comment). No git in the workspace, no snapshot of
`.applications/<dir>` at any point, no "previous version" UI; delete is `rm`
(`fileHandlers.ts:629-631`); unpublish deletes immediately with no trash
(`docs/design/sharing.md`, Open decision 6). The agent's `Edit`/`Write`
overwrite `App.tsx` in place. After a bad edit the user's only recourse is to
ask Claude to "put it back", relying on the model's memory of the previous
text. For people who cannot read a diff, this is the single largest gap
against every comparable product.

### 2.2 Visual editing — quote-to-chat only

`miniAppSelectionShim.ts` reports `{ text, rect }` for a text selection inside
the frame (`:95-98`); the host turns it into a quote chip attributed to the
tool (`MiniAppViewer.tsx:1001-1013`). It does not report an element, a DOM
path, a component name, or allow clicking a non-text element (a chart, a
button). So "click the slider and say make it go to 1.0" is not possible; the
user can select the label text "Threshold" and quote it, or take a screenshot.
Useful, but not visual editing.

### 2.3 Live preview — no

The iframe loads `dist/bundle.js` only (`manage_mini_app.mjs:174`); there is
no HMR and no partial render while the agent writes. The BEING WRITTEN poll
(§1.2) turns the first saved `App.tsx` into a build within 2 s, which is the
closest thing to a preview. Subsequent agent edits are visible only after the
agent's own `build_and_open` call.

### 2.4 How the user learns what a tool does

- `manifest.description` (≤ 80 chars, "Write it for the user, not the agent",
  `SKILL.md:38`) under the title on Tools (`ToolsPage.tsx:443`) and Home
  (`CommandDesk.tsx:126-128`, fallback *"No description yet — open it and ask
  for one."*).
- The agent's Step 5 chat summary — *"Your [tool description] tool is ready to
  use."* for simple tools, a short how-it-works for complex ones
  (`SKILL.md:460-464`). It lives in the chat only.
- Inside the tool: whatever the agent wrote. The `@reusable` kit has no help,
  empty-state or "about" component (only the `ab-empty` CSS class,
  `assets/vendor/acabox.css`). No README per tool, no in-app "About this
  tool" panel, no link from the viewer header to the chat that built it other
  than the side-panel dropdown.

### 2.5 Resizable / pop-out / print / export

- Resizable: only the chat panel (320–560). The tool fills the rest.
- Pop-out: none for the tool (`grep -i "popout|pop-out|window.print|
  printToPDF"` across the viewer/workspace/main returns only a comment); the
  side panel's **"Open as full chat"** (`ToolWorkspace.tsx:334`) pops the chat
  out of the tool view, the opposite direction.
- Print / PDF: none.
- PNG: `ACABOX_CONFIG` sets `displayModeBar: false`
  (`assets/reusable/plotTheme.ts:140-145`), which removes Plotly's camera
  button — the one zero-effort "save this chart" affordance scientists know.
- CSV/binary export: `downloadFile(filename, content)` takes a **string**
  (`bridge-api.md:26`), so a tool cannot hand the user an XLSX or a PNG from
  the React side. Worse, **`OutputFileList`'s Download button is a silent
  no-op for image outputs**: it only downloads when `readFile` returns
  `type === "text"` (`assets/reusable/OutputFileList.tsx:56-65`); for a PNG
  the click does nothing and shows nothing.

### 2.6 The `@reusable` vocabulary and what is missing

Shipped (`assets/reusable/index.ts:1-34`): `VolcanoPlot`, `MAPlot`,
`OutputFileList`, `ErrorDisplay`, `useAppState`, `useKernelAction`,
`useRunsWhileClosed`, `readJsonOutput`, `FileSlotPicker`, `RunButton`,
`RunStateBadge`, `plotTheme` (`ACABOX_*` palettes/layout/config,
`REGULATION_COLORS`), `csv-utils` (`parseCsvLine`, `parseCSVPreview`),
`types` (`classifyGene`). Plus CSS-only `ab-*` classes: `ab-table`,
`ab-stats/ab-stat`, `ab-tabs/ab-tab`, `ab-input/ab-select/ab-textarea/
ab-field/ab-check`, `ab-chip/ab-tag/ab-dot`, `ab-card`, `ab-note`, `ab-empty`,
`ab-spinner`, `ab-rows`, `ab-divider` (`assets/vendor/acabox.css`).

Missing for typical scientific tools (each would otherwise be re-invented per
tool by the agent, inconsistently):

| Need | Today | Gap |
|---|---|---|
| Data table with sort / filter / paginate / export CSV | `ab-table` CSS only | No component |
| Parameter form (number with units, slider+input, select, toggle) | `ab-input/ab-select/ab-field` CSS | No component, no validation idiom |
| Multi-file / drag-and-drop upload | `FileSlotPicker`: one native dialog, one file per slot (`useAppState.ts:485-487`) | No drop zone, no multi-select |
| Progress for long runs | `RunButton` shows elapsed seconds; `executeCode` returns only when done (`bridge.ts:159`) | No streamed log, no phase text, no % |
| Export buttons (PNG/CSV/XLSX) | string-only `downloadFile`; Plotly modebar hidden | No binary export path |
| Generic themed charts (scatter, bar, box, heatmap, line) | only volcano and MA | Agent rebuilds the responsive-container pattern each time (`skills/react-plotly/SKILL.md:36-80`) |
| Image/figure viewer for `output/*.png` | `hostAPI.fileUrl` + raw `<img>` | No zoom/download wrapper |
| Empty state / help note / "about this tool" | `ab-empty`, `ab-note` CSS | No component or convention |

### 2.7 Python dependencies: 5–15 minutes, and a missing Python

Covered in §1.3. Summary for the audience: the checklist is clear while things
work; the moment a wheel fails to build (torch on an old macOS, a package with
no arm64 wheel, no network) the screen loops forever with no exit and no
explanation. With no system Python at all, the venv bootstrap fails
(`pythonSetup.ts:155-163`), every pip wave fails, and the only text with an
action in it never reaches the user. The `--probe`-style "absent rather than
disabled" discipline applied to dictation was not applied here.

### 2.8 Jargon on these surfaces (exact strings)

| String | Where | Why it is jargon for this audience |
|---|---|---|
| "Describe it below — ACABOX scaffolds it" | `CommandDesk.tsx:150` | "scaffolds" |
| "ON-DEMAND" tag on every tool row | `ToolsPage.tsx:441` | means nothing to a user; it is on every row |
| "PRE-BUILT" tag | `ToolsPage.tsx:440, 547` | dead concept (`nativeTools:getUrl` returns `null`, `main/index.ts:2709-2711`) |
| **Rebuild** button, always visible | `MiniAppViewer.tsx:498`; `:593` | the user never "builds" anything |
| "The rebundle didn't come up. Full output:" + raw esbuild | `MiniAppViewer.tsx:587-588` | "rebundle" |
| "FIRST BOOT — INSTALLING 4 PACKAGES", QUEUED/INSTALLING… | `MiniAppViewer.tsx:684, 650-668` | "boot", "packages" — acceptable but opaque; no "what is being installed and why" |
| "Waiting for container..." / "Setting up environment..." | `MiniAppViewer.tsx:706-708` | Podman-era text still reachable; there is no container |
| "Could not load application X. Expected: /Users/…/src/index.html" | `MiniAppViewer.tsx:1240-1246` | absolute path |
| "Exception", "Unhandled rejection", "console.error", "HTTP error", "Resource error", stack traces | `ErrorDisplay.tsx:34-40, 207-226` | developer taxonomy |
| "View source" (file tree with `dist`, `bundle.js`, `manifest.json`, `notebook.ipynb`) | `MiniAppViewer.tsx:540`, `:1298-1421` | fine as an escape hatch, but it is a top-level menu item next to Download |
| "Download" (= export zip) vs "Import tool" | `MiniAppViewer.tsx:552`, `ToolsPage.tsx:658` | not a recognisable pair |
| "Kernel gateway exited before becoming healthy… Is jupyter installed in …?" | `containerService.ts:1030-1033` | can surface in the overlay |
| "No kernel connection — is the kernel gateway running?" | `kernelRegistry.ts:229` | same |
| "Publish token", "Site URL", "API URL", "`src/share-workers/README.md`" | `SharingSettings.tsx:98-134` | infrastructure vocabulary and a repo path |
| "Code · Output · Input · Vendor" size table | `SharePublishDialog.tsx:204-208` | "Vendor" |

The chip vocabulary (**IDLE / WORKING / BUILDING / BUILD FAILED / BEING WRITTEN
/ RAN WHILE CLOSED / INTERRUPTED / SHARED · BEHIND**) is mostly good; "IDLE"
and "BUILDING" are borderline but short.

---

## 3. Gaps relative to Lovable, Bolt, v0 and Replit (from training knowledge)

| Capability those products treat as basic | Acabox today |
|---|---|
| **Version history with one-click restore** (Lovable History/revert, Bolt and Replit checkpoints/rollback) | None (§2.1) |
| **Select an element and describe a change** (Lovable Visual Edits, v0 element picker) | Text-quote only (§2.2) |
| **Live preview while generating / instant reload** (Bolt WebContainer, v0 streaming) | Build-then-remount; "being written" placeholder only (§2.3) |
| **Error → "Try to fix" loop that reads the runtime error automatically** | Build errors: agent fixes in-turn. Runtime: manual **Fix** button exists but the agent never hears of an error unless clicked; install failures have no fix path at all |
| **One-click publish, link, custom domain** | Requires operator-level Cloudflare setup, three settings fields and a shared secret (§1.9) |
| **Templates / remix / gallery** | One working template (`westernBlotAnnotator`); one shipped non-functional (`differentialExpression`, `SKILL.md:113`) copied into every workspace on boot (`main/skills.ts:276-280`); no remix/duplicate/fork of an existing tool (grep "duplicate|fork" finds none) |
| **Rename project / edit description** | Not in UI |
| **Streaming code/logs for long runs** | Elapsed seconds only |
| **Export the result as PDF/PNG/CSV from the UI** | String-only download; Plotly camera disabled; image Download no-op |

Where Acabox is ahead of those products for this audience: durable tool-data
that survives deletion, host-owned jobs with honest WORKING / RAN WHILE CLOSED,
a Stop button, truthful first-boot progress per package, the chat↔tool link,
local files as first-class inputs, and the read-only share model with
"behind" detection.

---

## 4. Findings

Severity is for the non-technical scientist.

**F1 — Install failure loops forever with no exit (high, bug).**
`MiniAppViewer.tsx:826-847` retries `ensureAppDeps` every 3 s on rejection;
`packageInstaller.ts:120-151` re-queues failed packages; the rows cycle and
the tool UI is never reached. No "Skip and open anyway", no "Ask Claude to fix
it", no error text on screen. Scenario: any `requirements.txt` with a package
that has no arm64 wheel, or offline.

**F2 — The one actionable Python message never reaches the user (high, bug).**
`PythonSetupError.userActionable` (`pythonSetup.ts:89-94, 155-163`) is dropped
at `packageInstaller.ts:281` and rendered nowhere (`grep userActionable` →
definition only). A machine with no Python 3 shows F1's loop.

**F3 — No version history / undo / restore for a tool (high, missing-feature).**
§2.1. A bad edit or a deletion of code is unrecoverable from the UI.

**F4 — Stale skill guidance still leads with the R kernel, producing tools
that fail on Run (high, stale-guidance).** `SKILL.md:45` "override with
`--kernel ir` for R"; `:274` `kernel: "ir", // or "python3"` as the lead
example; Step 3 example is R with `jsonlite` (`:442-450`); while `:113` and the
install wrapper (`assets/install:70-73`) say R does not exist. The shipped DE
template still sets `kernel: "ir"` (`templates/differentialExpression/src/App.tsx:169`)
and is copied to every workspace (`main/skills.ts:276-280`) despite "do not
scaffold it" — the simplification rule says remove it.

**F5 — Sharing setup is developer-only and the Settings hint points at a repo
path (high for anyone who is not the operator, ux-friction).**
`SharingSettings.tsx:98-104`; `src/share-workers/README.md:107-269`.

**F6 — `OutputFileList` Download is a silent no-op for image outputs (medium,
bug).** `OutputFileList.tsx:56-65` downloads only `type === "text"`; a PNG
click does nothing.

**F7 — No chart/figure export: Plotly modebar hidden, string-only
`downloadFile` (medium, missing-feature).** `plotTheme.ts:140-145`;
`bridge-api.md:26`; `SKILL.md:627` tells the agent not to add other download
buttons.

**F8 — A React render crash leaves a blank tool (medium, ux-friction).**
`manage_mini_app.mjs:220-222` renders `null`; only the corner overlay signals
anything.

**F9 — In-iframe "Fix" does not expand a collapsed chat panel (medium,
ux-friction).** `MiniAppViewer.tsx:1137-1143` vs the build-error path at
`:286`.

**F10 — One shared publish token for all users (medium → high if multi-user,
risk).** `docs/design/sharing.md` Hazards; `README.md:152-162`. With an
operator-hosted deployment every user who can publish can also replace or
delete anyone else's shared tool.

**F11 — Input data is uploaded by default when publishing (medium, risk).**
`SharePublishDialog.tsx:66-67` (`includeInput` defaults `true`), `:220`. For
clinical or unpublished data the safe default is off.

**F12 — No rename / description / icon editing in the UI (medium,
missing-feature).** `grep -i rename` → nothing; `SKILL.md:48, 470` route it
through the agent (1 turn to change a name).

**F13 — No in-tool help or "About" (medium, missing-feature).** §2.4; the
only durable explanation is an 80-char description.

**F14 — Progress for long runs is elapsed seconds only (medium,
missing-feature).** `RunButton.tsx:43`; `executeCode` is request/response
(`bridge.ts:159`), so a 10-minute pipeline shows "Running... (412s)".

**F15 — Jargon table in §2.8 (medium, jargon).** Highest-impact items:
"ON-DEMAND"/"PRE-BUILT" tags, "Rebuild" as a permanent header button,
"Waiting for container...", the `src/share-workers/README.md` hint, the
"rebundle" copy.

**F16 — Stale sharing design header (low, stale-guidance).**
`docs/design/sharing.md:1-30` says "Increment 0 … Not started" while
`src/share-workers/README.md:68-105` and CLAUDE.md record the live deployment
of 2026-09-16.

**F17 — Dead code (low, dead-code).** `renderer/components/MiniAppsTab.tsx` is
imported (`renderer/index.tsx:21`) and never rendered (`grep "<MiniAppsTab"` →
none), carrying a third vocabulary ("New Application", "Import App", "No
applications yet"). The `preBuilt` path (`nativeTools:getUrl` → `null`,
`main/index.ts:2709-2711`; **STARTING** forever at `MiniAppViewer.tsx:337`)
and the PRE-BUILT tags are unreachable or misleading.

**F18 — Skill text names a screen that no longer exists (low,
stale-guidance).** `SKILL.md:109` "Installing software…" view; actual header
is "FIRST BOOT — INSTALLING N PACKAGES" (`MiniAppViewer.tsx:684`). Also the
shipped `westernBlotAnnotator/src/App.tsx` is a 1,020-line single file while
`SKILL.md:118` tells the agent not to compose "one giant file".

**F19 — Export/Import naming does not read as a pair (low, ux-friction).**
"Download" (`MiniAppViewer.tsx:552`) vs "Import tool" (`ToolsPage.tsx:658`).

---

## 5. Ideas (model calls per use stated honestly; owner's rules applied)

| # | Idea | Model calls / use | Effort |
|---|---|---|---|
| I1 | **Tool history with Restore.** On every successful `buildMiniApp` (`miniAppBuilder.ts:141`) copy the code tree (`src/`, `notebook.ipynb`, `manifest.json`, `requirements.txt`, `package.json`, `setup/`; never `input`/`output`/`dist`) into `<userData>/tool-history/<dir>/<ts>/`, keep the last N, and add a header **History** menu listing "Built 14:07 — after 'make the threshold a slider'" (title from the linked chat turn) with **Restore**, which copies back and rebuilds. Also snapshot on Delete so "Undo delete" exists. | 0 | M |
| I2 | **Make a failed install a state, not a loop.** Stop the unconditional retry; render FAILED with the real pip/npm line, **Ask Claude to fix it** (composes the error into the tool chat), **Retry**, and **Open anyway** (deps are often only needed at Run). Surface `userActionable` verbatim for Python/npm absence. | 0 to display; 1 turn when the user clicks Ask | S–M |
| I3 | **Fix image Download and add a binary export path.** Add a bridge call `saveFileCopy(relPath)` (save dialog + copy) used by `OutputFileList`; let `downloadFile` accept base64 for PNG/XLSX; restore a minimal Plotly modebar (camera only) in `ACABOX_CONFIG` or ship an `ExportChartButton` using `Plotly.toImage`. | 0 | S |
| I4 | **Element-targeted feedback.** Extend the selection shim to also report, on alt-click or a "Point" mode, the clicked element's visible text, role/tag, nearest `ab-label`/heading, and a cropped screenshot rect; the quote chip reads "Change this: 'Run analysis' button". Rides the user's next turn. | 0 extra | M |
| I5 | **`@reusable` additions:** `DataTable` (sort/filter/paginate/CSV), `ParamField`/`Slider`, `DropZone` (multi-file), `RunLog` + streaming `executeCode` chunks over the bridge, `EmptyState`, `HelpNote`/`AboutCard`, `ThemedChart` wrappers (scatter/bar/box/heatmap). Fewer hand-rolled components per build also means shorter `App.tsx` and faster builds. | 0 | M–L |
| I6 | **Simplify:** delete `differentialExpression` template, `MiniAppsTab.tsx`, the `preBuilt`/`nativeTools` path and PRE-BUILT/ON-DEMAND tags; rename "Download" → "Export tool…", move "Rebuild" and "View source" under More; replace "Waiting for container..." with "Starting Acabox's engine…". | 0 | S |
| I7 | **Rename / description / icon in the UI** (row Settings panel + header title click), writing through `updateManifest`. | 0 | S |
| I8 | **About this tool.** Have Step 5 also write `manifest.about` (3–5 sentences: what it does, inputs, outputs, how to run) in the same build turn, and show it as an "About" sheet from the header and as the tool's empty state. | 0 extra (same turn) | S |
| I9 | **Progress for long runs.** Stream kernel `stream` outputs as they arrive (bridge `executeCode` → chunk events) and render a collapsible `RunLog` under the Run button; show phase text from `print()` lines. | 0 | M |
| I10 | **Sharing for non-operators.** Bake the operator's Site/API URLs into the build (env at release time), issue **per-user publish tokens** on the api Worker (token → owner id; DELETE/PUT scoped to the owner's artifacts), make "Include input data" default off, and rewrite the Settings hint without a repo path. | 0 | M |
| I11 | **Optional auto-report of runtime errors.** A per-tool toggle "Tell Claude about errors automatically" that sends the first new error after each build. **Adds 1 turn per error** — a regression by the cost rule unless the user opts in; keep manual Fix as the default. | 1 per error (opt-in) | S |
| I12 | **Print / Save as PDF** from the header via `webContents.printToPDF` on the tool frame; and **Open in window** (`BrowserWindow` hosting the same `local-file://` page with the bridge relayed) for side-by-side use. | 0 | S (print) / L (window) |

---

## 6. Strengths worth keeping exactly as they are

- BEING WRITTEN vs BUILD FAILED distinction and the 2 s self-build
  (`miniAppBuildState.tsx`, `miniAppBuilder.ts:97-109`).
- Host-owned jobs → WORKING / RAN WHILE CLOSED / INTERRUPTED with a Stop
  button and honest Activity wording (`jobRegistry.ts`, `ActivityPanel.tsx`).
- Build-failure health persisted and surfaced on Home with "Ask Claude to fix
  it" (`buildHealth.ts`, `ActivityPanel.tsx:159-167`); agent-side in-turn
  retry on esbuild errors (`AgentInfrastructureController.ts:200-206`).
- Deterministic chat↔tool link and the per-tool chat switcher
  (`appChatLink.ts`, `ToolWorkspace.tsx:265-348`).
- Durable `tool-data` with "Saved data" after delete (`toolDataMigration.ts`,
  `ToolsPage.tsx:577-651`).
- `useAppState`/`useKernelAction`/`useRunsWhileClosed` giving every tool
  persistence, staleness, and recovery of runs that finished while closed.
- Design-system enforcement via the Tailwind reflex remap and
  `ab-*` classes (`manage_mini_app.mjs:89-166`).
- Share model: snapshot, versioned atomic publish, BEHIND detection, size
  table before upload, fail-closed Access.

---

## 7. Open questions for the owner

1. Is sharing meant to be operator-hosted for all users (then I10's per-user
   tokens matter) or per-user self-hosted (then the current setup path cannot
   serve the audience at all)?
2. Should "Include input data" default to off for this audience?
3. Is a code-tree snapshot per successful build (I1) acceptable disk-wise?
   Typical `src/` is tens of KB; excluding `dist/` and data keeps it small.
4. Should install failures ever block opening a tool, or should the tool open
   and the failure be shown as a chip + banner (as build failure is)?
5. Is removing the `differentialExpression` template and the `preBuilt` path
   acceptable now (simplify rule), given no R exists?
