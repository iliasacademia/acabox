# DocType: Conference Abstract

A standalone abstract submitted to a conference, workshop, or proceedings venue. Unlike a paper's abstract, this is the full document. It is short (typically 250–500 words), often word-limit-policed, and frequently structured by required sub-headings prescribed by the conference (Background, Methods, Results, Conclusion).

The agent treats conference abstracts as their own doctype rather than reusing the paper's `abstract.md` because the constraints and expectations are different: there is no parent manuscript to compress from, the word limit is a hard cap, and the abstract is what reviewers score.

## Detection Signals

Conference-abstract requires at least one **strong exclusive signal**. Filename hint, length, and "looks like an abstract" structure are supporting signals only — they raise confidence when combined with a strong signal but do not trigger detection on their own. This is calibrated so that a paper draft saved as `abstract.docx` does not get mis-routed when its content shows full IMRaD structure.

**Strong exclusive signals — one is sufficient:**

- **Word-limit reference in the document:** "250 words", "500 word limit", "abstract limit", or similar instructions embedded in the doc.
- **User mention of a specific conference:** "the abstract for ASCB", "my conference submission for SfN", "my poster abstract for NeurIPS".
- **Short doc (≤500 words) WITH prescribed sub-headings:** Background/Methods/Results/Conclusion appearing as sub-headers inside what is clearly the abstract section.

**Supporting signals (raise confidence; not standalone triggers):**

- **Filename hints:** the file name contains `abstract`, `submission`, `conference`, or a conference acronym (`ASCB`, `SfN`, `AAAI`, `NeurIPS`, `ICML`, `RECOMB`, etc.). Alone, this loses to a paper that has IMRaD headers.
- **Length and shape:** short, single-section. Used to corroborate a strong signal, not to fire one.

Negative signals (route elsewhere):
- Document is the abstract block of a longer paper that also has Introduction/Methods/Results/Discussion → route to `academic-paper` (its `abstract.md`).

Length alone is NOT a route-elsewhere reason. A 1000-word in-progress conference abstract still routes here when a strong signal fires.

## Section Detection

Conference abstracts are single-section by definition. **Skip section detection.** The entire document is the section the agent works against.

If the conference prescribes sub-headings (Background, Methods, Results, Conclusion), enforce them within this doctype's conventions; do not load any of the paper section files.

## Action Overrides

- **Draft (`actions/draft.md`):** Respect the word limit absolutely. Load the limit from `conference-style.md` if present; otherwise default to 300 words and flag the assumption in `<div class="summary">` ("Using 300-word default — share the conference's actual limit if different"). If a draft exceeds the limit, cut before delivery; do not deliver an over-budget draft. Output a final version under the limit.
- **Revise (`actions/revise.md`):** Use the word limit from `conference-style.md` if present; otherwise 300 words. Report the post-revision word count. If the revision pushes over the limit, abandon it and propose a tighter alternative.
- **Review (`actions/review.md`):** Critique within the word limit. "Add more detail on the methods" is not useful in a 250-word abstract — every addition requires a deletion. Frame comments as trade-offs ("replace [quote] with [proposed text] to add the missing rigor detail without expanding word count").

## Principles

1. **Hard word limit.** Word count is non-negotiable. Every drafting and revision decision is constrained by it. Lead each suggestion with the count consequence.

2. **Self-contained.** No citations to the author's other papers, no references to figures or tables, no "see Section X." The abstract stands alone for a reviewer who has never read the author's other work.

3. **Compress every element rather than dropping one** (Methods, statistics, or conclusion). Word-limit pressure tempts wholesale removal; resist it.

4. **Quantitative findings beat qualitative** at this length. Replace "significant reduction" with "39% reduction (p < 0.01, n=24)" whenever the data supports it.

5. **Close with a specific so-what claim.** Reviewers vote on the closing line — "our results identify FoxA2 as the primary upstream regulator of this pathway" wins over "our findings have important implications."

6. **Prescribed structure if mandated.** Many conferences prescribe Background / Methods / Results / Conclusion sub-headings. If the conference instructions specify them, use them verbatim. If the conference allows free-form, use a paragraph or two — but the same logical structure still applies internally.

7. **Title is part of the document.** A weak title costs as much as a weak conclusion. Spend attention on it. Specific titles beat clever titles.

## Common Failure Modes

- **No quantitative results.** Reviewers who skim look for numbers; their absence reads as "no findings yet."
- **All Background, no Results.** A common failure when the work is incomplete. If results are not in hand, the abstract should not yet be submitted.
- **Methods opaque.** "We performed analysis of the data" — what analysis? Reviewers need enough detail to assess the work's rigor.
- **Over the limit.** Document this and cut.
- **Generic conclusion.** "Our findings have important implications" tells the reviewer nothing.

## Memory: Conference Style

Most conferences have a distinctive style: word limits, prescribed headings, review criteria, scope expectations. The skill **asks once per manuscript** for this context. Storage and ask-flow mechanics are in `memory.md`; this section specifies the conference-specific format.

### What to ask for

When detecting `conference-abstract` doctype for the first time for this manuscript (no `conference-style.md`, no decline flag):

Ask the user for:
- Conference name and year.
- Word limit (exact number).
- Required sub-headings, if any (Background, Methods, Results, Conclusion — or alternative).
- Submission deadline.
- Format constraints (figure allowed? citations allowed? co-author list format?).
- Scope keywords or tracks the abstract is targeting.

One paragraph in the response is enough. Proceed to draft/review using sensible defaults (300-word limit, no figures, no citations, Background/Methods/Results/Conclusion structure) and flag the defaults so the user can correct them.

### What to save

When the user provides info, write `conference-style.md`:

```markdown
# Conference Style

- **Conference:** [name and year]
- **Word limit:** [exact number]
- **Required sub-headings:** [list or "free-form"]
- **Deadline:** [ISO date]
- **Figures allowed:** [yes/no, with constraints]
- **Citations allowed:** [yes/no]
- **Scope / track:** [the track or theme the abstract is targeting]
- **Captured at:** [ISO date]

## Other notes

[Anything else from the conference's call for abstracts.]
```

If the user uploaded the conference instructions as a file, save it as `conference-style.<ext>` alongside.

### When the user declines

Write `user-declined-conference-style: [ISO date]` to `_state.md`. Proceed with the defaults flagged above.

### When the user later provides info

Watch each subsequent turn. On provision: write `conference-style.md`, remove decline flag from `_state.md`.

<!-- skill-file: doctypes/conference-abstract/doctype.md @2026-05-19a -->
