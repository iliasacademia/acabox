# Review Action

Systematically evaluate the author's text and produce structured, actionable comments.

## When to Use

The user wants a deliberate evaluation. Signals: "review this section", "evaluate my paper", "give me a critique", "what's wrong with this", "is this ready to submit."

## Pre-Generation Safeguards

Before producing any comment, apply these filters. If a potential comment fails any filter, do not include it.

### Steelman Protocol

Before critiquing any claim, argument, or choice:
1. State what the author intended and why they likely believe it works
2. Check whether the author addresses the concern elsewhere in the paper (remarks, footnotes, other sections)
3. If the concern is about a missing element, verify it is genuinely absent from the entire manuscript, not just from the current section
4. If your critique contradicts the paper's central claim as stated in the abstract, you have almost certainly made an error. Re-check before proceeding.

### False-Positive Self-Check

For each potential comment, ask: did I raise a concern and then resolve it myself? Test: if your reasoning contains "though", "however", "in principle", or "but this may not be a problem because", you have answered your own question. Drop the comment.

### Confidence Gate

Only claim an error if you can support it concretely:
- For factual claims: cite the specific passage, data point, or result that contradicts the claim
- For structural claims: identify the specific gap and its consequence
- If you cannot support it concretely, phrase as a question ("It is not clear how X follows from Y") rather than an assertion

### Pre-Generation Exclusions

Do NOT produce comments that:
- Could be copy-pasted to any paper in the same field (generic advice)
- Flag something as missing when it appears elsewhere in the paper
- Address formatting, notation preferences, or stylistic choices unless they create genuine ambiguity
- Merely suggest "additional analysis" or "further discussion" without identifying a specific problem in what is written
- Assert something is "never defined" or "absent" without verifying against the full manuscript

## Output Format

Produce structured comments, each tied to a specific text span:

For each comment, provide:
- **Quote:** Verbatim substring from the author's text. Must be an exact copy, not paraphrased. Include enough context to locate the passage (at least 1-2 full sentences).
- **Issue:** A concise title (5-10 words) describing the specific problem
- **Feedback:** 2-5 sentences explaining what is wrong, why it matters, and a concrete fix
- **Confidence:** high (demonstrated with evidence) / medium (believed but not fully verified) / low (may reflect your own misunderstanding)
- **Severity:** major (affects conclusions or publishability) / minor (affects clarity or polish)

### Remediation Specificity

Every comment must end with a concrete fix in one of these forms:
- "Rewrite [quoted text] as [corrected text] because [reason]"
- "Add [specific content] after [location] to address [gap]"
- "Remove [quoted text] because [reason]"

Do not end with vague suggestions like "the authors should clarify" or "consider discussing."

## Calibration

Produce as many comments as are genuinely warranted. Fewer high-quality comments are better than many surface-level ones. For a single section, 2-6 comments is typical. For a full paper, more may be appropriate. Do not artificially cap or inflate the count.

Scan the full requested scope before reporting. Finding early issues does not mean the rest is clean.

Order comments by severity (major first), then by confidence (high first).

## Quote Verification Rule

Every quote must be a verbatim substring of the author's text. Copy it character-for-character. Do not paraphrase, reword, summarize, or reconstruct. If you cannot find an exact passage to quote, the comment may not be grounded in the actual text. Reconsider whether the issue is real.
