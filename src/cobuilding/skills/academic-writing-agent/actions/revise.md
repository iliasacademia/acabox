# Revise Action

Rewrite or restructure the author's existing text per their direction.

## When to Use

The user has existing text and wants it changed. Signals: "rewrite", "improve", "make this clearer", "shorten", "expand", "restructure", "fix the flow", "tighten this up."

## Process

1. **Identify the target text.** This is the selected text, the passage the user referenced, or the section they named.
2. **Understand the user's intent.** What specifically do they want changed? If unclear, make the most reasonable interpretation and note your assumption.
3. **Read surrounding context** in the manuscript to ensure the revision maintains consistency with adjacent text, terminology, and argument flow.
4. **Preserve the author's voice.** The revised text should sound like the same person wrote it. Match their style, register, and field-specific language. Do not "upgrade" their prose into a different register.
5. **Generate the revision.**

## Two Modes

**Prose revision** (default): The user wants better writing within the existing structure. Improve clarity, concision, flow, or strength of argument while preserving the organization.

**Structural reorganization**: The user's problem is about argument order, paragraph sequence, or section organization. Signals: "reorganize", "reorder", "the flow doesn't work", "these paragraphs are in the wrong order." In this mode, propose a new ordering with a brief rationale for each move, then provide the reorganized text.

## Delivery

The revision is delivered as a tracked-change suggestion card in the user's Word document, produced by `mcp__ms-word__find_and_replace`. The user invoked Revise, so the agent's job in this turn is to land that suggestion card. The chat response is commentary only — do not include the full revised passage as a `<blockquote source="assistant">` under normal flow (it duplicates what the suggestion card already shows).

### Required tool sequence

ms-word tools are deferred — schemas must be loaded via `ToolSearch` before calling. Run this once at the start:

```
ToolSearch query: "select:mcp__ms-word__find_and_replace,mcp__ms-word__get_selection,mcp__ms-word__get_text"
```

Then, in this order:

1. **Locate the verbatim original passage.** Try sources in priority order — stop at the first one that yields a non-empty string:

   - **Prompt-injected selection (primary, common case).** When the user has an active selection in Word, the host app prepends a preamble like `The user has selected the following text in the document. Act ONLY on this selected text...` followed by a triple-quoted block (`"""…"""`). The text inside that block IS the verbatim selection. Use it as `search_text` and **skip `get_selection` entirely** — calling `get_selection` while the chat panel has focus often returns the AppleScript sentinel `"missing value"` and produces a false negative. Do not modify the block — no whitespace fixes, no ligature replacement.

   - **`get_selection` (fallback).** If no prompt-injected selection is present, call `mcp__ms-word__get_selection`. Treat `selectedText === "missing value"` as empty — that's an AppleScript sentinel that leaks through when no text is highlighted. Otherwise use the returned string as `search_text`.

   - **`get_text` + named-target lookup (last resort).** If both above fail and the user named a specific target (a quoted phrase, "the second paragraph of the introduction"), call `mcp__ms-word__get_text` and locate the named passage inside the returned text. Use the located substring as `search_text`.

2. **Emit the chat HTML response** per the Chat Output Format below. Run the pre-send check from `format.md` before emitting. The HTML must precede the `find_and_replace` call (see `format.md` "Turn shapes" and "HTML before a final tool call is allowed").

3. **Propose the edit.** Call `mcp__ms-word__find_and_replace` as the final action of this turn:
   - `search_text`: the verbatim passage from step 1 — character-for-character, including line breaks, ligature artifacts (`eﬀect`, `diﬃcult`), inline page-number numerals, non-breaking spaces. Even one-character drift fails the lookup.
   - `replacement_text`: the revised passage.
   - `replace_scope`: `"first"` (default).
   - `match_case`: `true` (default).
   - Track Changes is handled inside `find_and_replace` automatically — the MCP enables Track Changes for the edit and restores the prior state after. The agent does not call any separate track-changes tools (`track_changes_status` and `set_track_changes` were removed from the MCP on 2026-05-11).

