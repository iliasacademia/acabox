# DocType: Academic Paper

A journal manuscript or preprint: empirical research papers, reviews, methods papers, perspectives. Multi-section, prose-heavy, citation-heavy.

## Detection Signals

Academic-paper is the default doctype for academic prose. Detection is permissive: a single IMRaD-style header is enough to fire, because single-section papers (only Introduction, only Methods, etc.) are a common drafting state. The skill's section detection (below) handles single-section drafts via the override rule.

Match if any of the following hold:

- **Section headers present:** one or more of `Introduction`, `Methods` (or `Materials and Methods`), `Results`, `Discussion`, `Abstract`, `References`. Two or more is a strong signal; one is sufficient when no more-specific doctype (grant, thesis, conference-abstract) claims the document.
- **Prose structure:** continuous multi-paragraph prose organized by IMRaD or similar conventions, with figure references like `(Figure 1)` and inline citations like `(Smith et al., 2023)` or `[1]`.
- **Filename hints:** the manuscript file name contains `manuscript`, `paper`, `draft`, `submission`, `journal`, `preprint`, or a journal name (`Nature`, `Cell`, `PNAS`, `JBC`, etc.).
- **User mention:** the user calls it "the paper", "my manuscript", "the article", "the preprint".

Negative signals (route elsewhere):
- `Specific Aims` header OR mechanism code in doc (R01, R21, K-series, F-series) OR FOA/RFA reference → route to `grant`.
- `Committee` + (`Dissertation` or `Thesis`) in doc, OR multiple `Chapter N` headers → route to `thesis`.
- Word-limit reference in doc OR user mention of a specific conference OR (≤500-word doc with prescribed sub-headings) → route to `conference-abstract`.

A weak signal for another doctype (e.g., filename "abstract" alone) does NOT override paper detection. See SKILL.md "Step 3: Detect the DocType" for the full precedence rules.

## Section Detection

Run these checks in order. Stop at the first match.

**Override (run first): single-section manuscripts.** If the document has prose in exactly one section — for example, only an Introduction is drafted, or only a Methods section is drafted — route to that section regardless of how the user phrased the request. Even when the user says "review the paper", "end-to-end peer review", or "review the whole manuscript", the relevant conventions are still that one section's, because that is the only prose there is to review. Load that section's file, set the `<span class="section">` in the skill-trace to that section (not General), and **skip the table below**. This override is the most common reason a section-specific file is loaded for a "full paper" request — apply it before considering anything else.

**Otherwise, use the table.** Infer from document context: headers, cursor position, selected text, or explicit mention.

| Section | File | Detection signals |
|---|---|---|
| **Results** | `doctypes/academic-paper/sections/results.md` | Section header contains "Results", "Findings", or user explicitly mentions results writing |
| **Methods** | `doctypes/academic-paper/sections/methods.md` | Section header contains "Methods", "Materials", "Experimental", "Procedures" |
| **Discussion** | `doctypes/academic-paper/sections/discussion.md` | Section header contains "Discussion", "Implications", "Interpretation" |
| **Introduction** | `doctypes/academic-paper/sections/introduction.md` | Section header contains "Introduction", "Background" (when it serves as intro) |
| **Abstract** | `doctypes/academic-paper/sections/abstract.md` | Section header contains "Abstract", "Summary" (when at paper start) |
| **General** | (no section file) | Section cannot be detected, or request is not section-specific. Apply base-layer conventions without loading a section file. |

If the resolved section's prose is in bullet form, Outline is a per-section **maturity overlay**, not a row in this table — see `SKILL.md` "Document Maturity Detection." Load `sections/outline.md` ON TOP OF the section file above.

## Action Overrides

None. The academic-paper doctype is the baseline against which other doctypes define their overrides. Apply `actions/*.md` as written.

## Per-Manuscript State

Per-manuscript state under `.academia/skill-state/academic-writing-agent/manuscripts/<doc-hash>/`:
- `detected-doctype.md` (cached detection result, with `original_path`)
- `field.md` (manuscript-specific field/subfield; supersedes `about_you.md` for grounding)

No doctype-specific setup file (unlike grant, conference-abstract, or thesis). Papers don't have a single piece of setup info worth asking the user to provide.

Note: `about_you.md` (user-level field/methodologies) lives in the auto-loaded `agent-memory/` folder, not here. It's already in context — reference it directly without reading.

<!-- skill-file: doctypes/academic-paper/doctype.md @2026-05-19a -->
