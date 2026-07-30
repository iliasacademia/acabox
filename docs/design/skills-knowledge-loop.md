# Skills, Memory, and Connectors — the decisive plan

**Status: proposed, not approved, not implemented. 2026-07-29.**

*Supersedes the phasing in `docs/design/skills-plugins-connectors.md`. Storage substrate (Pristine / Store / Render) is accepted and carried forward unchanged. Everything else is re-ordered around the user's stated priorities. The taxonomy, the external-registry survey and the leaked-harness assessment in that earlier doc all still stand — read it for those; read this for what to build.*

*Context that reframes both docs: Acabox is a private, single-user, undistributed
tool. Third-party licence concerns raised in the earlier document are **moot** and
must not be re-raised.*

## Verification status

Re-checked by hand after drafting. **Confirmed:**

- **The skill roster is over budget today.** Real YAML parse of all 21 shipped
  `SKILL.md` frontmatters: **10,193 chars** of `description`, 10,567 chars of
  full roster lines. Budget constants confirmed present in
  `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`: `cU9=4`,
  `dU9=0.01`, `iU1=8000`. Largest single description is `xlsx` at 941 chars.
  (An earlier quick regex gave 4,594 — it silently truncated multi-line block
  scalars. Use a real YAML parser.)
- **The fix is a declared SDK field.** `skillListingMaxDescChars` at
  `sdk.d.ts:3777`, `skillListingBudgetFraction` at `:3781` — same `Settings`
  interface already populated at `agent-server/index.ts:473-476`.
- **Automatic memory recall is not firing in this app.** Zero `memory_recall`
  events and zero `relevant_memories` attachments across **all 10** production
  transcripts under `production/claude-config/projects/…`. The gate string
  `tengu_moth_copse` and the `memdir_relevance` selector both exist in the
  binary. Memory works here only because `MEMORY.md` is unconditionally loaded
  and the agent then chooses to `Read` the file it points at.
- **The memory dir is filling with skill-shaped content.**
  `reference_hex_mcp_as_sql_runner.md` (2,478 B) was written at 17:29 on
  2026-07-29 — during the research for this document — bringing the directory
  to 10 files.
- **The `content_hash` correction exists only as a code comment.**
  `.applications/coScientistUserMessages/scripts/genuine_messages.sql:39-42`
  carries it in prose; `scripts/` is code, so `miniApps:delete` removes it.
  Within the workspace, `content_hash` appears in exactly 3 files.
- **The import path works as specified.** One `curl` to
  `codeload.github.com/openai/plugins/tar.gz/refs/heads/main` → 21 MB in ~6.7 s,
  no git, no auth, **608 `SKILL.md` files** enumerable from the single archive.
- **Symlinked skill dirs load** (`isDirectory()&&!D.isSymbolicLink())return` in
  the CLI binary) and `app.requestSingleInstanceLock()` is absent from `src/`.

**Not verified — treat as the prerequisites §7 says they are:** that
`skillListingBudgetFraction` is actually honoured at runtime; that the model
volunteers a write-back mid-task (the one-week Phase 0 measurement, and the
single unvalidated assumption the headline rests on); the Obsidian vault
contents and paths; the wider blast-radius file list beyond the workspace.

Three new facts were measured while writing this and they change the design:

1. **The skill roster is already over budget today.** `o5_()` in the bundled CLI computes `contextTokens × 4 × skillListingBudgetFraction` (constants confirmed in the binary: `cU9=4`, `dU9=0.01`, `iU1=8000`). Acabox sends `claude-opus-5` with no `[1m]` suffix → 200,000 tokens → **8,000 chars for the whole roster**. The 21 shipped skills' `- name: description` lines total **10,615 chars** (measured, this session). Roughly 10 of 21 descriptions are being silently truncated right now, before a single import.
2. **The fix is one line in an object Acabox already passes.** `skillListingBudgetFraction` and `skillListingMaxDescChars` are declared fields of the SDK `Settings` interface (`sdk.d.ts:3777`, `:3781`) — the same interface as `autoMemoryEnabled`, set at `src/cobuilding/agent-server/index.ts:473-476`. There is also `Options.skills?: string[]` (`sdk.d.ts:2583`): *"only skills whose names match an entry are loaded into the main session system prompt."* That is the enable/disable mechanism, already built.
3. **The memory directory grew by one file during this research session.** `reference_hex_mcp_as_sql_runner.md` (2,478 B, written 17:29 today) is a *procedure* — it has a "**How to apply:**" section telling the agent exactly what to put in a `create_thread` prompt. The memory dir is filling with skill-shaped content because there is nowhere else to put it.

---

## 1. Skills vs memory vs connectors — the rule

> **If Claude needs it to do a particular job — especially if it has to be typed into a prompt for some other system — it goes in a skill. If it's about you, or about how to talk to you, it's a memory. If it's a URL and a credential, it's a connector.**

### The user's instinct is right about the container and wrong about the file

"Put it in the skill file" is correct about *skill*. It is wrong about *file*, and the error is expensive.

`SKILL.md` is loaded **in full, every time the skill activates**. A discovery appended to `SKILL.md` is a tax on every unrelated Co-Scientist question, forever. The correct destination is a sibling file under `references/`, which loads only when the router points at it.

Concretely: the Obsidian analytics note is 33 KB / 416 lines. As `SKILL.md` that is ~8k tokens on every activation including "how many users signed up yesterday". As `references/` behind a ~5 KB router it is ~1.2k tokens on activation plus whatever the task actually needs.

**Second correction, and this one is the reason the feature does not work today.** The description the user writes for the skill — the one crafted to catch "how many people actually used it" — is competing for an 8,000-char roster budget against 21 existing skills that already need 10,615. The verbose description is exactly the kind that gets truncated first. Before any of this ships, `skillListingBudgetFraction` must be raised.

### Mechanical comparison

| | **Skill** | **Memory** | **Connector** |
|---|---|---|---|
| **Trigger** | Main model calls `Skill({skill})` — a deliberate, declared act | A separate Sonnet supervisor (`memdir_relevance`) picks ≤5 files by relevance | User adds it in Settings; model calls `mcp__<id>__*` |
| **What is always in context** | `name: description` roster line only, injected once per session | `MEMORY.md` only — loaded through the same loader as `CLAUDE.md`, tagged `AutoMem`, capped 200 lines / 25 KB | Tool schemas for the server |
| **What loads on demand** | Full `SKILL.md`, then whatever `references/` the router names. No cap. | The individual memory file — **never** unless the supervisor selects it | Tool results |
| **Per-turn cost** | Roster share (budget = `contextTokens × 4 × fraction`; **8,000 chars total today**, over budget). Body costs zero until invoked. | `MEMORY.md` ≤25 KB unconditionally. Selected memories ≤5/turn, ≤4096 B each, 61440 B/session. | Schema only |
| **Portability** | A directory. Carries `scripts/`, `references/`, `assets/`. Exportable, importable, versionable. | One flat `.md`. No siblings. Cannot carry a `.sql` file. | Host config, per-install |
| **Who writes it** | You, or the agent, or an import — deliberately | The model, unprompted, via ordinary `Write`/`Edit`; the CLI stamps `originSessionId` | You, in Settings |
| **Reliability of firing** | Deterministic given the roster line is intact | **Unverified in this app.** Automatic recall is gated on `tengu_moth_copse`, default `false`. Zero `memory_recall` events across all 7 production transcripts. Every observed recall was the agent explicitly `Read`-ing a file after `MEMORY.md` pointed at it. | Deterministic |

### Why this settles the Hex case in one sentence

`mcp__hex__create_thread` takes **one string** and hands it to Hex's own Threads Agent, which cannot see the workspace, the memory dir, or the Obsidian vault. Every warehouse trap must be restated inside that string on every thread. A memory cannot guarantee it is present in context; a skill activation is a deliberate act with a body the model chose to load.

**The test, in one question: *does this need to be inside the prompt I send to Hex?*** If yes → skill. If it changes how Claude talks to you rather than what it sends to the warehouse → memory.

### What that means for the 10 files on disk today

