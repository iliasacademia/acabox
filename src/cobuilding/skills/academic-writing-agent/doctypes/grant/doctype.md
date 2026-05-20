# DocType: Grant Proposal

A research grant proposal, written for a funding agency. NIH-style for v1 (R01, R21, R03, K, F-series, U-series). NSF, ERC, foundation grants, and other agencies have similar shapes but different conventions; treat them as siblings to add later. If the user explicitly says "NSF" or "ERC", apply the closest NIH analog but note the limitation in the response.

## Detection Signals

Match if any of the following hold. More signals → higher confidence.

- **Section headers present:** the document contains two or more of `Specific Aims`, `Significance`, `Innovation`, `Approach`, `Research Strategy`, `Preliminary Data`, `Vertebrate Animals`, `Human Subjects`, `Bibliography & References Cited`. `Specific Aims` alone is a strong-enough signal.
- **Filename hints:** the file name contains `grant`, `proposal`, `R01`, `R21`, `R03`, `K99`, `K01`, `F31`, `F32`, `NIH`, `NSF`, `ERC`, `aims`, `RFA`, `PA-`, `PAR-`, or a known grant mechanism code.
- **FOA/RFA references in document:** mentions of "Funding Opportunity Announcement", "Notice of Funding Opportunity", "RFA-", "PA-", "PAR-", or an NIH IC code (NIGMS, NIAID, NCI, etc.).
- **User mention:** the user calls it "the grant", "the proposal", "the R01", "the NIH submission", "the NSF proposal", "the K award".

Negative signals (route elsewhere):
- IMRaD headers (Introduction/Methods/Results/Discussion) and no aims/significance/approach → `academic-paper`.
- "Chapter", "Dissertation Committee" → `thesis`.

## Section Detection

Run these checks in order. Stop at the first match.

**Override (run first): single-section grant.** If the document has prose in exactly one section (often just `Specific Aims` early in writing), route to that section regardless of how the user framed the request. Set `<span class="section">` accordingly and **skip the table below**.

**Otherwise, use the table:**

| Section | File | Detection signals |
|---|---|---|
| **Specific Aims** | `doctypes/grant/sections/specific-aims.md` | Header contains "Specific Aims", "Aims", or user explicitly mentions aims |
| **Significance** | `doctypes/grant/sections/significance.md` | Header contains "Significance"; or user mentions importance, public health relevance, gap |
| **Innovation** | `doctypes/grant/sections/innovation.md` | Header contains "Innovation"; or user mentions novelty, what's new |
| **Approach** | `doctypes/grant/sections/approach.md` | Header contains "Approach", "Research Strategy", "Experimental Design"; or user mentions methods, design, preliminary data, rigor, alternatives |
| **General** | (no section file) | Section cannot be determined, or request is doctype-wide (e.g., "review the whole proposal") |

## Action Overrides

- **Cite (`actions/cite.md`):** When suggesting references for a grant, weight recent (last 5 years) work heavily, and weight references from the target agency's reviewers and study sections where the user has supplied that context. Preliminary data from the author's own prior work (in their library) is especially valuable.
- **Draft (`actions/draft.md`):** When drafting any grant section, sustain a persuasive register. Grants are arguments, not reports. Lead each paragraph with the claim, not the evidence. Use figures and aims as scaffolding the prose hangs on.
- **Review (`actions/review.md`):** Apply review criteria the way an NIH study section would — significance, investigators, innovation, approach, environment — and call out the criterion each comment maps to.

## Memory: Grant Instructions

The funding announcement (FOA / RFA / NOFO / PA) and agency-specific constraints (page limits, font, mechanism rules, review criteria) shape every section. Without this context, generic advice is the best the agent can offer — which is much less useful than agency-aware advice.

The skill therefore **asks once per manuscript** for the grant instructions. Storage and ask-flow mechanics are in `memory.md`; this section specifies what to ask for and how to save it.

### What to ask for

When detecting `grant` doctype for the first time for this manuscript (no `grant-instructions.md` in the manuscript's `skill-state/` folder, no `user-declined-grant-instructions` flag in `_state.md`):

Ask the user for:
- The full funding announcement (FOA / NOFO / RFA / PA) — they can paste it, upload a PDF, or give a URL.
- Agency and mechanism (NIH R01, NSF CAREER, etc.) if not clear from the announcement.
- Page limits and formatting constraints.
- Deadline.
- Any reviewer-facing constraints they know about (study section, IC priorities, scored vs. unscored criteria).

Phrase the ask concisely. One paragraph in the response is enough. Do not block the rest of the response on the answer — proceed to give the best generic-grant feedback you can in the same turn while flagging that the response is generic until the user shares the FOA.

### What to save

When the user provides the info:

1. Write `grant-instructions.md` to the manuscript's `skill-state/` folder. Format:

```markdown
# Grant Instructions

- **Agency:** [NIH / NSF / ERC / foundation name]
- **Mechanism:** [R01 / R21 / CAREER / etc.]
- **FOA / RFA / NOFO / PA number:** [identifier, e.g., PAR-23-123]
- **Page limit:** [e.g., 12 pages for Research Strategy, 1 page for Specific Aims]
- **Deadline:** [ISO date]
- **Study section / IC priorities:** [user-supplied notes, if any]
- **Captured at:** [ISO date]

## Key constraints from the announcement

[Summary in user's own words or condensed from the announcement: what the agency is looking for, scope, eligibility, special review criteria.]

## Source

[How the info was provided — "user pasted FOA text", "user uploaded PDF (saved alongside as grant-instructions.pdf)", "user typed answers to questions"]
```

2. If the user uploaded a raw file (PDF, docx), save it alongside as `grant-instructions.<ext>` so the original is preserved.

3. If `_state.md` had `user-declined-grant-instructions`, remove that flag (the user just provided what they previously declined).

### When the user declines

Write the flag to `_state.md`:

```markdown
- user-declined-grant-instructions: [ISO date]
```

Then proceed with generic-grant feedback, noting in the response that the agent is operating without agency-specific context.

### What to do on later turns

Watch every user message in this and future chat sessions for grant-instructions provision. The user might paste the FOA later in the chat after they find it. When detected: write `grant-instructions.md` as above, clear any decline flag.

<!-- skill-file: doctypes/grant/doctype.md @2026-05-19a -->
