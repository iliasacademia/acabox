# Handoff: ACABOX — Home ("Command Desk")

## Kickoff prompt for Claude Code

Paste this into Claude Code from your repo root (adjust the folder path to wherever you unzip this):

> Read `design_handoff_acabox_home/README.md` fully, then open `design_handoff_acabox_home/acabox-home.html` in a browser to see the reference design (click the « chevron to see the rail collapse). Implement this Home screen in this codebase using its existing framework and conventions — if the project is empty, propose a stack first (e.g. Electron/Tauri + React) and wait for my OK. Recreate the design pixel-perfectly from the README's specs: use the design tokens exactly, self-host the fonts, and implement the rail expand/collapse, hover states, and the bottom composer. Statuses and lists should render from typed mock data (shapes in README § State) so real backends can be wired in later. Don't copy the HTML file's markup directly — it's a reference, not production code.

## Overview

ACABOX is a local desktop "VM" that hosts self-built vibecoding tools. The Home screen ("Command Desk") is where the user lands: running tools shown as instrument cards, recent chats, connected drive files, and a chat composer docked at the bottom — the primary way to start anything ("describe a tool, paste a repo, or ask").

## About the design files

`acabox-home.html` is a **design reference created in HTML** — a prototype showing intended look and behavior, not production code. The task is to **recreate this design in the target codebase's environment** (React, Vue, Electron, Tauri, etc.) using its established patterns. If no environment exists yet, choose the most appropriate framework and implement there.

Note: `style-hover="…"` attributes in the HTML encode each element's hover state (they're inert in the raw file; treat them as specs).

## Fidelity

**High-fidelity.** Colors, typography, spacing, radii, and copy are final. Recreate pixel-perfectly.

## Design tokens

Derived from the Academia.edu design system.

Colors
- Ink (text primary): `#141413`
- Text secondary: `#535366` · placeholder/inactive: `#91919e` · disabled stroke: `#c7c7cf`
- Border default: `#dddde2` · border soft (row dividers): `#ebebee`
- Primary blue (interactive ONLY — links, buttons, active nav, focus): `#0645b1`; hover `#0c3b8d`; pressed `#082f75`
- Pale blue (selected/hover fills, quiet panels): `#f4f7fc`
- Error: text/icon `#b60000`, background `#fff2f2`
- Success (status dots only, always with a text label): `#05b01c`
- Busy/attention (status dots): `#fecf4c`
- Idle/sleeping dot: `#c7c7cf`
- Window-chrome dots: `#e2e0d9`

Rule: blue means *clickable*. Never color a metric, status, or heading blue.

Typography (self-hosted woff2 in `fonts/`)
- **DM Sans** — all UI text. Weights: 400 body, 500 buttons/labels, 600 item titles (14/20), 700 headings (page title 20/24)
- **IBM Plex Mono** — statuses, timestamps, IDs, file names, metrics, section labels. 400/500 only, UPPERCASE for labels, letter-spacing 0.04–0.08em. Sizes 9–15px. Never prose.
- **Material Symbols Outlined** — sole icon system, rendered via ligature names (e.g. `<span class="material-symbols-outlined">rocket_launch</span>`)
- Never substitute Roboto/system fonts.

Radii: 4px inputs/search · 8px cards, icon-buttons, XS buttons, composer · 16px primary buttons · 50% dots
Borders 1px everywhere; no drop shadows on cards (flat, border-only).
Spacing: 4/8/12/16/24/32 scale; main content padding 24px 32px.

## Screens / Views

One screen: **Home / Command Desk**, designed at 1280×880 inside its own window chrome.

### Window chrome (40px)
White, bottom border `#dddde2`. Left: three 11px `#e2e0d9` dots (gap 7). Center: mono 11px `#535366` "ACABOX — LOCAL VM · V0.4.2". Right: 6px green dot + mono "HEALTHY".