| File | Verdict |
|---|---|
| `about_you.md` (70 B), `working_on.md` (40 B) | **Stay memories.** But they have *no frontmatter at all*, so the recall selector — which matches on filename + `description:` + `[type]` only — sees a bare filename. And they are not in `MEMORY.md`. Give them frontmatter and an index line, or move them out of a directory the CLI believes it owns. |
| `feedback_act_decisively.md`, `feedback_explanation_style.md` | **Stay memories.** Purest case: they apply precisely when no skill would activate. |
| `project_miniapp_build_broken.md` | **Stays a memory.** Machine- and version-specific; no domain skill owns it. Accept that it has no expiry field. |
| `project_coscientist_messages_schema.md` (3.1 KB) | **Becomes the skill's ledger.** It literally says "**How to apply:** when writing any Co-Scientist message query…" — an activation condition plus a procedure. Shrinks to a 4-line routing pointer. |
| `reference_hex_mcp_as_sql_runner.md` (2.5 KB, written today) | **Becomes `assets/hex-preamble.md` + two findings.** It is a procedure for constructing a prompt. Textbook skill. |
| `project_mcp_oauth_broken.md` (3.7 KB) | **Moves into `src/cobuilding/skills/acabox/SKILL.md`.** It is a procedure about Acabox's own behaviour that every install needs; a per-workspace memory cannot distribute it. |
| `project_coscientist_onboarding.md` | Split later: the ownership fact stays memory, the prioritisation hierarchy becomes a finding. |

Memory ends at ~2.6 KB of identity and behaviour. The skill absorbs the domain and is the only thing that grows.

---

## 2. The compounding-knowledge loop — the design

### The problem, stated from the evidence

On 2026-07-29 one session announced *"Three corrections to your handoff doc, all found the hard way."* Two reached agent memory. **Zero reached the Obsidian vault. The third reached nothing** — it survives only as a comment at `.applications/coScientistUserMessages/scripts/genuine_messages.sql:39-42`, inside a mini-app that `miniApps:delete` would remove. Six on-disk locations, including two executable `.sql` files, still assert the falsified rule. And the memory file that *did* get written records the cost of the previous round: *"Two separate Hex Threads agents each burned several minutes rediscovering this."*

So the loop already runs. It runs **partially**, **unreliably**, and **into the wrong container**.

### What makes it fire mid-task, not depend on the model volunteering

Three triggers, in descending order of reliability. The first is the answer to the workflow critique.

**Trigger 1 — an always-on routing rule in the system prompt.** At the moment of discovery the model is holding a competing instruction: the SDK's `# auto memory` section, which is present on **every turn unconditionally** whenever `autoMemoryEnabled` is true, and which demonstrably fired in session `fef47b89`. A `record_finding` instruction that lives only in `SKILL.md` §3 is strictly weaker — it is in context only if the skill was activated. Two live instructions pointing at the same fact, with nothing arbitrating, resolves to the cheaper, more familiar path: another memory file.

Fix: add a fourth string to `appendParts` at `src/cobuilding/agent-server/index.ts:351-357`, alongside `soulMd`, `docxGuidance`, `workspaceDirectoriesGuidance`:

```
## Where knowledge goes

Two durable stores, and they are not interchangeable.

- A fact about the USER, or about how to talk to them → write a memory file, as
  the auto-memory section above describes.
- A fact about a DATA SOURCE, A SYSTEM, OR A PROCEDURE — a table that silently
  returns zero rows, a join that works, a query form that avoids a timeout, an
  API quirk — → call mcp__knowledge__record_finding. Do NOT write it as a memory.
  Memories are recalled probabilistically and cannot carry a .sql file; findings
  are read deliberately by the skill that owns the domain.

If you learned something in this turn that would have saved you time had you
known it at the start, record it BEFORE you finish the turn.
```

This is additive and low-risk. The escape hatch, held in reserve and **not** used in v1: `CLAUDE_COWORK_MEMORY_GUIDELINES` (verified) *replaces* the entire memory system-prompt section with arbitrary text — the nuclear option if Phase 0 measurement shows the append loses. If we ever use it, the replacement must restate the frontmatter template and the `MEMORY.md` index rule, which the CLI's own text currently supplies.

**Trigger 2 — `SKILL.md` §3**, restating the protocol with a qualifies / does-not list, in context once the skill activates.

**Trigger 3 — host-detected omission, inverted.** The naive rule ("skill used, zero findings recorded") fires on the healthy path — a mature ledger means most sessions legitimately discover nothing — and would kill the Needs-attention channel inside a fortnight. The rule that carries signal:

> A turn ran `mcp__hex__*` (or any connector tool) **and read no file under `references/findings/`.**

That is *went to the warehouse without consulting the ledger* — the exact failure that cost the user twice, observable in the same tool-call stream `agentSession.ts` already watches to arm the OAuth pin. Written to `<userData>/<channel>/knowledge-review.json`, following the `tool-jobs.json` / `tool-build-health.json` precedent.

Separately, and **not** as a card: every chat that touched a connector tool gets an always-available **"Extract what this chat learned"** button in the chat header. That covers the partial-loss case (2 of 3 recorded) with zero nagging.

### The writer: the host, through an MCP tool

`mcp__knowledge__record_finding`, added to the workspace relay server at `src/cobuilding/agent-server/index.ts:283` (`createMcpRelayServers`), with host handlers registered onto `globalThis.__hostMcpServers` in `AgentInfrastructureController.registerHostMcpServers` (`:199`), implemented in a new `src/cobuilding/main/knowledge/findingsLedger.ts`.

Four reasons the host writes and the model does not:

- `Edit` requires a prior `Read`. Appending one line to a 40 KB ledger costs 40 KB of context. A tool call costs the arguments.
- The host stamps session id and timestamp with zero model cooperation.
- The host validates and relates before anything lands.
- A tool call is an event `agentSession` already relays, so it renders as a **"Recorded: content_hash is not a hash of content"** chat card instead of an anonymous `write /Users/…/foo.md`.

**Signature:**

```ts
record_finding({
  skill: string,              // must declare x-acabox-ledger in frontmatter
  title: string,              // ≤80 chars
  rule: string,               // what to do differently
  evidence: string,           // what was measured
  cost_if_unknown?: string,
  scope?: string[],           // tables/systems — drives bucketing
  supersedes?: string[],      // finding ids
  confirms?: string[],
  blast_radius?: string[],    // other places the old belief is written
}) -> { id, bucket, entry_count, ledger_bytes, related?: [...] }
```

**`blast_radius` is host-augmented, not model-authored.** It is the highest-value field in the format — it converts an invisible six-way inconsistency into a checklist — and it is the field a model under time pressure will skip. So when `supersedes` is present, the host greps the shared workspace directories for the superseded entry's distinctive token and writes the hit list into the entry itself. Free, always correct, and it is the one place in this design where the host clearly outperforms an instruction.

### Destination and format

```
~/Library/Application Support/acabox/production/skills/coscientist-analytics/
├── SKILL.md                          ~5 KB router.  HUMAN-OWNED. Host never writes here.
├── references/
│   ├── findings/                     HOST-OWNED. Excluded from import baseline + revert set.
│   │   ├── digest.md                 ≤2 KB, 15 lines, host-maintained
│   │   ├── index.md                  ACTIVE rows only
│   │   ├── index-archive.md          superseded rows
│   │   ├── messages.md               bucket bodies, shards at 32 KB
│   │   ├── messages-archive.md
│   │   └── cohorts.md
│   ├── tables.md                     hand-written, grain + join map
│   └── genuine-messages.md
├── assets/
│   ├── genuine_messages.sql          the ONE runnable copy
│   └── hex-preamble.md               prepended to every create_thread prompt
└── scripts/
```

Rendered into the workspace as an absolute symlink at `<workspace>/.claude/skills/coscientist-analytics`.

**`digest.md` is NOT inside `SKILL.md`.** The earlier draft put a host-maintained block inside the user's prose file. That collides head-on with the per-file sha256 baseline: every ledger-bearing skill would show `MODIFIED` permanently with no user edit, and `Revert` would delete the digest. Separate file, one unconditional router line, no shared ownership of any byte.

**`index.md`** — one row per *active* finding, hard-capped at 120 chars:

