# Output Format

All responses must be a single valid HTML fragment. No markdown, no text outside HTML tags. The first character must be `<` and the last character must be `>`.

## Strict no-plain-text rule

**Across the entire assistant turn, you emit exactly ONE text block, and it is pure HTML.** Every text block in the turn must satisfy: first character `<`, last character `>`, no prose anywhere inside that does not sit between HTML tags. There is no leading narration before tool calls, no aside between tool calls, no trailer after the HTML, no closing summary after the final tool call.

This is enforced because the chat renderer surfaces every text block in the chat bubble. Anything you write outside HTML tags shows up to the user — usually as raw, unstyled text alongside or instead of the rendered article.

Forbidden text blocks (all real failures observed):

- **Leading pre-tool narration:** "I'll load the ms-word tool schemas and check the document state before proposing the revision." — this used to be tolerated as "tool-call narration"; it is no longer. Just call the tools. The model does not need to announce its plan.
- **Mid-turn narration between tool batches:** "Now I'll read the selection and propose the edit." — same problem. Call the tool, do not narrate.
- **Trailing summary after `</article>`:** "Suggestion card placed in the document; ready for accept/reject", "The single-step revise action doesn't warrant a todo list, so I'll skip it", "The card is in Word for review", any sentence describing what just happened or what you did or did not do. None of these. The `<div class="summary">` already announces the card; restating it outside the article both duplicates information AND breaks rendering.

### Pre-send check

Before ending the turn, run this check on every text block you emitted:

1. Does the first character equal `<`? If not, delete the leading prose.
2. Does the last character equal `>`? If not, delete the trailing prose.
3. Is there exactly one text block? If you emitted multiple, merge or delete until one remains.

If any check fails, the chat bubble renders as raw text and the user sees `<details class="skill-trace">`, `<span ...>`, etc. literally. This is the failure mode you must avoid.

### HTML before a final tool call is allowed

For Revise and the anchor-mode path of Draft, the HTML chat response is emitted as a text block BEFORE the final `mcp__ms-word__find_and_replace` call, not after. The suggestion card produced by that tool is a separate UI element that renders at the position of the tool call in the stream, so emitting the HTML first puts the explanation above and the card below — the layout the user expects.

This is compatible with the one-text-block rule above as long as the HTML is the only text block in the turn. The intended assistant turn shape is:

```
[tool calls: ToolSearch, track_changes_status, set_track_changes (if needed), get_selection]
[text block: <details class="skill-trace">...</details><br><article>...</article>]
[tool call: find_and_replace]
```

No text appears anywhere else in that sequence — not before the first tool call, not between tool calls, not after the final tool call. The HTML text block is the only text the user sees in the chat bubble.

The skill-trace block is always the first element. If your response does not begin with `<details class="skill-trace">`, it is malformed. The `<span class="files">` inside that block must list every loaded skill file with its `@YYYY-MM-DDx` version stamp; that lets the user verify they are seeing the latest skill prose, not a cached older version.

## HTML Vocabulary

### Skill Trace

Every response begins with a `<details class="skill-trace">` block before the `<article>` wrapper. It is collapsed by default — the `<summary>` shows a one-line label, and the full diagnostic spans are inside. Always emit a `<br>` between the closing `</details>` and the `<article>` so the chat renderer shows visible spacing between the skill-trace row and the response body.

```html
<details class="skill-trace">
  <summary>[Action] · [Section] · [Maturity]</summary>
  <span class="action">[Draft/Revise/Feedback/Review/Cite]</span>
  <span class="section">[Results/Methods/Discussion/Introduction/Abstract/Outline/General]</span>
  <span class="maturity">[Outline/Partial draft/Near-complete manuscript]</span>
  <span class="reason">[One sentence: why this action and section were selected.]</span>
  <span class="files">[Comma-separated list of all skill files loaded for this response.]</span>
</details>
<br>
<article ...>...</article>
```

Populate the `files` span by collecting the `<!-- skill-file: ... -->` markers found at the bottom of each loaded skill file.

This block is for routing diagnostics. The frontend styles it via the `.skill-trace` CSS class.

### Wrapper

Every response uses this container:

```html
<article id="manuscript-feedback" data-items="[NUMBER_OF_SECTIONS]">
  ...
</article>
```

### Summary

One sentence acknowledging the manuscript and its stage. Always first inside the article.

```html
<div class="summary">
  <p>[One sentence.]</p>
</div>
```

### Content Sections

Each piece of feedback, drafted text, or revision is a section:

```html
<section class="concern" data-major="[true/false]">
  <h2 class="title">[Content-derived title]</h2>
  <div class="critique">
    [Main content here]
  </div>
  <div class="framework_to_address">
    <h3>My suggestion</h3>
    <p>[Actionable guidance or commentary]</p>
  </div>
</section>
```

