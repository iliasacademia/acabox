# Review Action

Systematically evaluate the author's text and produce structured, actionable comments.

> **Demo-mode slim version.** The full-fidelity version is preserved at `actions/review.full.md.bak`. To restore, see `CLAUDE.md` (Demo Mode section).

## When to Use

The user wants a deliberate evaluation. Signals: "review this section", "evaluate my paper", "give me a critique", "what's wrong with this", "is this ready to submit."

## Comment Limit

**Produce exactly 3 comments.** Pick the three most consequential issues and order them most-important first. Do not exceed three.

## Pre-Generation Filters

Before producing each comment, run these checks. Drop the comment if any fails.

1. **Steelman.** State briefly (in your reasoning) what the author intended and why they likely believed it works. The critique must survive that steelman.
2. **Self-resolution check.** If your reasoning contains "though", "however", or "but this may not be a problem because", you have answered your own question. Drop the comment.
3. **Concrete grounding.** If you cannot point to a specific passage, data point, or structural gap that supports the critique, phrase it as a question ("It is not clear how X follows from Y") rather than an assertion. Do not produce comments that could be copy-pasted to any paper in the field, or that suggest "additional analysis" without naming a specific problem.

## Partial-Draft Rule

If the document is a partial draft (e.g., only an Introduction is written), restrict critique sections to the prose that exists. **Do not produce a separate critique section flagging the absence of unwritten parts of the manuscript.** Mention the document's stage in the opening `<div class="summary">` line only, then move on. Critiques framed as "you should have an X section" are also disallowed when X is unwritten — comment on what is on the page, not on what is missing from the document overall.

## Output Format

For each of the 3 comments, provide:

- **Quote:** A verbatim substring of the author's text, copied character-for-character. Include 1–2 full sentences for context.
- **Issue:** A 5–10 word title naming the specific problem.
- **Feedback:** 2–4 sentences explaining what is wrong, why it matters, and a concrete fix.

End every comment with a concrete fix in one of these forms:
- "Rewrite [quoted text] as [corrected text] because [reason]"
- "Add [specific content] after [location] to address [gap]"
- "Remove [quoted text] because [reason]"

Do not end with vague suggestions like "the authors should clarify" or "consider discussing."

## Pairing Original With Suggestion

When a comment includes both the original passage and a suggested replacement, label them with explicit `<p>` lead-ins and always emit them in the order **original first, suggestion second**:

```html
<p>Original passage:</p>
<blockquote group-id="1">verbatim quote from manuscript</blockquote>
<p>Suggested replacement:</p>
<blockquote source="assistant" group-id="1">proposed rewrite</blockquote>
```

Never emit two adjacent `<blockquote>` elements without these `<p>` lead-ins — the user must be able to tell original from suggestion from the surrounding text alone, regardless of how the frontend styles the two quote types. If you only have a suggestion and no original to replace (e.g., a proposed addition), emit only the suggestion preceded by `<p>Suggested addition:</p>`.

## Quote Verification

Every quote must be a verbatim substring of the author's text. If you cannot find an exact passage, the comment is not grounded — drop it.

<!-- skill-file: actions/review.md @2026-05-07a -->
