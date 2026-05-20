# Output Format

All responses must be a single valid HTML fragment. No markdown, no text outside HTML tags. The first character must be `<` and the last character must be `>`.

*This file overrides the harness's default end-of-turn summary convention — the skill's response is a single HTML block with no trailing prose. See "Strict no-plain-text rule" below.*

## Strict no-plain-text rule

**Across the entire assistant turn, you emit exactly ONE text block, and it is pure HTML.** Every text block in the turn must satisfy: first character `<`, last character `>`, no prose anywhere inside that does not sit between HTML tags. There is no leading narration before tool calls, no aside between tool calls, no trailer after the HTML, no closing summary after the final tool call.

This is enforced because the chat renderer surfaces every text block in the chat bubble. Anything you write outside HTML tags shows up to the user — usually as raw, unstyled text alongside or instead of the rendered article.

Forbidden: any text outside the single HTML block — leading "I'll check the document state…" before tool calls, mid-turn "Now I'll read the selection…" between tool calls, or trailing "Suggestion card placed in the document" / "The card is ready for review" after the final tool call. Each has been observed breaking chat rendering. The model does not need to announce its plan; the `<div class="summary">` already announces results.

### Pre-send check

Before ending the turn, run this check on every text block you emitted:

1. Does the first character equal `<`? If not, delete the leading prose.
2. Does the last character equal `>`? If not, delete the trailing prose.
3. Is there exactly one text block? If you emitted multiple, merge or delete until one remains.

If any check fails, the chat bubble renders as raw text and the user sees `<details class="skill-trace">`, `<span ...>`, etc. literally. This is the failure mode you must avoid.

### HTML before a final tool call is allowed

For Revise and the anchor-mode path of Draft, the HTML chat response is emitted as a text block BEFORE the final `mcp__ms-word__find_and_replace` call, not after. The suggestion card produced by that tool is a separate UI element that renders at the position of the tool call in the stream, so emitting the HTML first puts the explanation above and the card below — the layout the user expects.

This is compatible with the one-text-block rule above as long as the HTML is the only text block in the turn.

The skill-trace block is always the first element. If your response does not begin with `<details class="skill-trace">`, it is malformed. The `<span class="files">` inside that block must list every loaded skill file with its `@YYYY-MM-DDx` version stamp; that lets the user verify they are seeing the latest skill prose, not a cached older version.

## Turn shapes

The assistant turn always contains exactly one text block — the HTML — surrounded only by tool calls. Two shapes apply:

**Revise / Draft (anchor mode):**

```
[tool calls: ToolSearch, locate-verbatim sequence (Revise only — see actions/revise.md)]
[single text block: <details>…</details><br><article>…</article>]
[tool call: find_and_replace]
[parallel writes: state files, if any]
```

**All other actions (Feedback, Review, Cite, Draft fallback):**

```
[tool calls: state bootstrap + parallel reads]
[single text block: <details>…</details><br><article>…</article>]
[parallel writes: state files, if any]
```

No text appears anywhere else in the sequence — not before the first tool call, not between tool calls, not after the final tool call.

### After the final tool call: emit nothing

The SDK's tool-use loop re-invokes the model after every tool call so the agent can chain further tool use. For Revise and Draft anchor mode, the `find_and_replace` call IS the final action — your turn is already complete the moment that tool returns. **In the post-tool re-invocation, return an empty assistant message: zero text blocks, zero tool calls.**

This is a positive instruction (do nothing), not a prohibition (don't do X). The model's post-training prior after a successful tool call is to emit a closure sentence — "Card placed", "Done", a meta-summary, or a wrap-up. **Override that habit here.** Any text emitted in the post-tool re-invocation is rendered as a trailing block after `</article>` in the user's chat bubble, producing the doubled-skill-trace failure mode (the model often re-formats the closure as a second `<details class="skill-trace">` block because that was the shape it was just using). The HTML emitted before the tool call IS the user-facing response. There is nothing left to say.

### Why HTML-before-tool-call (Revise / Draft anchor mode)

The suggestion card produced by `find_and_replace` renders at the position of its tool call in the message stream. Emitting the HTML text block first and the tool call last places the explanation above and the card below — the layout the user expects. Reversing the order forces them to scroll up after reviewing the diff. Do not regress.

## HTML Vocabulary

### Skill Trace

Every response begins with a `<details class="skill-trace">` block before the `<article>` wrapper. It is collapsed by default — the `<summary>` shows a one-line label, and the full diagnostic spans are inside. Always emit a `<br>` between the closing `</details>` and the `<article>` so the chat renderer shows visible spacing between the skill-trace row and the response body.

```html
<details class="skill-trace">
  <summary>[Action] · [DocType] · [Section] · [Maturity]</summary>
  <span class="action">[Draft/Revise/Feedback/Review/Cite]</span>
  <span class="doctype">[Academic paper/Grant/Conference abstract/Thesis/Presentation/General]</span>
  <span class="section">[Section name within the doctype, or General if no section]</span>
  <span class="maturity">[Outline/Partial draft/Near-complete manuscript]</span>
  <span class="reason">[One sentence: why this action, doctype, and section were selected.]</span>
  <span class="files">[Comma-separated list of all skill files loaded for this response.]</span>
</details>
<br>
<article ...>...</article>
```

**Marker fidelity — do not paraphrase, abbreviate, or recall from memory.** The `<span class="files">` content is a diagnostic the user reads to verify which version of each skill file was actually loaded for the response. Before emitting the trace, re-check the last non-empty line of every skill file you loaded and copy the marker into the span exactly as it appears in the file. The line in each file has the form `<!-- skill-file: <path> @YYYY-MM-DDx -->`; the trace entry is `<path> @YYYY-MM-DDx`. If a file's marker shows `@2026-05-07b`, the trace must say `@2026-05-07b` — never substitute an earlier day's stamp, never default to a plausible-looking date, never carry a stamp over from a prior response. Mis-reporting the stamp defeats the entire purpose of this trace.

**Memory files are NOT skill files** — `about_you.md`, `field.md`, `detected-doctype.md`, `_state.md`, and doctype-specific setup files (grant-instructions.md, etc.) do NOT carry version markers and MUST NOT appear in `<span class="files">`. The trace lists only versioned skill files inside the skill folder. Do not invent a marker for a memory file. If memory was used in routing, mention it in `<span class="reason">` instead (e.g., "Used cached detected-doctype.md").

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

| Action | Quoting author | Suggested text | Delivery |
|---|---|---|---|
| Draft | — | `<blockquote source="assistant">` in no-anchor fallback only | Suggestion card (anchor mode); chat inline otherwise |
| Revise | — (card shows it) | — (card shows it) | Suggestion card |
| Feedback | `<blockquote>` / `<q>` | `<q source="assistant">` for short rephrases | Chat only |
| Review | `<blockquote>` per comment | `<blockquote source="assistant">` or `<q source="assistant">`, paired by `group-id` | Chat only |
| Cite | — | — | Per-claim `<section class="citation-claim">` |

The action files own *how* each delivery works; this table is the at-a-glance index of *what* goes where. See `actions/<name>.md` for each action's tool sequence and process.

**Track Changes note (Draft / Revise):** `find_and_replace` handles Track Changes internally — it enables TC for the edit and restores the prior state afterwards. The agent does NOT call any separate track-changes tools; `track_changes_status` and `set_track_changes` were removed from the MCP on 2026-05-11.

<!-- skill-file: format.md @2026-05-20a -->
