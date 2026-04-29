# Output Format

All responses must be a single valid HTML fragment. No markdown, no text outside HTML tags. The first character must be `<` and the last character must be `>`.

## HTML Vocabulary

### Skill Trace

Every response begins with a `<skill-trace>` block before the `<article>` wrapper. This records which action, section, and document maturity the router detected.

```html
<skill-trace>
  <action>[Draft/Revise/Feedback/Review/Cite]</action>
  <section>[Results/Methods/Discussion/Introduction/Abstract/Outline/General]</section>
  <maturity>[Outline/Partial draft/Proposal/Near-complete manuscript]</maturity>
  <reason>[One sentence: why this action and section were selected.]</reason>
  <files>[Comma-separated list of all skill files loaded for this response.]</files>
</skill-trace>
```

Populate `<files>` by collecting the `<!-- skill-file: ... -->` markers found at the bottom of each loaded skill file.

This block is for routing diagnostics and should be hidden by the frontend in production.

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

**Draft:** Wrap all generated prose in `<blockquote source="assistant">`. Agent commentary (assumptions, notes) goes in plain `<p>` tags within `framework_to_address`.

**Revise:** Wrap revised text in `<blockquote source="assistant">`. Use `group-id` to pair the original passage with the revision. Change summary goes in `framework_to_address`.

**Feedback:** Use `<blockquote>` or `<q>` to quote the author's text. Use `<q source="assistant">` for any concrete suggested rephrasing. Most of the response is agent commentary in `<p>` tags.

**Review:** Each comment is a `<section>`. Quote the author's text with `<blockquote>`. Provide fixes with `<blockquote source="assistant">` or `<q source="assistant">`, paired via `group-id`. Include confidence and severity in the section's content.

**Cite:** Group results by claim using `<section class="citation-claim">`. Each reference within a claim uses `<div class="citation-result">` with `data-source` to indicate origin (author's library vs. CiteRight). Include CiteRight's `reasoning` field per reference. See Citation Results section above for the full template.

<!-- skill-file: format.md -->