```
| id | topic | rule | scope | recorded |
|---|---|---|---|---|
| F-001 | sessions | co_scientist_sessions is a decoy — use co_scientist_agent_sessions | sessions | 2026-07-29 |
| F-014 | messages | group on MD5(content), not content_hash | messages | 2026-07-29 |
```

Superseded rows **move to `index-archive.md`**. The earlier draft said they "move to a collapsed section at the bottom" — markdown has no collapse and `Read` pulls the whole file, so that mitigation was imaginary. Same one level down: a superseded body moves to `<bucket>-archive.md` leaving a one-line stub. Audit bytes preserved, read context not paid.

**Entry body**, markdown plus one machine-readable comment so no per-entry YAML parser is needed:

```markdown
### F-014 · content_hash is not a hash of content
<!-- acabox:meta {"id":"F-014","status":"active","recorded":"2026-07-29",
     "last_read":"2026-07-29","session":"fef47b89","supersedes":["F-006"],
     "scope":["co_scientist_agent_messages"]} -->

**Rule.** Group the recurrence CTE on `MD5(content)`. Never on `content_hash`.

**Evidence.** Grouping the `example_template` rule on `content_hash` matched
**0** rows against an expected 3,362. Its distinct-user count is always 1.

**Cost of not knowing.** Every machine-authored template silently falls through
to `genuine`: 6,732 messages instead of 1,648, with no error anywhere.

**Also written down, may still be wrong.**
- `genuine-messages-canonical-query.sql:47,50,90` (EXECUTABLE)
- `Co-Scientist Analysis Package/06-QUERY-genuine-messages.sql:52,55,120` (EXECUTABLE)
- `HANDOFF - identifying genuine Co-Scientist messages.md:67,102`
- `03-METHOD-genuine-messages.md:67,102`
- `co-scientist.md - Analytics file.md:179`
- `02-DATA-MODEL-and-quirks.md:178`
Fixed in: `assets/genuine_messages.sql`.
```

### Dedup and supersede — never refuse a write

The earlier draft refused the write on a trigram-Jaccard hit ≥0.6. Two independent measurements kill that rule:

- On realistic rephrasings of this design's own examples, trigram Jaccard scores **0.118 – 0.184**. It does not fire. Nothing supersedes, nothing confirms.
- When it *does* fire, it fires on **corrections**, which are by construction lexically near-identical to what they correct. `F-006` ("Group the dedupe on content_hash, not raw content") vs the correction ("content_hash is not a hash of content; group on MD5(content)") share every distinctive token. The deduper would have discarded the single most valuable discovery of 2026-07-29 and kept the wrong entry.

**The rule: `record_finding` always writes. It never refuses.**

Relation detection runs *after* the write, host-side, as a ~300-token Haiku call against the scoped `index.md` rows (reusing the title-generation model path Acabox already has), classifying `duplicate` / `contradicts` / `new`. On `duplicate` or `contradicts` the host does not mutate anything — it raises one Needs-attention row: *"F-061 may supersede F-014"* with a one-click composed turn to resolve it. Losing a correction is far worse than carrying a near-duplicate for a week.

**Supersession** is a host operation: flip `status` in the target's meta comment, move its row to `index-archive.md` and its body to `<bucket>-archive.md`, run the blast-radius grep, regenerate `digest.md`.

**Freshness** is decoupled from dedup entirely. The host bumps `last_read` on every finding in any bucket file read during a turn — observable in the same tool stream. It is a bucket-granularity signal and the UI says so. **The 180-day auto-demotion rule from the earlier draft is cut**: with `last_confirmed` never moving it would have demoted all ~80 entries simultaneously, including the correct and heavily-used ones. Age is displayed; it does not reclassify.

### Bound on context cost

Three layers, each with an enforced ceiling.

**L1 — always in context.** One roster line per *enabled* skill. Budget = `contextTokens × 4 × skillListingBudgetFraction`.

- Today: 200,000 × 4 × 0.01 = **8,000 chars** against 10,615 needed. Truncating.
- Fix, in the settings object at `agent-server/index.ts:473-476`:

```ts
settings: {
  autoMemoryEnabled: true,
  autoMemoryDirectory: `${getWorkspaceRoot()}/${AGENT_MEMORY_SUBDIR}`,
  // The dream pass runs with Edit/Write/rm inside the memory dir, is told
  // CLAUDE.md wins over any contradicting memory, and cannot tell
  // hand-authored bytes from generated ones. Acabox runs the non-tiny
  // regime, where in-place Edit is permitted. Off until memories are pinnable.
  autoDreamEnabled: false,
  // Roster budget = contextTokens × 4 × fraction. At 200k tokens the 1%
  // default is 8,000 chars; our 21 shipped skills already need 10,615, so
  // descriptions were being silently truncated. 5% = 40,000 chars.
  skillListingBudgetFraction: 0.05,
},
```

L1 is **O(number of enabled skills)** and completely independent of ledger size. A ledger of 500 findings costs zero here.

**L2 — on activation.** `SKILL.md` ≤8 KB (UI warns above it, with the words "paid on every activation") + `digest.md` ≤2 KB via one unconditional router line.

**L3 — on demand.** `index.md` (active rows only, shards by scope past ~200 rows) + one bucket (shards at 32 KB).

Arithmetic at the observed rate (~3 findings/week → ~80 entries in six months): index ~10 KB, buckets 5–15 KB. Worst case for one task, index + two buckets ≈ 40 KB ≈ 10k tokens ≈ $0.05, and only when the domain comes up. Against today's alternative: the user pastes a 12 KB HANDOFF into chat by hand and still misses the correction.

### Recall — two independent channels

**Channel A (primary).** Roster description → `Skill({skill:'coscientist-analytics'})` → router → `digest.md` → `index.md` → one bucket.

**Channel B (backstop, and this is the one that cannot be truncated).** `MEMORY.md` is the *only* thing verified to be unconditionally in context — loaded through the same loader as `CLAUDE.md`, tagged `AutoMem`. The host maintains a sentinel-delimited routing block inside it, rewritten at boot and on skill add/remove/enable:

```markdown
<!-- acabox:routing:begin — maintained by Acabox, do not hand-edit -->
- Co-Scientist / Redshift / Hex analytics → load the `coscientist-analytics`
  skill before answering. Do not answer from the transcript; the warehouse has
  17+ traps that return plausible wrong numbers without erroring.
<!-- acabox:routing:end -->
```

One host-written line, always in context, always correct, immune to roster truncation. Safe because `autoDreamEnabled: false` means nothing else rewrites `MEMORY.md`.

**Known limit, stated rather than hidden:** the recall selector's catalogue is built once per directory per session and cached. A finding recorded mid-session does not become recallable until the next session. Within-session compounding happens through the skill route, not through recall — which is another reason the skill is the system of record.

### Worked example, end to end, real paths and real content

**Setup (Phase 0, one afternoon).**

```
mkdir -p "~/Library/Application Support/acabox/production/skills/coscientist-analytics/references/findings"
ln -s "…/production/skills/coscientist-analytics" \
      "…/production/workspace-data/.claude/skills/coscientist-analytics"
```

The symlink survives `copySkillsToWorkspace` today with zero code change: the reaper at `src/cobuilding/main/skills.ts:56-63` filters on `entry.isDirectory()`, and Node reports a symlink-to-directory as `isDirectory() === false`. **Make that deliberate** — a comment plus a jest case — so a future tidy-up cannot silently reintroduce the delete.

Also: add `/Users/iliasbeshimov/Library/CloudStorage/GoogleDrive-ilias@academia.edu/My Drive/Ilias Obsidian Vault/Ilias Work/Knowledge Files - Context for LLMs/` as a shared workspace directory. Today the only workspace-root symlink points at an empty `google-drive-cache`, so **the agent cannot see the vault at all** — which is why the user had to paste 12 KB of HANDOFF into a chat message.

Seed `references/findings/index.md` with ~8 entries lifted from the real memory file. F-001 through F-008 come straight out of `project_coscientist_messages_schema.md`:

