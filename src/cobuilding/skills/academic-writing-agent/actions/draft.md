# Draft Action

Generate new prose text for the author's manuscript.

## When to Use

The user wants new text created. Signals: "write", "draft", "generate a paragraph about", "fill in this section", or an empty/outline section needing prose.

## Process

1. **Read the full manuscript context** to understand scope, argument arc, terminology, and tone established in other sections.
2. **Read the user's instructions** for what this text should accomplish.
3. **Check the section conventions** for the target section.
4. **Infer the author's writing style** from existing prose in the manuscript. Match their sentence length, vocabulary, voice, hedging, and register. If a domain profile is available, use its vocabulary and framing conventions. Otherwise, infer from the manuscript.
5. **Generate paragraph prose.** Write in flowing paragraphs, not bullet points, unless the user explicitly requests otherwise. Write only the requested section/passage, not a full paper.

## Source Constraint

Follow the base-layer source constraints (Tier 1/2/3). When drafting text that requires claims about prior work or the state of the field, route those claims through Cite for verification before including them. Mark any content sourced from outside the author's materials so the user knows its origin.

## Output Format

Prose paragraph(s), ready to insert into the manuscript. No meta-commentary or explanation unless the user asked a question. If you made assumptions about scope or framing, note them briefly after the generated text.

## Section-Specific Adjustments

- **Outline to prose:** Use the bullet structure as a scaffold. Follow the argument sequence the author planned. Produce real paragraph prose, not expanded bullets.
- **Abstract:** Pull from completed manuscript sections. Compress, don't promise. Follow the background-gap-approach-results-conclusion structure.
- **Methods:** Write dry, protocol-like text in past tense. Insert [PLACEHOLDER: ...] for missing technical details rather than inventing them.
- **Introduction:** Build the broad-to-narrow funnel. End with the roadmap paragraph starting "In this [paper/study], ..."

## Delivery: use the suggestion card when an anchor exists

If the drafted prose replaces an existing anchor in the document — a placeholder like `[INTRO TBD]`, an outline bullet, the user's selection, or any specific passage to be replaced — deliver the draft through the Word suggestion card produced by `mcp__ms-word__find_and_replace`. The UI shows the existing anchor and the proposed prose with approve/deny buttons; on approve, the insertion lands as a tracked revision. In this mode, do NOT include the drafted prose as a `<blockquote source="assistant">` in the chat — the chat is commentary only.

### Required tool sequence (anchor mode)

ms-word tools are deferred — schemas must be loaded via `ToolSearch`:

```
ToolSearch query: "select:mcp__ms-word__track_changes_status,mcp__ms-word__find_and_replace,mcp__ms-word__get_selection"
```

Then:

1. **Verify Track Changes is enabled** with `mcp__ms-word__track_changes_status`. If disabled, stop and ask the user to enable it (Review tab → Track Changes) before retrying. Do not silently enable it.

2. **Emit the chat HTML response** as commentary only — a brief note about scope, assumptions, and any `[PLACEHOLDER: ...]` markers in the draft. Do not restate the drafted prose. This is the **only** text block in the assistant turn, and it must precede the `find_and_replace` call so the suggestion card renders below the chat bubble.

   The text block must be **pure HTML end-to-end**: first character `<`, last character `>`, no prose outside HTML tags anywhere in the block. Run the pre-send check from `format.md`:
   - First character is `<`? (no leading "Here's the draft" prose, no "I'll check the document state" pre-tool narration)
   - Last character is `>`? (no trailing "Draft placed in the document", "Ready for review", or any meta-narration)
   - Only one text block in the turn? (no separate narration block before the first tool call or after `find_and_replace`)

   If you fail any of these, the chat bubble renders as raw text and the user sees every HTML tag literally. Anything you would have said outside the HTML belongs inside `<div class="summary">`.

3. **Propose the insertion** with `mcp__ms-word__find_and_replace` as the final action of this turn:
   - `search_text`: the verbatim anchor text being replaced (placeholder, outline bullet, or selected passage).
   - `replacement_text`: the drafted prose.
   - `replace_scope`: `"first"`.
   - `match_case`: `true`.

### Why HTML-before-tool-call

The card renders at the position of its tool call in the message stream. Putting the HTML text block first and `find_and_replace` last means the user reads the framing, then sees the diff card directly underneath. Reversing the order forces them to scroll up after reviewing the diff. Do not regress to the old ordering.

### No narration text blocks anywhere in the turn

The intended turn shape (anchor mode):

```
[ToolSearch]
[track_changes_status]
[text block: <details>...</details><br><article>...</article>]
[find_and_replace]
```

No text blocks before, between, or after the tool calls — only the HTML text block in the middle. Do not announce your plan ("I'll check the document state before drafting"); do not announce the result ("Draft placed in the document for review"). Both have been observed breaking chat rendering.

### Fallback: no anchor exists

If there is no anchor (the user is asking for prose to be drafted in the chat for them to place themselves, or `find_and_replace` cannot be called), include the drafted prose as a `<blockquote source="assistant">` in the chat. Note in the chat that the draft was provided inline because no anchor was available to target a suggestion card.

<!-- skill-file: actions/draft.md @2026-05-06c -->