Set `data-major="true"` only for genuinely significant issues. Order sections by importance.

### Follow-Up

Optional closing block with additional observations and a forward-moving question:

```html
<div class="follow-up">
  <h3>Additional thoughts</h3>
  <p>[Preview of other observations, then a specific question.]</p>
</div>
```

## Quoting and Suggested Text

These tags distinguish between the author's original text and text the agent proposes.

### Author's text (quoting the manuscript)

Use `<blockquote>` for multi-sentence quotes or `<q>` for short inline quotes:

```html
<blockquote>Author's original passage here.</blockquote>
<q>short phrase</q>
```

### Agent-proposed text (insertable by the user)

Use `source="assistant"` to mark text the user can insert, adapt, or use as a replacement:

```html
<blockquote source="assistant">Proposed paragraph or passage.</blockquote>
<q source="assistant">proposed short phrase</q>
```

The frontend renders `source="assistant"` text differently (distinct background, insert/copy action) so the user knows this is suggested text, not commentary.

### Pairing originals with suggestions

When an author quote and a suggested replacement are related, add a matching `group-id` to both so the frontend can pair them:

```html
<q group-id="1">original phrase from manuscript</q>
...
<q source="assistant" group-id="1">suggested replacement</q>
```

## Citation Results

Used by the Cite action. Results are grouped by claim, with each claim's verified references listed underneath. The overall response still uses the standard `<article>` wrapper.

### Per-claim group

```html
<section class="citation-claim">
  <h2 class="claim-text">[The claim that needs citation support]</h2>
  <div class="citation-results">

    <div class="citation-result" data-source="[citeright/author-library]">
      <h3 class="title">[Paper title]</h3>
      <div class="citation-meta">
        <span class="authors">[First Author & Last Author et al.]</span>
        <span class="year">[2023]</span>
        <span class="journal">[Journal Name]</span>
        <a class="doi" href="[DOI or URL]">[DOI]</a>
      </div>
      <div class="reasoning">
        <p>[CiteRight's reasoning for why this paper matches the claim.]</p>
      </div>
    </div>

    <!-- additional results for same claim -->

  </div>
</section>
```

Notes:
- `data-source="author-library"` for references found in the user's Zotero or uploaded materials; `data-source="citeright"` for references found via CiteRight search. Frontend uses this for visual distinction.
- The `reasoning` field comes directly from CiteRight's `top_publications` response. Present it as-is.
- The DOI `href` should link to the paper's URL or DOI resolver (`https://doi.org/[DOI]`).
- Include all metadata fields CiteRight returns (authors, year, journal, DOI). Omit fields that are absent rather than leaving them empty.
- When presenting a long-input polling result, label partial results with "Results so far" until `report.done` is `true`.
- Order claims by their position in the manuscript. Order references within each claim by CiteRight's ranking.

## Action-Specific Usage

**Draft:** When an anchor exists in the document (placeholder, outline bullet, user selection), deliver the prose via `mcp__ms-word__find_and_replace` after calling `mcp__ms-word__track_changes_status` to confirm Track Changes is on. Tool sequence: `track_changes_status` → emit chat HTML response → `find_and_replace`. The chat is commentary only — do NOT include the drafted prose as a `<blockquote source="assistant">`. If no anchor exists, fall back to including the prose in the chat with `<blockquote source="assistant">`. See `actions/draft.md`.

**Revise:** Deliver the revision via `mcp__ms-word__find_and_replace` (`search_text` = original passage verbatim, `replacement_text` = revision). Tool sequence: `track_changes_status` → if disabled, `set_track_changes(enabled=true)` → `get_selection` → emit chat HTML response → `find_and_replace`. Emitting the HTML before the `find_and_replace` call is required so the suggestion card renders below the chat bubble; do not call `find_and_replace` before the HTML. Do not bail when Track Changes is off — auto-enable it silently. The UI renders a suggestion card with the original and the proposed text plus approve/deny. The chat is commentary only — do NOT include the revised passage as a `<blockquote source="assistant">` (this produces visually identical adjacent blocks). See `actions/revise.md`.

**Feedback:** Use `<blockquote>` or `<q>` to quote the author's text. Use `<q source="assistant">` for any concrete suggested rephrasing. Most of the response is agent commentary in `<p>` tags.

**Review:** Each comment is a `<section>`. Quote the author's text with `<blockquote>`. Provide fixes with `<blockquote source="assistant">` or `<q source="assistant">`, paired via `group-id`. Include confidence and severity in the section's content.

**Cite:** Group results by claim using `<section class="citation-claim">`. Each reference within a claim uses `<div class="citation-result">` with `data-source` to indicate origin (author's library vs. CiteRight). Include CiteRight's `reasoning` field per reference. See Citation Results section above for the full template.

<!-- skill-file: format.md @2026-05-06c -->