- F-001 `public.co_scientist_sessions` is a decoy — `session_type` values are `word_window_focused`, `document_text_change`, `desktop_app`; it contains no `'standard'` sessions at all.
- F-002 The real table is `public.co_scientist_agent_sessions` (5,356 rows).
- F-003 The join is `messages.session_id = co_scientist_agent_sessions.source_id` — confirmed at 6,878 matched `type='user'` rows. `sdk_session_id` returns zero despite also being UUID-shaped.
- F-004 Watermark: prefer the monotonic `id` bigint over `source_created_at`; a late-ingested row slips a timestamp watermark but not an id one.
- F-005 `mini_apps` does not exist in `public`; the real name is `co_scientist_agent_mini_apps`.
- F-006 *(superseded by F-014)* Group the dedupe on `content_hash`.
- F-007 Classification is not incrementally stable — recompute over the full population each run, make only the row transfer incremental.
- **F-014 `content_hash` is not a hash of content.** The one that exists nowhere but a SQL comment.

**During a session.** User asks *"why did Co-Scientist clicks drop last week"*. The roster line plus `working_on.md` plus the `MEMORY.md` routing block route to `Skill({skill:'coscientist-analytics'})`. The router loads; its first digest line reads:

```
F-014 · group the message recurrence CTE on MD5(content), not content_hash —
        else every template reads as genuine (references/findings/messages.md)
```

The model reads `index.md`, then `cohorts.md`, prepends `assets/hex-preamble.md` plus the two relevant findings into the `create_thread` prompt — necessary because Hex's Threads Agent cannot see any of this — and gets the right number first time.

Mid-analysis it finds that `public.users` times out on a JOIN but completes as an IN-subquery. It calls:

```
record_finding({
  skill: 'coscientist-analytics',
  title: 'public.users JOIN times out; IN-subquery completes',
  rule: 'Filter with IN (SELECT id FROM …), never JOIN public.users directly.',
  evidence: 'JOIN form exceeded the Hex thread timeout on 2026-08-04; the
             IN-subquery form returned in 41s over the same population.',
  scope: ['public.users'],
})
```

Host: no relation found → assigns F-015, creates bucket `users.md`, adds one index row, regenerates the digest, returns `{id:'F-015', entry_count:15, ledger_bytes:9214}`. Renders in chat as **"Recorded: public.users JOIN times out"**.

Had the turn ended having queried Hex without reading a findings file, `knowledge-review.json` would carry one row and the Knowledge page would show *"This chat queried Hex without consulting the ledger"* with a one-click extract.

**Three weeks later.** Nothing in the always-on context grew except one index row. Asked a users-table question, the model activates, reads the digest, reads `index.md`, reads `users.md` only — and does not rediscover the timeout. On the Knowledge page: `coscientist-analytics · 15 findings · last recorded 3 weeks ago`. Opening F-014 shows its blast-radius list, and the user finally fixes the two executable `.sql` files that have been wrong since July.

---

## 3. Importing skills from outside

### Sources, in the order they should ship

| Source | Cost | What you get |
|---|---|---|
| **`openai/plugins`** | **One 21.7 MB tarball. Zero API calls.** | 607 skills. All 180 marketplace entries are `source: local`, so the whole browsable catalogue with descriptions is inside the one download. |
| **`anthropics/skills`** | One 3.7 MB tarball. Zero API calls. | 17 skills. |
| `anthropics/claude-plugins-official` | 1 raw fetch for the index | 276 entries, 223 commit-pinned, spanning 195 repos. **Search index only** — resolving which skills live inside a plugin costs one tree call per repo (195 repos ÷ 60/hr = 3.2 h). Resolve lazily, per entry, cache keyed by the pinned SHA (permanently valid). |
| `anthropics/claude-plugins-community` | 1 raw fetch | 2,283 entries across 2,014 repos. Lazy only; eager enumeration is 33.6 hours. |
| Local folder | drag-in | Copied into the store. |

### Fetch: codeload tarball, and nothing else

```bash
curl -sSL https://codeload.github.com/<owner>/<repo>/tar.gz/<40-char-sha> \
  | /usr/bin/tar -xz -C <staging> --strip-components=<N> "<repo>-<sha>/<subpath>"
```

One request. **No rate-limit headers at all** (measured — codeload returns only `etag`). ~1.4 s for one skill directory. Accepts a full commit SHA. Proven end to end against `box/box-for-ai` at the exact SHA `claude-plugins-official` pins, **with no git and without installing the plugin**.

Why not the alternatives:

- `api.github.com` is **60 req/hr unauthenticated** (measured) and its contents API returns directory entries with `content: null`, one level deep. Reserved strictly for metadata.
- `raw.githubusercontent.com` sends `cache-control: max-age=300` — a 5-minute stale window served **even on SHA-pinned, immutable URLs**.
- The CLI's own `/plugin install` resolves subdirectories via **git sparse-checkout**, which Acabox has already rejected. There is no skill-install verb anywhere; `/skills` is `description:"List available skills", immediate:!0` — read-only. Building our own fetch is not a workaround, it is the only path.

`/usr/bin/tar` is safe to depend on: it symlinks to `/usr/bin/bsdtar`, a real 275,184-byte Mach-O universal binary (libarchive 3.7.4) — categorically unlike `/usr/bin/git`, the 118,928-byte CLT shim.

`src/cobuilding/main/selfUpdater.ts:129-171` (`downloadWithProgress`) is directly reusable as the download half: `net.fetch`, streamed with backpressure, incrementally hashed, progress throttled to 200 ms. **Not** reusable: manifest sha512 verification, `buildSwapScript`, `validateNewBundle`. There is no signed manifest for a skill; integrity rests on TLS plus the commit SHA.

**A branch ref is resolved to a 40-char commit SHA first, and the SHA is what gets recorded.** A pin is meaningless otherwise.

### The provenance record — exact fields

A third `origin` in `skills-state.json`, reusing the per-file baseline machinery the storage design already specifies:

```jsonc
{
  "airtable-cli": {
    "origin": "imported",
    "enabled": false,                     // imports start OFF the roster — see below
    "source": {
      "kind": "github-subdir",
      "owner": "openai",
      "repo": "plugins",
      "ref": "main",
      "sha": "a1b2c3d4e5f6...40chars",     // resolved, never a branch
      "subpath": "plugins/airtable/skills/airtable-cli",
      "url": "https://github.com/openai/plugins/tree/a1b2c3d/plugins/airtable/skills/airtable-cli"
    },
    "importedAt": "2026-07-30T11:02:14Z",
    "importedVia": "ui",                  // 'ui' | 'agent'
    "importedFrom": "openai-curated",     // marketplace name, or 'direct'
    "upstreamTreeSha": "6369f464...",
    "upstreamBlobs": { "SKILL.md": "d3e046a5...", "scripts/run.py": "9f2c..." },
    "baseline":      { "SKILL.md": "sha256:...", "scripts/run.py": "sha256:..." },
    "declared": { "name": "airtable", "description": "…", "license": "MIT" },
    "aliasOfDirName": true,               // frontmatter name ≠ dir name
    "fileCount": 4,
    "execCount": 1,
    "hostOwnedPaths": ["references/findings/**"]   // excluded from baseline AND revert
  }
}
```

**Two independent hash sets is the whole point.** `upstreamBlobs` answers *"has upstream changed"*; `baseline` answers *"have I changed it"*. That is what lets the user take an upstream fix to `scripts/run.py` while keeping his own accreted edits to `SKILL.md` — the compounding workflow, not a blunt re-import.

**`hostOwnedPaths` is stated in Phase 1 so Phase 5 cannot violate it.** `references/findings/**` is host-owned, excluded from both the baseline and the revert set, always. No imported skill ever ships one, so there is never a legitimate upstream version to reconcile. Without this rule, a user who grew 60 findings into an imported skill and clicked `Revert → reimport` would lose five months of knowledge behind a button whose label promises the opposite.

### Update check against a pin — one API call, zero downloads

```
GET /repos/{owner}/{repo}/git/trees/{ref}:{urlencoded subpath}?recursive=1
```

Returns per-file git blob SHAs. Those are **locally recomputable**: `sha1("blob <len>\0" + bytes)` reproduced `d3e046a5ae107a6cb23cfb16c219837094ab35d3` byte-identically against `skills/pdf/SKILL.md`. So the verdict is **per file**, not per repo, and costs one metadata call. Checked on demand from the row, **never on a timer** — 60/hr is the entire budget.

