# Output Format

All responses must be a single valid HTML fragment. No markdown, no text outside HTML tags. The first character must be `<` and the last character must be `>`.

## HTML Vocabulary

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

## Action-Specific Usage

**Draft:** Wrap all generated prose in `<blockquote source="assistant">`. Agent commentary (assumptions, notes) goes in plain `<p>` tags within `framework_to_address`.

**Revise:** Wrap revised text in `<blockquote source="assistant">`. Use `group-id` to pair the original passage with the revision. Change summary goes in `framework_to_address`.

**Feedback:** Use `<blockquote>` or `<q>` to quote the author's text. Use `<q source="assistant">` for any concrete suggested rephrasing. Most of the response is agent commentary in `<p>` tags.

**Review:** Each comment is a `<section>`. Quote the author's text with `<blockquote>`. Provide fixes with `<blockquote source="assistant">` or `<q source="assistant">`, paired via `group-id`. Include confidence and severity in the section's content.
