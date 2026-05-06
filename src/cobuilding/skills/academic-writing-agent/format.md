# Output Format

All responses must be a single valid HTML fragment. No markdown, no text outside HTML tags. The first character must be `<` and the last character must be `>`.

## Strict no-plain-text rule

The first character of your final user-facing message is `<`. The last character is `>`. There is no plain-text lead-in, no plain-text aside between tool calls and the HTML, and no plain-text trailer.

Common failure mode to avoid: after running tool calls (e.g., `track_changes_status`, `find_and_replace`), the agent emits a conversational sentence like "Track Changes is off. Here's what I planned…" before the `<article>` wrapper. **That sentence belongs inside the HTML response, in the `<div class="summary">` or the relevant `<section>`.** Tool-call narration that appears next to a tool call (the short "I'll check the selection" type sentence the SDK shows alongside a tool invocation) is not part of the user-facing response and does not count against this rule. The final response — the one rendered in the chat bubble — is HTML only, every time.

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

**Draft:** When an anchor exists in the document (placeholder, outline bullet, user selection), deliver the prose via `mcp__ms-word__find_and_replace` after calling `mcp__ms-word__track_changes_status` to confirm Track Changes is on. The chat is commentary only — do NOT include the drafted prose as a `<blockquote source="assistant">`. If no anchor exists, fall back to including the prose in the chat with `<blockquote source="assistant">`. See `actions/draft.md`.

**Revise:** Deliver the revision via `mcp__ms-word__find_and_replace` (`search_text` = original passage verbatim, `replacement_text` = revision). Tool sequence: `track_changes_status` → if disabled, `set_track_changes(enabled=true)` → `get_selection` → `find_and_replace`. Do not bail when Track Changes is off — auto-enable it silently. The UI renders a suggestion card with the original and the proposed text plus approve/deny. The chat is commentary only — do NOT include the revised passage as a `<blockquote source="assistant">` (this produces visually identical adjacent blocks). See `actions/revise.md`.

**Feedback:** Use `<blockquote>` or `<q>` to quote the author's text. Use `<q source="assistant">` for any concrete suggested rephrasing. Most of the response is agent commentary in `<p>` tags.

**Review:** Each comment is a `<section>`. Quote the author's text with `<blockquote>`. Provide fixes with `<blockquote source="assistant">` or `<q source="assistant">`, paired via `group-id`. Include confidence and severity in the section's content.

**Cite:** Group results by claim using `<section class="citation-claim">`. Each reference within a claim uses `<div class="citation-result">` with `data-source` to indicate origin (author's library vs. CiteRight). Include CiteRight's `reasoning` field per reference. See Citation Results section above for the full template.

<!-- skill-file: format.md @2026-05-05e -->