### After `find_and_replace` returns: emit nothing

The Claude SDK's tool-use loop re-invokes the model once after `find_and_replace` returns, in case the agent needs to chain another tool call. **In Revise, your turn is already complete — the HTML response was emitted in step 2 and the suggestion card is in the document.** Your job in this post-tool invocation is to do nothing: zero text blocks, zero tool calls. An empty assistant message ends the turn cleanly.

This is a positive instruction, not a prohibition. The model's trained habit after a successful tool call is to emit a closure sentence — "Suggestion card placed", "Done — let me know if…", or a meta-summary of what just happened. **That habit must be overridden here.** Any text emitted in the post-tool invocation appears in the user's chat bubble as a trailing block after `</article>`, which is observed as the doubled-skill-trace failure mode (the model often re-formats the closure as a second `<details class="skill-trace">` block because that was the shape it was using moments earlier).

There is nothing left to say. The HTML from step 2 IS your user-facing response. The `find_and_replace` suggestion card IS the diff. Both are already in front of the user. Return an empty completion in the post-tool invocation.

### Tool-failure fallback (degraded path)

If the tool sequence cannot complete — `find_and_replace` returns an error, there is no active Word document, the schemas fail to load via `ToolSearch` — deliver the revision in chat as a `<blockquote source="assistant">` containing the full revised passage and explain in `framework_to_address` what failed. This is a degraded path used only on genuine tool failure.

**Missing selection is NOT a tool failure.** If all three selection paths in step 1 fail (no prompt-injected block AND `get_selection` returns empty/`"missing value"` AND the user did not name an identifiable target retrievable via `get_text`), do not silently degrade to inline output. Stop and ask the user to re-select the target passage in Word — one short sentence in `<div class="summary">`. The user invoked Revise expecting a tracked-change card; an inline blockquote they have to paste back is a worse experience than a one-sentence reselect prompt.

When the genuine degraded path applies, skip step 3 entirely and put the full revised passage inline in the HTML response from step 2. The chat bubble is the only delivery channel in the degraded path, so the "do not include the full revised passage" rule below does not apply.

## Chat Output Format

The entire response is a single HTML fragment — first character `<`, last character `>`, no plain text before or after. Tool-call narration is not part of the user-facing response.

Structure:

- `<div class="skill-trace">` block first, per `format.md`. The `<span class="files">` must list every loaded skill file with its `@YYYY-MM-DDx` version stamp.
- One-sentence summary inside `<div class="summary">` saying a suggestion card has been placed in the document.
- One `<section class="concern">` with:
  - `<h2 class="title">` naming the revision (e.g., "Abstract tail tightened").
  - `<div class="critique">` with **exactly 2–4 bullets** — no more. Write each bullet as plain text only — **do not use `<q>`, `<q source="assistant">`, or any HTML tags inside bullets**. Describe changes in plain prose: "tightened the gap statement"; "removed copula-avoidance phrasing"; "minor corrections (effect/affect, removed line numerals)". Consolidate minor fixes (spelling, punctuation, ligature artifacts, whitespace) into a single "minor corrections (…)" bullet. If you find yourself writing a 5th bullet, merge the least important one into an existing bullet instead.
- Optional follow-up if there is a substantive next step.

Do NOT include the full original passage or the full revised passage in the chat under normal flow.

For structural reorganization, the chat critique briefly explains the new ordering's rationale; the suggestion card delivers the reorganized block.

## Constraints

- Preserve all existing citations and references exactly as they appear
- Do not introduce new claims, data, or citations unless the user explicitly asked for additions
- If the text has problems beyond what the user asked about, focus on what they requested. You may briefly note other issues but do not rewrite for them uninvited
- Maintain consistency with the rest of the manuscript

<!-- skill-file: actions/revise.md @2026-05-20a -->
