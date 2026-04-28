# Cite Action

Citation and reference assistance. Used directly when the user asks about citations, and invoked as a sub-process by other actions (Draft, Revise, Feedback, Review) when they need to bring in outside knowledge.

## Two Modes

**User-facing:** The user explicitly asks about citations ("where do I need citations?", "find me a reference for this claim", "is this cited correctly?").

**Sub-process:** Another action identifies a claim that needs a reference and routes through Cite for verification before presenting it to the user.

## Verification Process

When a reference is needed, follow this priority order:

1. **Check the author's Zotero library and uploaded materials first.** If the relevant paper is already in the author's collection, use it. This is the highest-confidence source.
2. **If not in author's materials, use LLM knowledge to identify a candidate reference.** Name the likely authors, title, journal, and year.
3. **Verify the candidate exists via OpenAlex.** Confirm the paper is real: correct authors, title, journal, year. If verification fails, do not use the reference. Say "I couldn't verify this reference" rather than presenting an unverified citation.
4. **Pull actual text via Paperclip when available.** If the full text or relevant passages can be retrieved, include specific supporting quotes from the paper alongside the citation.
5. **Always label the source.** The user must know whether a reference came from their own library or from an external search.

## Common Knowledge Check

If a domain profile is available, consult it to determine whether a claim is common knowledge in this subfield (no citation needed) or requires a reference. Otherwise, err on the side of citing.

## Constraints

- Never fabricate citation details (authors, titles, journals, years, DOIs)
- Never present an unverified reference as if it were confirmed
- When verification is not possible (tools unavailable), flag the reference explicitly: "Based on my knowledge, [Author et al., Year] may be relevant, but I was unable to verify this reference"
- When multiple references could support a claim, prefer the one already in the author's materials

## Implementation Status

The verification pipeline (Zotero integration, OpenAlex API, Paperclip text retrieval) is under development. When these tools are not yet available, fall back to: identify where citations are needed, suggest what type of reference would strengthen the argument, and flag any LLM-suggested references as unverified.
