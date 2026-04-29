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

**Choosing the input.** Before any CiteRight call:

1. Call `mcp__ms-word__get_selection`. If it returns non-empty text, that's the input — the user highlighted a passage and wants references for that passage, not the whole paper. Use the **short input path** below.
2. If the selection is empty, the user wants references for the whole document. Call `mcp__ms-word__get_file_path`. If it returns a `.docx` or `.pdf` path, that's the input. Use the **long input path** below.
3. If no file path is available (unsaved document), fall back to `mcp__ms-word__get_text` and treat that text as a long input.

### Short input path (selections, single claims)

- Call `mcp__citeright__find_references` with `document_text` set to the selection. The tool blocks until the backend reports `done: true`, then returns the slim report. Selections are fast — usually finishes in well under a minute.
- Read each claim's `top_publications` and present title, authors, year, DOI/URL, and the `reasoning` field that explains why CiteRight matched it.

### Long input path (whole document, file upload, large text)

These can take 5–10 minutes. **Do not call `find_references` here** — it would block silently for the entire wait and the user won't see progress. Instead, drive the polling loop yourself so progress is visible:

1. Kick off the report: `mcp__citeright__create_citation_report` with `document_text`, OR upload a file via `find_references` with `file_path` and a low `timeout_seconds` (e.g. 5) so it returns the `report_id` quickly without blocking.
2. Tell the user the report is in flight ("Submitted to CiteRight, report id N, fetching results as they come in…").
3. Loop: call `mcp__citeright__get_citation_report` with the `report_id`. Between calls, briefly summarize what's new — e.g. "Claim 1 has 5 references so far; claim 2 still searching." Wait roughly 20–30 seconds between polls. Do not poll faster than every ~10 seconds.
4. Stop polling when `report.done` is `true`. Then present the full set of references organized by claim, same as the short path.
5. If the user asks you to stop, stop. The report stays available — they can ask later and you can resume polling with the same `report_id`.

**Important constraints for both paths:**

- `top_publications` are CiteRight's *new* citation suggestions for the claim. This is distinct from the paper's existing reference list — do not confuse the two.
- Never present partial state as final. While `report.done` is `false`, label results as "so far" and keep polling.
- Never fall back to LLM-fabricated references when CiteRight is still running or returns nothing useful.

**Presenting references — show every detail, every reference, every claim.** The user needs the full picture to decide which references to use, so do not compress the response into a terse summary. The full report is what we asked for; surface it.

For **each claim** in the report, show:

- The claim text (as a heading or bold lead-in).
- **Every** publication in `top_publications` for that claim — do not pick just two or three "highlights". The user wants to see the ranked set CiteRight returned.
- The claim's `search_status` if it's anything other than complete (e.g. `"timed_out"`, `"died"`, `"unstarted"`) — say so explicitly so the user knows that claim's results are partial or missing.

For **each publication**, show all of these:

- **Full title** (not abbreviated).
- **Authors** — list them; for long lists, "First Author et al." is acceptable but include the count.
- **Year** and **journal/publication**.
- **A clickable link.** This is non-negotiable. Pick the most direct link from the data:
  1. Prefer the publication's `url` field if present.
  2. Otherwise build `https://doi.org/<doi>` from the `doi` field.
  3. If neither exists, say so explicitly ("no DOI available") rather than dropping the entry.
- **Reasoning**: the `reasoning` field explains *why* CiteRight matched this paper to the claim. This is one of the most useful parts of the response — always include it.

Format the link in markdown so the chat UI renders it as clickable: `[link text](url)`. The link text should be the DOI string, the journal name, or "DOI" — short and recognizable.

**Good example** (one publication, fully expanded):

> **Cao, Short & Yip (2017)** — "Understanding the mechanisms of amorphous creep through molecular simulation," *Proceedings of the National Academy of Sciences*. [10.1073/pnas.1708618114](https://doi.org/10.1073/pnas.1708618114)
> *Why matched:* Explicitly identifies the microscopic processes of creep as a "standing challenge" and an "open question," supporting the claim that these origins are poorly understood compared to crystalline solids.

**Bad example** (compressed, missing link, missing reasoning — do not do this):

> Cao, Short & Yip (2017), PNAS – "Understanding the mechanisms of amorphous creep through molecular simulation"

The chat UI opens links in the system's default browser, so a fully formatted reference becomes a one-click verification path for the user.

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