### Left rail — two states, toggleable
**Expanded (default, 236px):** padding 14px 12px, right border.
- Header row: 28px blue (#0645b1) rounded-6 square with white `play_arrow` icon; mono 500 13px "ACABOX" (letter-spacing 0.1em); spacer; 28px icon-button `keyboard_double_arrow_left` (collapse).
- Nav (rows 34px, radius 8, 14px text, 18px icons `#535366`): Home (active: bg `#f4f7fc`, text+icon `#0645b1`, weight 500), Chats (right-aligned mono count "23"), Tools ("7"), Files, Activity. Hover: bg `#f4f7fc`.
- "RECENTS" section label (mono 500 10px, ls 0.08em, `#91919e`), then 5 chat rows (30px, 13px, `chat_bubble` 16px `#91919e`, single-line ellipsis) + "More" row (blue, `more_horiz`).
- "PINNED TOOLS" label + 3 rows with trailing 6px status dot (green/green/yellow).
- Spacer; footer above 1px `#ebebee` divider: row `hard_drive` + mono 12px "~/acabox" + mono 9px "SYNCED"; row `settings` "Settings".

**Collapsed (64px):** centered column, gap 10: logo square; expand icon-button (`keyboard_double_arrow_right`); 40×40 icon buttons Home (active pale-blue/blue) / `forum` / `grid_view` / `folder_open` / `monitoring`; spacer; `settings`. Tooltips = nav names.

Toggle animates nothing fancy — instant or ≤150ms width transition, ease-out. Persist state.

### Header (56px, border-bottom)
"Command desk" DM Sans 700 20/24 + mono 11px `#91919e` "WED JUL 23 · 09:41" (live date). Right: search field 280×36, radius 4, border `#dddde2`: `search` icon, placeholder "Search chats, tools, files…", trailing ⌘K keycap (mono 10px, 1px `#ebebee` border, radius 4). Opens a command palette; also bound to ⌘K.

### Content (scrollable, padding 24 32)
**INSTRUMENTS grid** — section row: mono label "INSTRUMENTS — 4 OF 7" + blue text-link "All tools". 3-column grid, gap 14. Card: white, 1px `#dddde2`, radius 8, padding 16, column gap 9; header row = 24px blue tool icon vs right status chip (6px dot + mono 10px uppercase); title 15px/600; description 13px/18 `#535366`; footer row = XS button + mono 10px metric.
- GitHub Runner `rocket_launch` · RUNNING (green) · "Two apps live on :4031 and :4033." · [Open] · UP 6D 04H
- MCP Runner `extension` · RUNNING · "Five servers up. Zotero wants a restart." · [Open] · 5 SERVERS
- LLM Evals `science` · BUSY (yellow) · "Citation extraction — 4 models × 240 prompts." · progress bar (4px track `#ebebee`, fill `#141413`, 38%) + "3/8 · ETA 41M"
- Notes Collector `edit_note` · SLEEPING (gray) · "Today's digest is ready — 3 things worth reading." · [Open digest] · NEXT 06:00
- PDF → BibTeX — crashed variant: bg `#fff2f2`, icon `error` `#b60000`, chip "CRASHED 2H" in `#b60000` · "Exit 137 — out of memory on a 900-page scan." · [Revive] + blue link "Read the logs"
- New-tool card: 1px **dashed** `#dddde2`, centered, blue `add` icon + "Build a new tool" 14/500 + "Describe it below — ACABOX scaffolds it" 12px `#91919e`. Click focuses the composer.

**Lower two-column grid** (1.2fr / 0.8fr, gap 24):
- "JUMP BACK IN" + "All chats · 23": bordered list card; rows 42px (`chat_bubble`, title 14/600 ellipsis, right mono time "12M/1H/1D"), dividers `#ebebee`, hover `#f4f7fc`.
- "DRIVE — ~/ACABOX" + "Browse": rows 42px: file-type icon (`database`/`data_object`/`description`), mono 12px filename, right mono size ("1.1G/2M/14K").

### Composer (docked bottom, above status bar)
Container: border-top `#dddde2`, padding 12 24, white. Field: min-height 52, radius 8, border `#dddde2` (focus: `#0645b1`), padding-left 16: blue mono "▸" glyph · placeholder 15px `#91919e` "What are we building? — describe a tool, paste a repo, or ask" · `attach_file` icon-button 30×30 · model picker chip (mono 11px "AUTO" + `expand_more`, hover `#f4f7fc`) · send button 36×36 radius 8 bg `#0645b1`, white `arrow_upward`, hover `#0c3b8d`. Enter submits; ⇧Enter newline; field grows to ~5 lines.

### Status bar (26px, bottom edge)
Border-top `#ebebee`, mono 10px `#91919e`, gap 20: "CPU 12%" "MEM 3.1/8.0G" "DISK 34.2/80G" "MODELS 3 WARM" — spacer — "SNAPSHOT 04:12 ✓". Live values.

## Interactions & behavior

- Rail toggle (chevron); collapsed icons show tooltips.
- Hovers (≈150ms, linear→ease-out, color/bg only — no transforms): list rows & nav → bg `#f4f7fc`; XS buttons → inverted (bg `#141413`, white text); primary/send → `#0c3b8d`; text links underline + darken.
- Tool card click → opens the tool's app view; [Open]/[Revive]/[Open digest] act without opening the card.
- Composer submit → creates a new chat and navigates to it. Model picker: dropdown of local + API models, "AUTO" default.
- ⌘K → command palette (search chats/tools/files).
- Blinking-cursor motif: 8×15px `#0645b1` block next to the ACABOX wordmark, `@keyframes cursorblink{50%{opacity:0}}`, 1.2s steps(1) infinite.
- Copy voice: terse, playful-hacker, sentence case ("Boot", "Revive", "Break things freely"). Statuses ALWAYS mono uppercase.

## State management

- `railOpen: boolean` (persisted)
- `tools: {id, name, icon, status: 'running'|'busy'|'sleeping'|'crashed', description, metric, progress?, port?}[]`
- `chats: {id, title, lastActiveAt, toolId?, model}[]`
- `driveFiles: {name, size, kind}[]` + drive sync status
- `vmStats: {cpu, mem, disk, modelsWarm, lastSnapshot}` (poll/subscribe)
- `composer: {text, model: 'auto'|string, attachments[]}`

## Assets

- Fonts in `fonts/`: DM Sans (variable), IBM Plex Mono 400+500, Material Symbols Outlined (icon ligature font). Self-host; no Google Fonts CDN.
- No images. Icons are all Material Symbols ligatures named in the HTML.

## Files

- `acabox-home.html` — the reference screen (open in a browser; rail toggle works).
- `fonts/*.woff2` — the four font files.
- Alternate explored directions (dark rail, terminal timeline, launcher, editorial) live in the design project's `ACABOX Dashboard.dc.html`; this handoff covers the chosen direction only.
