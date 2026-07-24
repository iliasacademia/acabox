# ACABOX — Phase B design brief (Chat view · Tool viewer · Onboarding)

## Context

You previously designed the ACABOX Home screen ("Command Desk") — the chosen
direction from the ACABOX Dashboard explorations. That handoff
(`design_handoff_acabox_home`: README + reference HTML + self-hosted fonts) is
now fully implemented in the product: window chrome bar, left rail
(expandable, 236px/64px), Command Desk home, docked composer, and live status
bar. The design system from that handoff — tokens, DM Sans / IBM Plex Mono /
Material Symbols, flat border-only surfaces, "blue means clickable", mono
uppercase statuses — is our single source of truth and is already in code.

We are now extending the same direction to the three remaining screens that
involve real layout decisions. Everything else (chat list, files, settings,
activity feed) is being restyled mechanically from the existing system and
does NOT need design.

**Do not redesign:** the shell (chrome bar, rail, status bar), the docked
composer, or the Home screen. All three screens below render inside that
shell. One removal from the implemented design: no blinking-cursor motif
anywhere — it was cut as distracting.

## Frame

- Same window as before: 1280×880 design frame, 40px chrome bar on top,
  236px rail on the left, 26px status bar at the bottom.
- The content column is what you're designing: ~1044px wide.
- In Chat view the shell's docked composer (76px incl. padding) sits between
  content and status bar — it is a given, include it as-is in the mock.
- Reuse the exact tokens, fonts, radii, hover rules, and copy voice from the
  Home handoff. Statuses always mono uppercase. Blue only for interactive.

## Screen 1 — Chat view (highest priority)

The conversation screen — the most-used surface in the product. A user chats
with the agent to build tools and analyze their research files.

Must handle, each with a designed state:

- **User messages** — plain text, possibly multi-paragraph; may carry file
  attachments (show name + type).
- **Assistant messages** — rendered markdown: paragraphs, lists, headings,
  tables, inline code, fenced code blocks (with language), links. Often long.
- **Tool-call cards** — the agent runs tools mid-message (Bash commands,
  file reads/writes, "open mini application", package installs). Each call
  shows tool name + key arguments, and has three states: running (in
  progress), completed (collapsible result), error. Multiple calls can stack
  in one message. These should feel like instrument readouts — terse, mono,
  not chat bubbles.
- **Streaming** — the assistant message grows token by token; design the
  in-progress affordance (and how tool cards appear while streaming).
- **Thinking/working indicator** — agent is processing but no text yet.
- **Turn boundary** — a "stop generating" affordance exists while running
  (the composer's send button already becomes a stop button — given).
- **Empty state** — brand-new chat before the first message.
- **Header** — chat title (auto-generated), a back affordance to the chat
  list, and room for a per-chat action or two (e.g. rename/delete).
- **Long-conversation ergonomics** — scroll behavior, jump-to-latest.

Also design the **narrow variant**: the same thread renders as a side panel
(~35% width, min ~360px) next to an open tool. Same components, tighter
spacing — show how messages, code blocks, and tool cards degrade gracefully.

## Screen 2 — Tool viewer (mini-app workspace)

Where a built tool runs. The tool's own UI lives in an iframe we don't
control — design the chrome around it.

Must handle:

- **Tab bar** — multiple tools can be open as tabs (name + icon per tab,
  close affordance, active state). Tabs persist while switching nav sections.
- **Viewer header** — tool name, status, and actions: Back (to Tools page),
  Rebuild (re-bundles the tool's source), open-in-context affordances.
- **Dependency install state** — before first load a tool may install
  pip/npm packages: a wave of package rows each with pending → installing →
  done/failed states (this data exists live). Design the interstitial.
- **Build error state** — rebuild failed; show the error output (mono) with
  a retry action.
- **The iframe area** — plain white canvas, full-bleed within the chrome.
- **Chat side panel** — the tool's associated chat can be open alongside
  (the narrow thread variant from Screen 1): design the divider, the
  collapse/expand affordance, and the collapsed state.

## Screen 3 — Onboarding (first run)

Five sequential steps, full-window (rail is NOT shown yet; chrome bar is).
Voice matters most here — terse, playful-hacker, confident. Steps:

1. **Welcome** — what ACABOX is (local tool-building copilot for
   scientists), one primary action ("Get started").
2. **API key** — Anthropic API key entry: input, validation error state,
   short explanation of where to get a key and that it stays local.
3. **Workspace directories** — pick one or more research folders to share:
   chosen-directory list with per-directory read-only toggle, add/remove,
   primary action to continue, secondary skip.
4. **Scanning** — the agent scans shared folders to build a research
   profile: progress with live file names, skippable.
5. **Scan review** — summary of what was found (counts by type: manuscripts,
   grants, references, presentations), confirm to finish.

Design the shared step scaffold (progress indication across 5 steps, back
affordance where applicable) plus each step's content.

## Deliverables

Same format as the Home handoff, one folder per screen or one combined:

- `README.md` — kickoff prompt, token deltas if any (expect none), per-view
  specs with exact dimensions/type/spacing, § State shapes for anything
  dynamic, interaction & behavior notes.
- Reference HTML per screen (inert, `style-hover` attributes for hover
  states, same conventions as before) — including the key alternate states
  (streaming, tool-card running/error, dependency install, build error,
  each onboarding step).
- Reuse the existing four font files; no new assets unless essential.

Fidelity: high — colors, type, spacing, radii, copy final. We implement
pixel-perfect from the README, not from the HTML markup.