### Validate, never rewrite

62 of 607 `openai/plugins` skills have frontmatter `name` ≠ directory name (`box-content-api` in dir `box`, `shadcn` in `shadcn-best-practices`). The CLI does not enforce agreement — it parses with a tolerant YAML reader and only emits telemetry.

**Adopt the directory name as the store id; surface the frontmatter name in the UI as a declared alias.** Rewriting the file would instantly register as a local modification against the import baseline and corrupt the "what did I change" signal on day one.

**No converter is needed.** All 607 `openai/plugins` `SKILL.md` files already carry conformant `name` + `description`. The `.codex-plugin/plugin.json` wrapper is Codex-specific and ignorable; the `skills/` subtree is directly usable. Validate: `name` present, charset (`^[a-z0-9]+(-[a-z0-9]+)*$`, 1–64), `description` present and ≤1024.

### Imports start OFF the roster. This is not optional.

The roster is a fixed char budget and it is already over. Importing 40 skills from a 607-skill catalogue would push descriptions below `dK8 = 20` chars and collapse the whole roster to bare `- name` lines — silently, with no error and no log. The observable symptom would be that `coscientist-analytics` stops activating on oblique questions and the model answers Hex from scratch. **Phase 1 would break Phase 3 before Phase 3 is built.**

So: `enabled: false` on import. Enabling is one click, and the Knowledge page shows a **measured** roster figure (see §4). The mechanism is `Options.skills?: string[]` (`sdk.d.ts:2583`) — pass the enabled ids; omit an id and it is not loaded into the roster. The store keeps every byte and the symlink stays, so a disabled skill is still readable on disk and by an explicit `Read`.

Per-skill enable/disable was cut from the earlier design as "a fourth state nobody asked for". It is not a state — it is the budget allocator, and it is load-bearing.

### `https://github.com/openai/plugins` — specifically

Pasting that URL into "Add a skill" does this:

1. Resolve `main` → a 40-char SHA via one API call.
2. Recognise it as a **catalogue** (it has `.agents/plugins/marketplace.json`, 180 entries, all `source: local`), so fetch the one 21.7 MB tarball, parse all 607 `SKILL.md` frontmatters locally, and present a searchable browse list with descriptions. Zero further API calls.
3. The user picks one, e.g. `plugins/airtable/skills/airtable-cli`. It is already extracted — copy that subtree into the store, strip symlinks, count executables, write the provenance record, `enabled: false`.
4. Show the `SKILL.md` body and the exec count **before** committing.

Pasting a *skill-level* URL (`.../tree/<sha>/plugins/airtable/skills/airtable-cli`) skips step 2 and streams only that subpath.

### Honest safety disclosure

Three cheap checks, one honest sentence, no sandbox:

1. **Strip every symlink in the extracted tree.** bsdtar refuses `..` traversal outright (verified: `payload/../../escaped.txt: Path contains '..'`), but it **does** materialise absolute symlinks — I extracted a working `link-out -> /etc/passwd`. Acabox's reaper at `containerService.ts:214-232` only covers workspace-**root** symlinks, so a nested one inside `.claude/skills/<id>/` survives every boot. This is a genuine unmitigated gap and it costs one `find -type l`.
2. **Count and state executables.** 103 of 607 `openai/plugins` skill dirs ship `scripts/`, 149 executable files total. `anthropics/skills` ships 26 across 17.
3. **Show the `SKILL.md` body before committing** — it is instructions the model will follow.

And the sentence, in the UI, in these words and not softened:

> Bash is auto-approved in Acabox with no permission handler. An imported skill can instruct Claude to do anything you could do at a terminal, and a bundled script runs with your full privileges the moment Claude invokes it. Importing is a trust decision equivalent to `curl … | sh` from that repository. The pinned commit makes it reproducible and auditable. It does not make it safe.

Third-party licence terms are out of scope: this is a private, single-user, undistributed tool. The declared `license` string is displayed verbatim as metadata because it tells the user whether they are reading MIT or "Proprietary. LICENSE.txt has complete terms" — informational, not a gate.

---

## 4. The UI

### One surface, two sections. Settled.

Not two rail tabs, and not a section in Settings.

- **The app's own idiom is one page, N sections by lifecycle.** `ToolsPage.tsx:294/383/428` already puts active tools, archived tools and orphaned tool-data on one page, each with a real count, each hidden entirely when empty. Skills and memories are two lifecycles of one noun.
- **Memory already has a half-surface that is lying by omission.** `DirectoryPermissions.tsx:256-308` edits exactly 2 of the 10 real memory files under the heading "Researcher profile", with hint text implying that is the picture. The work is to correct an existing surface, not add a second new one.
- **Promoting a memory into a skill is a cross-boundary action.** An action that spans two destinations gets built as a wizard instead of a button.

**Connectors stay in Settings.** They are credentials and belong next to the API key. Relocating a working 556-line settings section is pure churn. One `.connectorLink` at the page foot: *"Claude reaches Hex and other services through Connectors →"*.

New rail destination **Knowledge** (Material Symbol `book_2`), after Tools. Three edits: `Rail.tsx:21-27` `NAV_ITEMS`, the switch at `index.tsx:869-894`, a `display:none` mount copying `index.tsx:1033-1044`.

### Layout

```
21 SKILLS · 10 MEMORIES                              .pageShell__stats   App.css:167
Knowledge                                            .pageShell__title   App.css:177
What Claude can do here, and what it has learned.
All of it is markdown you can read and correct.      .pageShell__subtitle

ROSTER BUDGET                     12,480 / 40,000 chars   ▓▓▓▓▓░░░░░░  31%
23 of 31 skills enabled · all descriptions fit
  ^ measured via query.getContextUsage() → skills.{totalSkills,includedSkills,tokens}

NEEDS ATTENTION                                                        2
+---------------------------------------------------------------------+
| ● This chat queried Hex without consulting the ledger                |
|   "Weekly active users" · 2h ago    [Ask Claude to extract it] [×]  |
+---------------------------------------------------------------------+
| ● F-061 may supersede F-014                        [Review]     [×] |
+---------------------------------------------------------------------+
     (section absent when empty; do NOT copy .cdActivityRow until
      phaseB.css:1274/1276/1284 are fixed — --cd-line / --cd-surface /
      --cd-text1 are defined nowhere, so those rows currently draw a
      currentColor border on a transparent background)

+---------------------------------------------------------------------+
| ＋  Add a skill                                                  →  |
|    Paste a GitHub link, or describe what Claude should know.        |
+---------------------------------------------------------------------+
     .toolsAskCard verbatim (ToolsPage.tsx:282-291)

SKILLS                                                                31
+---------------------------------------------------------------------+
| coscientist-analytics    [MINE] [15 FINDINGS]     [Read] [Edit] [⋯] |
| How to analyse Co-Scientist product data in Redshift through the    |
| Hex connector. 17+ traps return plausible wrong numbers.            |
| last recorded 3w ago · SKILL.md 5.1 KB                              |
+---------------------------------------------------------------------+
| airtable-cli    [OFF] [openai/plugins] [MIT] [1 SCRIPT]  [Enable]   |
| Query and mutate Airtable bases from the command line.              |
| openai/plugins @ a1b2c3d · plugins/airtable/skills/airtable-cli ·   |
| imported 2m ago                                                     |
+---------------------------------------------------------------------+
| geo-database       [BUILT IN] [MODIFIED]      [Read] [Edit] [Revert]|
| Query NCBI Gene Expression Omnibus for datasets and metadata.       |
+---------------------------------------------------------------------+
     row   .connectorRow          ConnectorsSettings.css:21
     name  .connectorRow__name    :61     chips .connectorRow__chip  :71
     desc  .connectorRow__status  :91     meta  .connectorRow__target :81
     btns  .connectorBtn          :109

WHAT CLAUDE HAS LEARNED                                               10
+---------------------------------------------------------------------+
| Co-Scientist message tables — corrections   [PROJECT]      [Review] |
| co_scientist_sessions is a decoy that returns zero rows silently    |
| 3.0 KB · written by Claude 1d ago · from "Hex schema dig" →         |
|                                          [Make this a skill]        |
+---------------------------------------------------------------------+
| about_you.md                                [PROFILE]      [Review] |
| 70 B · changed 3h ago · not indexed in MEMORY.md                    |
+---------------------------------------------------------------------+

Claude reaches Hex and other services through Connectors →
```

