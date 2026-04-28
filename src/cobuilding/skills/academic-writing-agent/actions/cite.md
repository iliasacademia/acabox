# Cite Action

Citation and reference assistance. Used directly when the user asks about citations, and invoked as a sub-process by other actions (Draft, Revise, Feedback, Review) when they need to bring in outside knowledge.

## Two Modes

**User-facing:** The user explicitly asks about citations ("where do I need citations?", "find me a reference for this claim", "is this cited correctly?").

**Sub-process:** Another action identifies a claim that needs a reference and routes through Cite for verification before presenting it to the user.

## Verification Process

When a reference is needed, follow this priority order:

1. **Check the author's Zotero library and uploaded materials first.** If the relevant paper is already in the author's collection, use it. This is the highest-confidence source.
2. **Otherwise, use the CiteRight tools to find verified references** (see "Using CiteRight" below).
3. **Always label the source.** The user must know whether a reference came from their own library or from CiteRight's external search.

## Using CiteRight

CiteRight runs vector + web search over published literature, ranks candidates with an LLM, and verifies them — so anything it returns is real, not fabricated.

**To find references for a claim or passage** (e.g. the user's selected text or a single claim):

- **Determine the input text first.** Call `mcp__ms-word__get_selection` — if it returns non-empty selected text, use that as the input. If the selection is empty, fall back to `mcp__ms-word__get_text` to read the full document. The selection-first behavior matches user intent: if they highlighted a passage and asked for citations, they want references for that passage, not the whole paper.
- Call `mcp__citeright__find_references` with `document_text` set to the text from the previous step. This single call submits the text, polls the backend until it reports `done: true`, and returns the report with `claims[*].top_publications` populated. Default timeout is 600 seconds (10 min); CiteRight is async and can take several minutes for long passages, so this wait is normal — do not abandon it early.
- Read each claim's `top_publications` and present the top results with title, authors, year, and DOI/URL. Each entry also carries a `reasoning` field explaining why CiteRight matched it — surface this when the user asks why a reference was suggested.
- Note: `top_publications` are CiteRight's *new* citation suggestions for the claim. This is distinct from the paper's existing reference list (which CiteRight may also extract separately) — do not confuse the two.
- If the response still has `report.done: false` and includes a "backend did not finish within the timeout" note, the backend is taking longer than the timeout window. Call `mcp__citeright__get_citation_report` with the same `report_id` to keep checking — do NOT present partial results as final, and do NOT fall back to unverified LLM-suggested references.

**Lower-level alternative** (only if you need fine-grained control — e.g. to start a report now and check on it later, or to inspect partial progress): call `mcp__citeright__create_citation_report` to kick off, then `mcp__citeright__get_citation_report` to check the state. Default to `find_references` for normal use.

**To add a specific manual claim to a report** (when the user gives you an exact sentence to cite):

- Call `mcp__citeright__add_claim_to_report` with the report id and the claim text. It returns the updated report including the new `claim_id`.
- Then call `mcp__citeright__search_citations_for_claim` with the report id and that `claim_id` to get ranked publications back for it specifically.

**To format a list of works into a specific citation style:**

- Call `mcp__citeright__format_citations` with an array of works (each needs at minimum a `title`; richer fields like `authors`, `doi`, `publication_year`, `publication`, `volume`, `issue`, `pages` produce better output). Up to 50 works per call.
- Available formats: MLA, APA, Chicago, Vancouver, Harvard, IEEE, ACS. The response returns each format keyed by name.

**To resume work on a prior report:**

- Call `mcp__citeright__list_citation_reports` to see the user's recent reports, then `mcp__citeright__get_citation_report` for the one you want.

### Login requirement

CiteRight requires a logged-in academia.edu account. If a tool returns an error containing "requires a logged-in academia.edu account", surface that to the user verbatim and stop — do not fall back to unverified LLM-suggested references for that turn.

### When CiteRight returns nothing useful

If the ranked publications don't fit the claim, say so plainly. Do not pad the answer with unverified LLM guesses. It is better to say "CiteRight didn't surface a strong match for this claim — you may need to search manually" than to present a low-confidence reference as if verified.

## Common Knowledge Check

If a domain profile is available, consult it to determine whether a claim is common knowledge in this subfield (no citation needed) or requires a reference. Otherwise, err on the side of citing.

## Constraints

- Never fabricate citation details (authors, titles, journals, years, DOIs)
- Never present an LLM-suggested reference as if it were verified — always route through CiteRight or the author's materials first
- When multiple references could support a claim, prefer the one already in the author's materials over a CiteRight result
- Always label the source (author's library vs. CiteRight search) when presenting a reference
