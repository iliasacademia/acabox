# Memory: User-Level Context and Per-Manuscript State

The writing-agent has two persistent state stores:

- **`<workspace>/.academia/agent-memory/`** — user-level (`about_you.md`, `working_on.md`). Auto-loaded by the harness; already in context. The skill never writes here — that's onboarding's territory.
- **`<workspace>/.academia/skill-state/academic-writing-agent/manuscripts/<doc-hash>/`** — per-manuscript state, read on demand and written by this skill.

Field grounding precedence: `field.md` (manuscript-specific, in skill-state) → `about_you.md` (auto-loaded) → none.

## Workspace Discovery

Walk up the manuscript path's directory tree until finding a directory that contains `.academia/`. Nearest wins. If none found, skill-state is unavailable; proceed without it.

```bash
dir="$(dirname "$MANUSCRIPT_PATH")"
while true; do
  if [ -d "$dir/.academia" ]; then echo "$dir"; break; fi
  if [ "$dir" = "/" ] || [ -z "$dir" ]; then break; fi
  dir="$(dirname "$dir")"
done
```

## Document Hash

A 16-character hex hash identifies each manuscript. Computed deterministically so every session arrives at the same hash for the same manuscript.

**Steps:**
1. Extract the manuscript's full path.
2. `basename` = filename without extension, lowercased.
3. `parent` = immediate parent folder name, lowercased.
4. **Normalize basename** — strip trailing version/date suffixes, repeatedly, until no more match. Separator class is `[_\-\s]` (underscore, hyphen, OR whitespace). Patterns (case-insensitive, anchored to end):
   - `[_\-\s]v\d+$` (e.g., `_v2`, `-v2`, ` v2`)
   - `[_\-\s]version\d+$`
   - `[_\-\s](final|draft|revised|clean)$`
   - `[_\-\s]\d{4}-\d{2}-\d{2}$` (ISO date)
   - `[_\-\s]\d{8}$` (compact date YYYYMMDD)
   - `\(\d+\)$` (Windows duplicate marker)
5. `identifier = "<normalized-basename>::<parent>"`.
6. Hash = first 16 hex chars of SHA-256(identifier).

**Bash one-liner:**
```bash
identifier="<normalized-basename>::<parent-lowercase>"
echo -n "$identifier" | shasum -a 256 | cut -c1-16
```

**Worked examples** — all rows below produce the same hash:

| Manuscript path | Normalized | Identifier |
|---|---|---|
| `~/Workspace/papers/cell-migration.docx` | `cell-migration` | `cell-migration::papers` |
| `~/Workspace/papers/cell-migration_v2.docx` | `cell-migration` | `cell-migration::papers` |
| `~/Workspace/papers/cell-migration_2026-05-13_final.docx` | `cell-migration` | `cell-migration::papers` |
| `~/Workspace/papers/cell-migration-final.docx` | `cell-migration` | `cell-migration::papers` |

Distinct identifiers (different parents):

| Manuscript path | Normalized | Identifier |
|---|---|---|
| `~/Workspace/NIH/proposal.docx` | `proposal` | `proposal::nih` |
| `~/Workspace/NSF/proposal.docx` | `proposal` | `proposal::nsf` |

For known limitations of this hash and the algorithm-stability commitment, see `CLAUDE.md` "Developer Reference."

## Composite Bash for state bootstrap

To minimize round-trips, run workspace discovery, hash inputs, and skill-state folder listing as ONE Bash call:

```bash
MANUSCRIPT_PATH="<full path injected by chat>"

dir="$(dirname "$MANUSCRIPT_PATH")"
WS=""
while true; do
  if [ -d "$dir/.academia" ]; then WS="$dir"; break; fi
  if [ "$dir" = "/" ] || [ -z "$dir" ]; then break; fi
  dir="$(dirname "$dir")"
done
echo "WORKSPACE=$WS"

basename_raw="$(basename "$MANUSCRIPT_PATH")"
basename_lc="$(echo "${basename_raw%.*}" | tr '[:upper:]' '[:lower:]')"
parent_lc="$(basename "$(dirname "$MANUSCRIPT_PATH")" | tr '[:upper:]' '[:lower:]')"
echo "BASENAME=$basename_lc"
echo "PARENT=$parent_lc"

if [ -n "$WS" ]; then
  echo "---skill-state listing---"
  ls -la "$WS/.academia/skill-state/academic-writing-agent/manuscripts/" 2>/dev/null || true
fi
```

The agent applies suffix normalization to `basename_lc` per the Document Hash rules above.

## Read Flow

At the start of every response, before composing:

1. **Composite Bash** (one round-trip) — workspace + basename/parent + skill-state listing.
2. **Compute the doc-hash** from basename/parent.
3. **Parallel Read batch** for per-manuscript files in `<workspace>/.academia/skill-state/academic-writing-agent/manuscripts/<doc-hash>/`:
   - `detected-doctype.md` (if exists) — cache short-circuit for doctype routing.
   - `field.md` (if exists) — manuscript-specific grounding.
   - `_state.md` (if exists) — decline flags.
   - Doctype-specific setup file (`grant-instructions.md` / `conference-style.md` / `thesis-context.md`) — read once the doctype is known (Step 5 in `SKILL.md`).

Every per-manuscript file is optional. Missing files are not an error.

## Write Flow

The skill writes to `skill-state/` via the `Write` tool. All writes go under `<workspace>/.academia/skill-state/academic-writing-agent/manuscripts/<doc-hash>/`. `Write` creates parent directories as needed.

### Tool-call placement

State writes happen **AFTER** the HTML text block, as a parallel batch, BEFORE any action-specific final tool call (e.g., `find_and_replace` for Revise). Turn shape:

```
[Bash: composite state bootstrap]
[parallel Reads: skill-state manuscript files + skill files for composition]
[HTML text block]
[parallel Writes: detected-doctype.md, field.md, doctype-specific setup file if any]
[action-specific final tool call if any]
```

**The turn is NOT complete until first-time writes have been issued.** Skipping a write means the next chat session re-runs detection and re-asks for setup info — the user loses the cache benefit they're entitled to. Treat first-time writes as mandatory.

No narration around writes — they are silent tool calls.

### When to write `detected-doctype.md`

After detecting the doctype for the first time (no cached file in the manuscript folder), write it. Also overwrite on user-override. Format:

```markdown
# DocType cache

- **DocType:** [Academic paper / Grant / Conference abstract / Thesis / General]
- **Detected at:** [ISO date]
- **Confidence:** [high / medium / low]
- **Signals matched:** [one-line list of the detection signals that fired]
- **Source:** [inferred / user-override]
- **Original path:** [full manuscript path]
- **Normalized basename:** [the basename after suffix-stripping, used in the hash]
```

`Original path` and `Normalized basename` make each manuscript folder self-describing — humans can identify a hash's manuscript by reading the file.

### When to write `field.md`

**Trigger:** if `field.md` was NOT loaded in the read flow AND the agent inferred a field/subfield during composition of this response. "Inferred" means: the agent used field-specific knowledge (terminology, conventions, citation expectations) for grounding. If the agent could not infer a field (manuscript empty / off-topic), skip — next session retries.

Format:

```markdown
# Manuscript field

- **Field:** [field, e.g., "Cell biology"]
- **Subfield:** [subfield, e.g., "Cytoskeletal dynamics"]
- **Detected at:** [ISO date]
- **Source:** [inferred from manuscript / inferred from about_you.md / user-stated]
- **Notes:** [optional]
```

### When to write doctype-specific setup files

`grant-instructions.md`, `conference-style.md`, `thesis-context.md`: written when the user provides the relevant setup info in chat. See each doctype's `doctype.md` for ask-flow details and file format.

If the user uploaded a raw file (PDF, docx), save it next to the markdown summary using the same base name with the original extension: `grant-instructions.pdf`, etc. The summary is what the skill reads on subsequent sessions; the raw upload is fidelity insurance.

### When to write `_state.md`

When the user declines to provide setup info, write a flag:

```markdown
# State flags

- user-declined-<setup-key>: <ISO date>
```

`<setup-key>` is one of `grant-instructions`, `conference-style`, `thesis-context`. Include only flags that apply. When the user later provides info that contradicts a flag, remove the flag line in the same write that adds the corresponding setup file.

## Ask-Once Protocol

For doctype-specific setup info (grant instructions, conference style, thesis context):

1. Compute doc-hash.
2. Check `skill-state/.../manuscripts/<doc-hash>/<setup-file>.md`:
   - Exists → load, proceed silently.
3. Else check `<doc-hash>/_state.md`:
   - Has `user-declined-<setup-key>` flag → proceed without setup info, do not ask.
4. Else **ask the user once** in this turn for the setup info. Be specific about what would help. Proceed to give the best generic answer in the same turn, flagging that it's generic until the setup info is provided.
5. **Watch every subsequent turn** (in this chat and future sessions) for user-provided info:
   - Provided → write `<setup-file>.md` (and raw upload), remove decline flag, proceed.
   - Declined → write decline flag.
   - Ignored / off-topic → do nothing; next session will ask again.

The agent does not re-ask in the same chat. Conversation context carries "I already asked."

<!-- skill-file: memory.md @2026-05-19a -->