Detail modal reuses the shell already proven outside the Files tab (`.toolsConfirmOverlay` + `.savedFileViewer`, `ToolsPage.tsx:573-587`), widened to ~820 px. Tabs: **Read** (`<MarkdownView>`, which already ships its own Rendered/Source toggle — do not rebuild it), **Edit** (`.wsSettings__textarea` with a `--mono` modifier and focus switched to `var(--cd-blue)`; the existing rule still uses the pre-sweep tan `#a09880`), and for ledger-bearing skills a third **Findings** tab rendering `index.md` as a real table with per-row expand and `[Supersede]`. Footer: store path, `[Reveal in Finder]`, `[Ask Claude to improve this]`, Cancel/Save with the dirty-tracking pattern from `DirectoryPermissions.tsx:64-84`.

### Every row element, measurable-today or needs-plumbing

**Measurable today, zero new plumbing** (via `window.filesAPI`, which already reaches both directories — `files:readDirectory/readFile/writeFile/revealInFinder` are scoped to `workspacePath`, `.claude` and `.academia` are not in `SENSITIVE_DIRS` at `fileHandlers.ts:28`, and the guard is a lexical `path.resolve` so it reads straight *through* the store symlink):

- skill id, description, `license`, `source` (`source` present on 8 of 21, `license` on 16 — render the chip only when present, **never** a fabricated "Unknown", per the precedent already commented at `ConnectorsSettings.tsx:16-22`)
- memory title / description / type from frontmatter; **absent on `about_you.md` and `working_on.md`, which render by filename with no description**
- file size, mtime, `SKILL.md` byte count
- whether a memory is listed in `MEMORY.md` (parse the index)
- broken/absent frontmatter → render the row by directory name so the CLI's silent drop becomes *visible*
- memory origin chat: `originSessionId` → `sessions.sdk_session_id`, clickable

**Measurable today, one small IPC** — `knowledge:usage`, ~30 lines main-side plus one preload line, a SQL `LIKE` over `messages`, no schema change:

- skill last-used: `"name":"Skill"` in the persisted assistant content (`agentSession.ts:781` stores it verbatim; 2 real rows in the production DB, e.g. `{"name":"Skill","input":{"skill":"manage-mini-application",…}}`)
- memory last read/written by Claude: `Read`/`Write`/`Edit` tool_use naming an `agent-memory` path (28 real rows, Edit 10 / Read 10 / Write 7, spanning 2026-07-25 to 2026-07-29)

**Render as a lower bound, or not at all.** `messages` cascades on chat delete, so a skill used only in a deleted chat reads as unobserved. Ship the timestamp on **memories** (where write time is the trust signal); hold it on skills until there is a reason.

**Measurable today, one control call** — the roster budget meter. `query.getContextUsage()` (`sdk.d.ts:2108`) returns `skills: { totalSkills, includedSkills, tokens, skillFrontmatter: [{name, source, tokens}] }`. That is a **measured** figure, not a computed estimate. Requires plumbing one control request through the agent server.

**Needs plumbing, small** — `NOT LOADED`: capture `init.skills` (`sdk.d.ts:3369`) beside the existing `recordConnectorStatus` call at `agentSession.ts:761-769`. Same shape, ~6 lines. Cut from v1.

**Needs plumbing, large** — `MODIFIED`, `UPDATE AVAILABLE`, `Revert`, per-file baselines. Requires the store substrate; impossible today because `skills.ts:66-70` force-overwrites everything at boot.

**Do not render, ever:**

- a **"recalled from memory"** chip. Zero `memory_recall` events across all 7 production transcripts; automatic recall is gated on `tengu_moth_copse`, default `false`. This would be a mock.
- **"needs connector X"**. No skill declares one; the field does not exist.
- **"edited by you"** on a file changed in Finder or vim. The neutral default is `changed 3h ago`; an actor is added only when there is proof (a `Write` tool_use in the DB, or a save made through this panel).

---

## 5. Revised phased plan

Ordered by the user's stated priority, with one exception explained below. **Verification standard for every phase:** `npx tsc --noEmit` clean; `npx jest` no worse than the current **245/246** (only the pre-existing `fileMonitorIntegration` may fail); `npm start -- -- --smoke-test` exits 0 — and note the smoke test *does* exercise provisioning, because it quits at `index.ts:832`, well after the provision call. Where UI is involved, add live CDP against a running `npm start`.

---

### Phase 0 — Unblock, de-risk, and two standalone fixes. One day. Mostly no new code.

**The exception to priority order, and it earns its place.** Everything in Phase 0 is either broken right now, or is the one-afternoon experiment that decides whether Phases 3 is worth building at all. Spending three weeks on a substrate and a browse UI before anyone knows whether the model actually volunteers a write-back mid-task is not de-risking, it is guessing.

**Modify:**
- `src/cobuilding/agent-server/index.ts:473-476` — add `autoDreamEnabled: false` and `skillListingBudgetFraction: 0.05`, with the reasons in comments (text above).
- `src/cobuilding/main/skills.ts:54-63` — invert the reaper: an unknown directory is **adopted**, never `rmSync`'d. Add the comment and a jest case pinning the verified symlink-survives behaviour (`Dirent.isDirectory()` is false for a symlink), so a future "tidy up the filter" commit cannot silently reintroduce the delete.
- `src/cobuilding/main/skills.ts` — add logging. `grep -c 'log\.' ` returns **0** today, which is why "my skill edit vanished" is currently undiagnosable.

**Do by hand, no code:**
- Create `~/Library/Application Support/acabox/production/skills/coscientist-analytics/` and symlink it into `<workspace>/.claude/skills/`. Write the ~130-line router. Seed `references/findings/index.md` with F-001…F-008 harvested from `project_coscientist_messages_schema.md` and the mini-app SQL comments, **including F-014**.
- Add the Obsidian `Knowledge Files - Context for LLMs/` folder as a shared workspace directory.
- Fix `genuine-messages-canonical-query.sql:47,50,90` and `06-QUERY-genuine-messages.sql:52,55,120`. **They are wrong right now** — anyone who runs them gets 6,732 "genuine" messages instead of 1,648, with no error.

**The measurement.** For one week, `SKILL.md` §3 instructs a plain `Write` append to `references/findings/index.md`. Count how often it actually happens against how often a Hex session discovered something. That single number decides whether `record_finding`, the relation triage and the digest get built in Phase 3, or whether the trigger needs the `CLAUDE_COWORK_MEMORY_GUIDELINES` escape hatch first.

**Verified:** tsc, jest, smoke. Plus: a real turn confirming `skillListingBudgetFraction` took effect — `query.getContextUsage().skills.includedSkills === totalSkills` and no description truncated.

---

### Phase 1 — Import a skill and see where it came from *(user priority 1)*

**Create:**
```
src/cobuilding/shared/skills.ts               types, SKILL_ID_PATTERN, frontmatter parse, buildSkillRuntimeConfig()
src/cobuilding/main/skillHash.ts              hashFile/hashTree, pristine manifest at boot
src/cobuilding/main/skillStore.ts             reconcile/read/create/delete/setEnabled
src/cobuilding/main/skillRender.ts            renderSkills(workspaceDir) — absolute symlinks under .claude/skills
src/cobuilding/main/knowledge/skillImporter.ts   codeload fetch, SHA resolve, tar extract, symlink strip, exec count
src/cobuilding/main/__tests__/{skillStore,skillRender,skillImporter}.test.ts
src/cobuilding/shared/__tests__/skills.test.ts
```
**Modify:** `main/skills.ts` (delete `copySkillsToWorkspace` + the `SKILLS` array + the duplicated inline `defaultSettings` at `:122-156`; repoint `syncMiniAppAssets` at the store), `main/index.ts` (reconcile gate, `skills:*` IPC), `main/preload.ts`, `renderer/types.d.ts`, `agent-server/sessionConfig.ts` (`AgentConfig.skills?: string[]`), `agent-server/index.ts` (pass `Options.skills`), `AgentInfrastructureController.ts` (`skills: buildSkillRuntimeConfig()`), `package.json` (`js-yaml` — descriptions are multi-line, a hand-rolled parser is not viable), plus a minimal Knowledge page with the Skills section and the Add-a-skill card.

