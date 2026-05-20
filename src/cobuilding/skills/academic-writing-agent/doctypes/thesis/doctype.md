# DocType: Thesis / Dissertation

A graduate thesis or doctoral dissertation, or a chapter from one. Structurally similar to an academic paper but longer, with a dedicated literature review chapter and a heavier framing burden (the work has to demonstrate the candidate's command of the field, not just report findings).

Thesis chapters often reuse paper section conventions (methods, results, discussion) with thesis-specific adjustments: longer framing, more thorough literature engagement, fuller protocol detail.

## Detection Signals

Match if any of the following hold.

- **Chapter structure:** the document has chapter-level headers (`Chapter 1`, `Chapter 2`, ...) or sub-files titled by chapter.
- **Specific terms:** the document contains `Dissertation`, `Thesis`, `Committee`, `Advisor`, `Doctoral`, `PhD candidate`, `M.S. thesis`, `Defense`.
- **Filename hints:** `thesis`, `dissertation`, `chapter`, university name + degree program in the path.
- **User mention:** the user says "my thesis", "my dissertation", "Chapter X", "my committee wants…", "for my defense".
- **Length and scope:** a single section that is much longer than a paper section would be (literature review running 20+ pages, methods running 15+ pages) — suggests a thesis chapter rather than a paper.

Negative signals:
- IMRaD layout with paper-length sections, no chapter structure → `academic-paper`.
- Funding-agency aims/significance/innovation/approach structure → `grant`.

## Section Detection

Run these checks in order. Stop at the first match.

**Override (run first): single-section / single-chapter work.** If the document is a single thesis chapter (Methods chapter, Results chapter, Literature Review chapter), route to that section regardless of how the user phrased the request.

**Section table:**

| Section | File | Detection signals |
|---|---|---|
| **Literature Review** | `doctypes/thesis/sections/literature-review.md` | Chapter or section header contains "Literature Review", "Background", "Related Work" (in CS/ML contexts), or this is the long framing chapter |
| **Methods** | `doctypes/academic-paper/sections/methods.md` *(reused)* | Methods chapter. See thesis-specific adjustments below |
| **Results** | `doctypes/academic-paper/sections/results.md` *(reused)* | Results chapter. See thesis-specific adjustments below |
| **Discussion** | `doctypes/academic-paper/sections/discussion.md` *(reused)* | Discussion or "General Discussion" final chapter. See thesis-specific adjustments below |
| **Introduction** | `doctypes/academic-paper/sections/introduction.md` *(reused)* | Chapter 1 / opening chapter that introduces the dissertation as a whole. See thesis-specific adjustments below |
| **Abstract** | `doctypes/academic-paper/sections/abstract.md` *(reused)* | The dissertation abstract (typically 350–500 words, university-prescribed limit) |
| **General** | (no section file) | Section cannot be inferred, or request spans the whole dissertation |

If the resolved chapter is in bullet form, Outline is a per-section **maturity overlay** — see `SKILL.md` "Document Maturity Detection."

When reusing a paper section file, apply both that file's conventions and the thesis-specific adjustments below for that section.

## Thesis-Specific Section Adjustments

When a reused paper section is loaded for a thesis chapter, layer these on top.

### Introduction (Chapter 1)
- Cover broader scope than a paper introduction — the entire dissertation, not one study.
- Sketch the structure of the thesis at the end ("Chapter 2 establishes... Chapter 3 extends... Chapter 4 applies...").
- Heavier engagement with the field's history is allowed and often expected — beyond the gap statement.

### Methods chapter
- Fuller protocol detail than a paper Methods — reproducibility from the document alone is the bar, not "see supplementary."
- Include reagents lists, protocols, software versions in tables where feasible.
- Cite published protocols you adapted, and explain the adaptations.

### Results chapters
- May span multiple chapters (one per project or paper). Each chapter is typically structured like a paper's Results plus its own introduction and discussion.
- Cross-reference between chapters explicitly ("As shown in Chapter 3, ..."), unlike a paper which cross-references internally only.
- Figures get full-page treatment more often than in papers; captions are longer.

### General Discussion (final chapter)
- Integrate across all results chapters, not just one project.
- Place the work in the larger field. Identify next steps that go beyond what was done.
- Acknowledge limitations across the whole dissertation, not chapter by chapter.

### Literature Review
- See `doctypes/thesis/sections/literature-review.md` for full conventions — this is unique to thesis.

## Action Overrides

- **Draft (`actions/draft.md`):** Generate at thesis length, not paper length. A paragraph in a paper is often 4–6 sentences; in a thesis chapter, 6–10 is normal. Match the local prose density of the chapter.
- **Review (`actions/review.md`):** Apply committee-level expectations: scholarly thoroughness, command of the field, methodological rigor, and clarity of the candidate's contribution. Comments should map to whichever of these the committee will use.
- **Feedback (`actions/feedback.md`):** Frame feedback as preparation for the defense — what would a committee member ask, and how is the answer in (or absent from) the text?

## Memory: Thesis Context

Universities, departments, and committees have distinct expectations. The skill **asks once per manuscript** for this context.

### What to ask for

When detecting `thesis` doctype for the first time for this manuscript (no `thesis-context.md`, no decline flag):

Ask the user for:
- Degree (PhD, MS, MD-PhD, etc.) and stage (proposal, defense draft, final).
- University and department (for formatting and stylistic conventions if distinctive).
- Committee composition (chair + members; areas of expertise).
- Advisor's known stylistic preferences (some advisors want short paragraphs; others want exhaustive lit reviews).
- Specific guidelines the department imposes (length limits, format templates, citation style).
- Defense deadline.

One paragraph in the response is enough. Proceed with general thesis-chapter conventions in the same turn while flagging that the response is generic until context is provided.

### What to save

When the user provides info, write `thesis-context.md`:

```markdown
# Thesis Context

- **Degree:** [PhD / MS / MD-PhD / etc.]
- **Stage:** [proposal / defense draft / final / revisions after defense]
- **University:** [name]
- **Department:** [name]
- **Advisor:** [name, optional]
- **Committee:** [list of names + expertise, optional]
- **Format requirements:** [department-specific notes]
- **Citation style:** [APA / Vancouver / Harvard / per advisor preference]
- **Defense deadline:** [ISO date]
- **Captured at:** [ISO date]

## Notes

[Stylistic preferences from advisor, idiosyncrasies of the department, anything else worth remembering across chat sessions.]
```

### When the user declines

Write `user-declined-thesis-context: [ISO date]` to `_state.md`. Proceed with general thesis-chapter conventions.

### When the user later provides info

Same as the other ask-once flows: write `thesis-context.md`, remove decline flag.

<!-- skill-file: doctypes/thesis/doctype.md @2026-05-19a -->
