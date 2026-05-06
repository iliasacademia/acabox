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

2. **Propose the insertion** with `mcp__ms-word__find_and_replace`:
   - `search_text`: the verbatim anchor text being replaced (placeholder, outline bullet, or selected passage).
   - `replacement_text`: the drafted prose.
   - `replace_scope`: `"first"`.
   - `match_case`: `true`.

3. **Compose the chat response** as commentary only — a brief note about scope, assumptions, and any `[PLACEHOLDER: ...]` markers in the draft. Do not restate the drafted prose.

### Fallback: no anchor exists

If there is no anchor (the user is asking for prose to be drafted in the chat for them to place themselves, or `find_and_replace` cannot be called), include the drafted prose as a `<blockquote source="assistant">` in the chat. Note in the chat that the draft was provided inline because no anchor was available to target a suggestion card.

<!-- skill-file: actions/draft.md @2026-05-05a -->