**Independently useful the day it lands:** the user pastes an `openai/plugins` URL, browses 607 skills from one tarball, imports one, and the row reads `openai/plugins @ a1b2c3d · plugins/airtable/skills/airtable-cli · imported 2m ago` with the SHA hyperlinked to the exact tree. **And skill edits stop vanishing.**

**Verified:** tsc, jest, smoke. Tests pin the empirically-measured semantics nothing currently pins: symlink dirent type, `rmSync` on a link, `cpSync` onto a link (`ERR_FS_CP_DIR_TO_NON_DIR`), the reconcile table against a real temp tree, symlink stripping against a crafted tarball with an absolute link, and the git-blob-SHA recomputation against a real tree API response. **Live:** import a real skill from `openai/plugins`, enable it, run a real turn, confirm the id appears in `init.skills` and the roster meter moves.

---

### Phase 2 — See, view, create, modify *(user priorities 2 and 4 — one build)*

**Create:** `renderer/components/knowledge/{KnowledgePage,KnowledgeRow,KnowledgeDetail}.tsx` + `knowledge.css`
**Modify:** `renderer/index.tsx`, `renderer/components/DirectoryPermissions.tsx` (correct the "Researcher profile" copy and link to Knowledge), `main/index.ts` (`skills:write|create|remove|revert|reveal`, `knowledge:usage`), `main/preload.ts`, `renderer/types.d.ts`

