# DocType: General (Failover)

Used when no specific doctype matches. The user might be writing something the skill doesn't have a dedicated doctype for yet (an op-ed, an editorial, a research statement, a personal statement, an industry white paper, a course handout), or the document is too sparse / mid-edit to give the agent a confident signal.

This doctype applies the base-layer writing conventions only — it does not add section-specific rules, ask flows, or action overrides.

## Detection Signals

This doctype has no positive detection signals. It is the routing target when:
- No other doctype's detection signals fire.
- Signals from multiple doctypes contradict each other and no single one is clearly stronger.
- The document is blank or contains too little prose to detect a doctype.

Do not refuse a request because doctype is unclear. Route to General and proceed.

## Section Detection

Skipped. General has no sections. The agent works against the entire document or the user's selection.

If the user names a section explicitly ("review my methods", "draft the intro"), proceed as if that section existed and apply base-layer conventions. Do not load a section file — there isn't one for General.

## Action Overrides

None.

## Adjustments to Base Behavior

- **Lower confidence in field grounding.** If `field.md` is absent and `about_you.md` is also absent or generic, the agent has weaker signal about the author's domain. Avoid field-specific terminology guesses. When uncertain, ask the author to clarify.
- **Be explicit about doctype uncertainty.** When relevant, mention in the response (in the `<div class="summary">`) that you're not sure what kind of document this is, and offer to apply a more specific convention if the user names one ("If this is meant as a grant, say the word and I'll re-route").
- **Skill-trace doctype.** Set `<span class="doctype">General</span>` so the user can see the routing landed here.

## When to Re-detect

The user can override at any time: "this is a grant" / "treat this as a thesis chapter" / "it's a conference abstract." On override, re-route to the named doctype on the next turn. User override beats detection.

<!-- skill-file: doctypes/general/doctype.md @2026-05-13a -->
