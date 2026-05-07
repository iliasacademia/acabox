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
ToolSearch query: "select:mcp__ms-word__track_changes_status,mcp__ms-word__set_track_changes,mcp__ms-word__find_and_replace,mcp__ms-word__get_selection"
```

Then, in this order:

1. **Check Track Changes state.** Call `mcp__ms-word__track_changes_status`. The result has `enabled: true` or `enabled: false`.

2. **Enable Track Changes if it was off.** If `enabled: false`, call `mcp__ms-word__set_track_changes` with `{ enabled: true }`. This is part of the Revise workflow — the user invoked Revise, signalling intent to insert a suggestion. Track Changes must be on for the suggestion card to land as a tracked revision they can accept or reject.

3. **Read the selection.** Call `mcp__ms-word__get_selection` to capture the verbatim original passage.

4. **Emit the chat HTML response** per the Chat Output Format below. This is the **only** text block in the assistant turn — it must precede the `find_and_replace` call so the suggestion card renders BELOW the chat bubble in the visual stream. The user reads your one-sentence summary and bullet rationale first, then sees the diff card directly underneath.

   The text block must be **pure HTML end-to-end**: first character `<`, last character `>`, no prose outside HTML tags anywhere in the block. Before sending it, run the pre-send check from `format.md`:
   - First character is `<`? (no leading "Here's the revision" prose)
   - Last character is `>`? (no trailing "Suggestion card placed in the document", "Ready for accept/reject", "I'll skip the todo list", or any other meta-narration)
   - This is the only text block in the turn? (no separate narration block before tool calls or after `find_and_replace`)

   If you fail any of these, the chat bubble renders as raw text and the user sees `<details>`, `<span>`, `<article>`, etc. literally. Anything you'd want to say outside the HTML belongs inside `<div class="summary">`.

5. **Propose the edit.** Call `mcp__ms-word__find_and_replace` as the final action of this turn:
   - `search_text`: the verbatim selection — character-for-character, including line breaks, ligature artifacts (`eﬀect`, `diﬃcult`), inline page-number numerals, non-breaking spaces. Even one-character drift fails the lookup.
   - `replacement_text`: the revised passage.
   - `replace_scope`: `"first"` (default).
   - `match_case`: `true` (default).

### Why HTML-before-tool-call

The card is rendered at the position of its tool call in the message stream. If `find_and_replace` runs before the HTML, the card appears above the explanatory text and the user has to scroll up to read what changed after reviewing the diff. Emitting the HTML as a text block first and the tool call last reverses that order: explanation, then diff. This is the intended layout — do not regress to the old ordering for "convenience".

### No narration text blocks anywhere in the turn

The intended turn shape is:

```
[ToolSearch]
[track_changes_status]
[set_track_changes if needed]
[get_selection]
[text block: <details>...</details><br><article>...</article>]
[find_and_replace]
```

No text blocks appear before, between, or after the tool calls — only the single HTML text block in the middle. Specifically:

- **Do not** emit a leading sentence like "I'll load the ms-word tool schemas and check the document state before proposing the revision" before the first tool call. The model does not need to announce its plan; just call the tools.
- **Do not** emit a closing sentence like "The card is in the document for accept/reject" or "The single-step revise action doesn't warrant a todo list" after `find_and_replace`. Anything you would have said belongs inside the HTML's `<div class="summary">`.

### Tool-failure fallback (degraded path)

If the tool sequence cannot complete for reasons other than Track Changes being off — `find_and_replace` returns an error, there is no active Word document, the schemas fail to load via `ToolSearch`, the selection comes back empty — deliver the revision in chat as a `<blockquote source="assistant">` containing the full revised passage and explain in `framework_to_address` what failed. This is a degraded path used only on genuine tool failure. Track Changes being off is **not** a tool failure; step 2 handles that.

When you discover the failure mid-sequence (e.g., empty selection at step 3), skip step 5 entirely and put the full revised passage inline in the HTML response from step 4. The chat bubble is the only delivery channel in the degraded path, so the "do not include the full revised passage" rule below does not apply.

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

<!-- skill-file: actions/revise.md @2026-05-06c -->