Detail modal with Read/Edit; Create skill; Delete; Reveal in Finder; per-file sha256 baseline giving the `MODIFIED` chip and `Revert` (revert-to-trash at `<userData>/<channel>/skills-trash/`, GC'd at 30d — never a bare delete). Memory section reading the real 10 files with type / origin chips and the `originSessionId` → chat link.

**Incidental fixes folded in, because the new surface would otherwise inherit them:** the three undefined CSS variables at `phaseB.css:1274/1276/1284`, and the pre-sweep tan `#a09880` focus colour in `.wsSettings__textarea` / `shared-forms.css:74`.

**Also in this release — the content-truth pass.** A catalogue is the worst possible place to first display rot:
- `flow-cytometry` — all six scripts `import flowkit`, it is not in the venv, `SKILL.md` has no install instructions. Add `.applications/install pip flowkit`, or add the non-functional banner `differential-expression` already carries. Pick one.
- `acabox/SKILL.md:78,83,84-85` claims R runs on the host and advertises `differential-expression` and `flow-cytometry` as "ready to go", contradicting `differential-expression/SKILL.md:17`.
- Fold `project_mcp_oauth_broken.md` into `skills/acabox/SKILL.md`.

**Verified:** tsc, jest, smoke, plus live CDP screenshots of every state — populated, a `MODIFIED` skill, a broken-frontmatter row rendered by dirname, an empty memory section, the detail modal in both tabs — and a confirmation that no fabricated "Unknown" chip and no "recalled" chip appear anywhere in the rendered document.

---

### Phase 3 — The compounding loop *(the headline)*

**Create:** `src/cobuilding/main/knowledge/findingsLedger.ts`, `src/cobuilding/main/knowledge/omissionWatch.ts`, `renderer/components/knowledge/FindingsTab.tsx`
**Modify:** `agent-server/index.ts` (`knowledge` relay server in `createMcpRelayServers` at `:199`; the routing rule appended at `:351-357`), `AgentInfrastructureController.ts` (host handlers at `:199`; **`mcp__knowledge__record_finding` added to `allowedTools` at `:248`**), `main/agentSession.ts` (tool-stream watch for the omission rule; `Recorded:` card), `renderer/components/assistant-ui/tool-card-display.ts` (the `Recorded:` card mapping), `main/index.ts` (`MEMORY.md` routing block maintenance at boot).

**One trap that must be guarded, not remembered.** `filterMcpServers` (`agent-server/sessionConfig.ts:37-46`) drops any relay server with no matching `mcp__<name>__*` entry in `allowedTools`. Forget the `allowedTools` line and the knowledge server silently vanishes — write-back stops with no error the user would ever see. And `applyConnectorsToSession` (`index.ts:682`) replaces the *whole* dynamic set; this codebase has already been burned by exactly that (`removed:['relaydemo']` killed every relay). **Ship a boot assertion** that throws if `mcp__knowledge__record_finding` is absent from the resolved `allowedTools` — the same throw-at-boot invariant already used for `IDLE_EVICTION_MS` vs the OAuth pin window.

Also: the Findings tab, the relation-triage Haiku call, `knowledge-review.json`, the inverted omission card, and the always-available "Extract what this chat learned" button in the chat header.

**Verified:** tsc, jest, smoke. **Agent-server standalone** against the built bundle on its own port: `record_finding` writes a well-formed entry, index and digest regenerate, sharding fires at 32 KB, the boot assertion throws when the tool is removed from `allowedTools`. **Live:** a real Hex turn that records a finding and renders the card; a real Hex turn that reads no findings file and produces exactly one review row.

---

### Phase 4 — Memory as an inbox

**Modify:** `main/index.ts` (`sessions:delete` reclaims the chat's memories, mirroring `transcriptStore.deleteTranscript` almost exactly), `main/knowledge/memoryStore.ts` (new — give `about_you.md` / `working_on.md` frontmatter and a `MEMORY.md` line, or move them out of the auto-memory dir), `renderer/components/knowledge/` (`[Make this a skill]` composing a real turn — ~12 lines, a direct copy of `ActivityPanel.tsx:126-134`).

Two collisions closed here that are latent data-loss risks today: the one-directory/two-schemas problem (Acabox-authored profile files with no frontmatter sitting in a directory the CLI believes it owns and prunes), and the fact that deleting a chat leaves every memory it authored, with a now-dead `originSessionId`.

Add a boot count of the memory dir with a card above a threshold — so if the remote extraction gate (`tengu_passport_quail`, default false, outside Acabox's control) ever flips on, the resulting accumulation is at least *visible*.

---

### Phase 5 — Freshness and scale. Only when there is enough knowledge to strain.

Per-file upstream update checks via git blob SHAs; automatic index sharding by scope; the consolidation-proposal card at 300 active findings; `init.skills` capture and the `NOT LOADED` chip. Deliberately last: none of it is needed at 15 findings, and building it earlier is sizing machinery against imagined load.

---

### How this supersedes `docs/design/skills-plugins-connectors.md`

| Prior phase | Fate |
|---|---|
| **Phase 0** — boot hardening (try/catch per step, logging, delete the `SKILLS` array, symlink skip, single-instance lock) | **Survives, folded into the new Phase 0 and Phase 1.** The reaper inversion is promoted to day one because it blocks everything. |
| **Phase 1** — store, render, reconciler | **Survives intact as the new Phase 1**, with the import path added and one new invariant: `references/findings/**` is host-owned and excluded from baseline and revert. |
| **Phase 2** — explicit allowlist, bundled suppression, load assertion | **Promoted into Phase 1 and re-justified.** It was framed as hygiene; it is actually the roster-budget allocator, and without it Phase 1 breaks Phase 3. `Options.skills` is the mechanism. Dropping bare `'Skill'` from `allowedTools:248` still happens here. |
| **Phase 3** — Extensions tab, read-only, + content-truth pass | **Renamed and re-scoped as Phase 2 "Knowledge".** The tab is `Knowledge`, not `Extensions`; it carries memories too. The content-truth pass survives unchanged. |
| **Phase 4** — mutation and live apply | **Split.** Edit/create/delete/revert move up into Phase 2. `POST /reload-skills` and the four agent-facing skill tools are **demoted to Phase 5** — the agent already has `Write` into `.claude/skills` and the reconciler adopts what it finds. |
| **Phase 5** — first-party plugin for hooks and `bin/` | **Cut from this plan entirely.** Pure hardening with no user-visible change, three untested packaging prerequisites, and zero bearing on any of the four stated priorities. Revisit independently. |
| **`SkillDiff.tsx` / `react-diff-view`** | **Cut.** Verified usable (peer `react>=16.14.0`, no removed APIs, typechecks clean, CSS rule accepts it) — so bank the finding. But it is ~130 KB with lodash inlined, and a scientist reverting a skill wants a Revert button and a confirm, not a unified patch. |
| **Moving `ConnectorsSettings` into the new tab** | **Cut.** Relocating a working 556-line settings section is churn. One `.connectorLink` covers the real need. |
| **Per-skill file tree, 30-day trash *UI*, rail count badge, "Restore all built-ins"** | **Cut from v1.** Only `docx`/`pptx`/`xlsx` are meaningfully multi-file; Reveal in Finder covers the rest. The trash *directory* stays; its browser does not. |
| **"Plugins" vocabulary, marketplace UI, zip import** | **Cut**, as the prior doc already concluded. |
| **NEW, not in the prior doc** | The entire compounding loop (Phase 3); memory as a first-class surface (Phase 4); the roster budget as a designed constraint; `autoDreamEnabled: false`. |

---

## 6. What NOT to build

**A skill registry, marketplace client, or plugin installer.** The CLI's own install verb needs git sparse-checkout, which we have rejected; the catalogue is two tarballs. Building a registry to do what one `curl | tar` does is exactly the half-vertical this project deletes on sight.

**A frontmatter converter for imported skills.** 607 of 607 `openai/plugins` skills already conform. Write a validator; rewriting a file corrupts the modification baseline on day one.

**An automatic post-turn extraction subagent.** The SDK has one (`extract_memories`, gate `tengu_passport_quail`, default false, remotely controlled). Building our own costs a second model call on every eligible turn, and a silent writer of unreviewed knowledge is precisely the auto-dream failure mode this design rejects. The "Extract what this chat learned" button gets the same value on demand, for free.

**Auto-dream / background consolidation.** Turn it explicitly off. Acabox runs the *non-tiny* regime, where the dream has `Edit` + `Write` + `rm` inside the memory dir and in-place rewriting is permitted; the tiny-mode immutability rule does not apply. It is instructed to delete facts contradicting `CLAUDE.md` — and Acabox ships a large workspace `CLAUDE.md`. Nothing distinguishes hand-authored bytes from generated ones. Revisit only when there is a pinning mechanism.

**A "recalled from memory" chip.** Zero `memory_recall` events across 7 real production transcripts. Rendering it would be a mock, and it would tell the user a story about how the system works that is not true here.

**Per-skill "health scores", invocation counts, or token-cost estimates.** Not measurable without fabrication. The one number that *is* measurable and *does* matter is the roster budget, from `getContextUsage()`.

**A second Hex skill for `hexRunHealth`'s REST-token path.** It is genuinely a different domain (Hex platform ops vs Redshift schema), but two skills for one vendor is more structure than one user needs. Make it a section of `coscientist-analytics` and split only if it grows.

**Refusing a `record_finding` write for any reason.** Not on similarity, not on validation. Always append, then relate. Losing a correction is the failure mode this whole feature exists to prevent.

**A Stop hook that enforces write-back.** It was considered. Enforcement turns a helpful protocol into a turn that cannot end, and the observable failure (queried Hex, read no ledger) is already catchable passively. Surface it; do not block on it.

**Skills for `differential-expression` and `academic-writing-agent`.** Both are dead — the template hardcodes `kernel: "ir"`, only `python3` is registered, and R cannot be installed on this machine. They will be on a browsable list in Phase 2. Delete them then, or banner them; do not ship a catalogue that advertises them as ready.

---

## 7. Prerequisites to verify before each phase

Nothing below is assumed inside a phase. Each is a specific, cheap check.

**Before Phase 0**
- **Does `skillListingBudgetFraction: 0.05` actually widen the roster?** Run a real turn and call `query.getContextUsage()`; assert `skills.includedSkills === skills.totalSkills` and that the longest description (`xlsx`, 945 chars) is not truncated. The formula is read from the binary, not executed. *(If the settings field is ignored, the fallback is the verified env var `SLASH_COMMAND_TOOL_CHAR_BUDGET`, which `o5_()` checks first and unconditionally.)*
- **Does the model actually volunteer a write-back mid-task?** The one-week Phase 0 measurement. This is the single unvalidated assumption the headline rests on.
- **Is `workspaces.directory_path` genuinely empty in the live production DB?** Migration 24 sets it to `''`, which would make the "Workspace Records" reset's stated `.academia/` deletion dead code — or an active memory-wiper if not. Needs a `scripts/`-style run; better-sqlite3 is built for Electron's ABI so plain node cannot open it.

**Before Phase 1**
- **Does the SDK skill loader key on the directory name or the frontmatter `name`?** 62 of 607 `openai/plugins` skills disagree. This decides whether the store id is the dirname (assumed) or the frontmatter name. One deliberately-mismatched fixture skill plus one real turn settles it.
- **Does the loader recurse into subdirectories of `.claude/skills`?** Decides whether imports can be namespaced on disk (`.claude/skills/openai/airtable-cli`) or must sit flat with collisions resolved by renaming.
- **Does a 31+ entry `Options.skills` allowlist drop anything silently?** The failure mode changes here: an unlisted skill goes from "runs anyway" to a hard `errorCode: 8` once bare `'Skill'` leaves `allowedTools`.
- **Name collisions across sources.** `openai/plugins` ships document skills alongside our own `docx`/`pdf`/`pptx`/`xlsx`. Product call, not technical: suffix the directory, refuse the import, or offer replace-builtin. Decide before the importer ships.
- **Is a GitHub PAT acceptable?** Moves the metadata budget from 60/hr to 5,000/hr and turns community-marketplace enumeration from 33.6 hours into 24 minutes. It would live in `secretStore.ts` beside the API key. Not needed for `openai/plugins` or `anthropics/skills` (zero API calls), so this is only a Phase-5 question — but answer it before building lazy marketplace resolution.

**Before Phase 2**
- **Does `files:revealInFinder` resolve a path inside the store?** `WorkspaceController.ts:51-53` lists `workspacePath`, user dirs and the drive cache — userData is not among them. Either reveal the workspace symlink (Finder follows it) or add the store to the allowed set. Untested either way.
- **Is `.../Knowledge Files - Context for LLMs/` actually reachable once shared?** It is a Google Drive CloudStorage path; confirm the agent can `Read` through it and that `syncWorkspaceSymlinks` does not reap the link.

**Before Phase 3**
- **Is a new relay MCP tool reachable, and does `applyConnectorsToSession` preserve it?** Add the server, run a real turn calling `record_finding`, then add a connector mid-session and call it again. The `setMcpServers` replacement trap has already killed relay servers once in this codebase.
- **Does the appended system-prompt routing rule actually beat the SDK's `# auto memory` section?** Plant a discoverable warehouse fact, run a real turn, and check *which* store the model writes to. If memory still wins, escalate to `CLAUDE_COWORK_MEMORY_GUIDELINES` — and note that replacing that section means restating the frontmatter template and the `MEMORY.md` index rule it currently supplies.
- **Does the host-maintained `MEMORY.md` sentinel block survive a model edit?** The CLI's own prompt teaches the model to append pointer lines to that file. Confirm the model appends outside the block rather than rewriting it, and that the host's boot rewrite does not clobber model-written lines.
- **Does `block-secret-reads.sh` permit reads under `<userData>/<channel>/skills/`?** Read this session: patterns are `cobuilding-settings.json`, `claude-config`, `.claude.json`, `agent.json`. The store path matches none — so `Read` of a findings file passes. Confirm once live, because a `Read` of the ledger is on the critical path for the `last_read` freshness signal.

**Before Phase 5**
- **Does `reloadPlugins()` pick up an *edit* to an existing `SKILL.md`, not just an add?** Only the add case was ever measured. The handler clears every skill cache, from which the edit case follows — but that is inference, and live apply depends on it.
- **Does the 5-minute `raw.githubusercontent` cache ever serve a marketplace.json naming a SHA GitHub has not yet published?** Unlikely to matter (codeload would 404 rather than serve wrong bytes) but untested.