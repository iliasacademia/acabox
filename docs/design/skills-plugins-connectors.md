# Skills, Plugins, and Connectors in Acabox

**Decision document — 2026-07-29. Recommendation, not yet approved or implemented.**

## Verification status of this document

Load-bearing claims were re-checked by hand after drafting. Confirmed:

- **Symlinked skill directories are accepted by the CLI loader.** The string
  `isDirectory()&&!D.isSymbolicLink())return` is present in
  `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` (50 hits for
  `isSymbolicLink` overall). This is the fact the whole architecture rests on.
- **`app.requestSingleInstanceLock()` appears nowhere in `src/`** (0 hits).
- **`'Skill'` is in `allowedTools`** at `AgentInfrastructureController.ts:248`;
  `settingSources: ['project']` at `:270`.
- **The root-level-symlink hazard is real.** `containerService.ts:220-227`
  unlinks any non-dot workspace-root symlink resolving outside the workspace —
  and skips dot-prefixed names at `:221`, which is why the render must live
  under `.claude/`.
- **The document-skill licence text is as quoted.** `skills/xlsx/LICENSE.txt`
  forbids retaining copies outside the Services, derivative works, and
  distribution to third parties. Those four skills are **174 of 255 files** and
  ~3.6 MB of the 4.7 MB payload.
- **`differential-expression` is dead**, and worse than described: the
  "does not run" warning is in the **body**, while the frontmatter description
  still reads as fully functional — so the listing cost is paid and the model
  can still be lured into activating it.
- **`academic-writing-agent`** carries 15 `mcp__ms-word__`, 9 `mcp__citeright__`
  and 3 `mcp__zotero__` references to servers this fork deleted.
- All five external registries exist (GitHub API): `openai/plugins`,
  `anthropics/skills`, `anthropics/claude-plugins-official` (Apache-2.0),
  `anthropics/claude-plugins-community` (Apache-2.0), `agentskills/agentskills`
  (Apache-2.0).

Corrected against the draft below:

- **`diff` is NOT an unused dependency** — `fileMonitorService.ts:14` imports
  `createPatch` from it. `react-diff-view` genuinely has zero importers. Both
  are declared, so the conclusion ("the diff UI is free") stands.
- `academic-writing-agent` measures **180 KB**, not 128 KB.
- The four document skills measure **~3.6 MB**, not 3.20 MB.

Not verified, and flagged in-place as phase prerequisites: that the Anthropic
bundled skills (`update-config` et al.) load in Acabox's agent server; that
`reloadPlugins()` picks up an *edit* rather than only an add; the three Phase 5
packaging questions.

---

## 1. Direct answers

### 1a. Plugin vs. skill vs. connector vs. MCP server

**In Anthropic's vocabulary** (from `claude.com/docs/connectors/overview`, `code.claude.com/docs/en/plugins`, and the installed SDK's `sdk.d.ts`):

| Term | What it actually is | Where it lives in the SDK |
|---|---|---|
| **MCP server** | The protocol-level thing. A process or HTTP endpoint that exposes tools over Model Context Protocol. | `Options.mcpServers` |
| **Connector** | An MCP server *plus its auth and its listing*. Anthropic's definition is broader than "remote MCP + OAuth" — it also covers first-party integrations, MCP Apps, and local MCPB bundles. Directory vs. custom connectors "run on the same MCP infrastructure — the runtime, transport, authentication and tool-calling code paths are identical"; the difference is review and discoverability. | Same option. There is no separate connector primitive. |
| **Skill** | A directory containing `SKILL.md`. Instructions and procedure. It grants no capability — it cannot reach anything the agent could not already reach. Identity is the **directory name**; frontmatter `name:` is a display alias only. | `Options.skills` (a context filter), discovered from the filesystem |
| **Plugin** | The *packaging* unit. A directory that may bundle `skills/`, `hooks/hooks.json`, `agents/`, `bin/`, `.mcp.json`, `monitors/`. Only `name` is required in `.claude-plugin/plugin.json`, and the manifest itself is optional. | `Options.plugins: [{type:'local', path}]` — `'local'` is the only accepted type at SDK 0.2.121 |

**Nesting, authoritatively:** `plugin ⊇ { skills, MCP servers, hooks, agents, bin }`. A skill and an MCP server are **peers inside a plugin**, not variants of each other. A connector is an MCP server with credentials and a listing. Anthropic's own guidance to partners is to ship *both*: "Most partners ship both a remote MCP server and a plugin that wraps it with skills."

**So: a plugin and a connector are not the same thing, and not even the same kind of thing.** A connector is *where Claude can reach*. A skill is *what Claude knows how to do*. A plugin is *a box that installs several of either as one unit*.

**What Acabox should call each thing in its UI — and this is a deliberate reduction, not a translation:**

- **Skill** → say "Skill." Keep the word. It is the open standard's word, it is what the model prints in chat, and it is what appears in `init.skills`.
- **Connector** → say "Connector." Already shipped, already correct, already matches Anthropic.
- **Plugin** → **do not say it at all.** Acabox has no plugin install story and, per section 5, is not going to have one. Exposing the word asks a scientist to learn a term that maps to no action they can take. `plugin-native`'s proposal claims plugin is "deliberately NOT user-facing vocabulary" while simultaneously making the plugin name the visible namespace prefix on every skill (`acabox:pdf`, `my:qpcr-protocol`) — you cannot hide a word that prefixes every row. We avoid that by not using plugin delivery for skills at all (section 2).
- **MCP server** → technical detail, surfaced only inside the connector detail view where the user already types a URL.

The one relationship the UI must make explicit, because nothing today does: **a skill can depend on a connector.** A skill declares `metadata.requires-connectors: "hex"` in frontmatter (`metadata` is a spec-legal string map, and the CLI tolerates unknown frontmatter keys — verified: an unrecognised key only fires a `tengu_frontmatter_shadow_unknown_key` telemetry event inside a try/catch). The Skills row then renders "Needs the Hex connector — not configured" with a link, and the Connectors row renders "used by 2 skills." This is checked against the real `listConnectors()`, not decoration. It is also the one place Acabox structurally beats the format it borrows from: 604 of OpenAI's 607 `SKILL.md` files name connector tools as unverifiable bare prose, because nobody there owns both halves. We own both halves.

**Answer to the question as literally asked:** in Acabox, a connector and a plugin are *not* the same, but the user will never be asked to care, because Acabox exposes exactly two nouns — Skills and Connectors — and plugin is an implementation detail of how we ship hooks.

---

### 1b. Is there an Anthropic equivalent of `github.com/openai/plugins`?

Yes — but it is **three separate registries with three different governance models**, not one repo.

| Registry | URL | Contents | Governance | License |
|---|---|---|---|---|
| **Agent Skills spec** | `https://agentskills.io/specification` · `https://github.com/agentskills/agentskills` | The `SKILL.md` standard itself. Frontmatter is tiny: `name` + `description` required (64 / 1024 char caps), plus optional `license`, `compatibility`, `metadata`, `allowed-tools`. | Independent org. "Originally developed by Anthropic, released as an open standard." ~45 adopting clients incl. Cursor, Codex, Gemini CLI, Copilot. | **Apache-2.0** (code) / **CC-BY-4.0** (docs) |
| **Anthropic's own skills** | `https://github.com/anthropics/skills` | Exactly **17** skills, plus `spec/`, `template/`, and a `.claude-plugin/marketplace.json` registering itself as `anthropic-agent-skills`. | Anthropic-curated. | **Split, per file.** 13 are Apache-2.0. The four document skills (`docx`, `pdf`, `pptx`, `xlsx`) carry a restrictive **source-available** `LICENSE.txt`. |
| **Official plugin marketplace** | `https://github.com/anthropics/claude-plugins-official` | **276** plugins. Categories: development 116, productivity 48, database 36, monitoring 19, security 17. Sources are mostly external and commit-pinned (142 `url`, 79 `git-subdir`, 53 relative, 2 `github`). Registered automatically on first interactive Claude Code launch. | Anthropic curates at its discretion. **No application process.** | Repo Apache-2.0; each plugin declares its own. |
| **Community plugin marketplace** | `https://github.com/anthropics/claude-plugins-community` | **2,283** plugins in a 1.5 MB `marketplace.json`. Read-only mirror of a review pipeline; entries are SHA-pinned and CI bumps the pin; the public catalog syncs nightly. | Automated screening, opt-in via `/plugin marketplace add`. | Per-plugin. |
| **Connectors Directory** | `https://claude.com/docs/connectors/directory` | Not a git repo. A catalog of MCP servers split into Anthropic-"verified" and "community." Size is not published; two community trackers disagree (841 vs 439). | Anthropic review. | N/A — nothing to vendor. |

**Which Acabox could adopt skills from today, plainly:**

- **`agentskills/agentskills`** — adopt the *spec*, not skills. Apache-2.0. Acabox should write its own skills to this spec (`name` + `description` required, `name` matching the directory) rather than to Claude Code's ~16-field superset, so they survive an SDK or harness change. Free, do it.
- **The 13 Apache-2.0 skills in `anthropics/skills`** (`algorithmic-art`, `brand-guidelines`, `canvas-design`, `claude-api`, `doc-coauthoring`, `frontend-design`, `internal-comms`, `mcp-builder`, `skill-creator`, `slack-gif-creator`, `theme-factory`, `web-artifacts-builder`, `webapp-testing`) — legally adoptable today with attribution. **My recommendation: adopt none of them.** They are web-design and Slack-shaped; Acabox's audience is scientists. Adding them would spend the skill-listing budget on things a bench scientist will never use.
- **The 4 document skills (`docx`, `pdf`, `pptx`, `xlsx`) — legally unresolved, and Acabox is already shipping them.** Their `LICENSE.txt` reads "© 2025 Anthropic, PBC. All rights reserved," and the ADDITIONAL RESTRICTIONS forbid users to "Extract these materials from the Services or retain copies of these materials outside the Services," "Create derivative works based on these materials," or "Distribute, sublicense, or transfer these materials to any third party." Acabox ships all 174 of their files inside a packaged Electron app via `extraResource` — i.e. it redistributes them — and this design would additionally put an **Edit** button on them, which is the definition of inviting a derivative work.

  These four are **77% of the entire skills payload** (3.20 MB, 174 of 255 files, mostly OOXML schemas). This is a legal question, not an engineering one, and it is an explicit **blocker on Phase 3** (the phase that first puts them on screen). Two outcomes: counsel says the API-consuming case is inside "the Services," and we ship with an Edit button; or counsel says no, and — per this project's stated preference for deleting whole vertical slices — **we stop shipping them**, which happens to remove three quarters of the payload. I do not recommend `git-backed`'s middle path of a `readonly` flag: it contradicts the stated requirement that users can modify prebuilt skills, for the four skills most likely to need modification, and it is an affordance the app admits it does not enforce (hand-editing still works).
- **The two plugin marketplaces** — do not wire them up. See section 5.

---

### 1c. The leaked Claude Code harness — what is worth learning, and the honest legal line

**What happened, briefly:** `@anthropic-ai/claude-code` v2.1.88, published 2026-03-30, shipped a ~59.8 MB `cli.js.map` source map exposing ~1,900 TypeScript files / ~512,000 lines. Root cause was a missing `*.map` exclusion compounded by Bun emitting source maps by default. Anthropic's statement: "No sensitive customer data or credentials were involved or exposed. This was a release packaging issue caused by human error, not a security breach."

**The legal line, stated without hedging: do not ingest, vendor, mirror, or consult the leaked source for Acabox.**

Anthropic filed DMCA notices within roughly 24 hours, disabling ~8,100 repos, then retracted to **one repo and 96 forks** after Boris Cherny confirmed the sweep had overreached into forks of Anthropic's own public repo. That is not a company that abandoned its copyright — it enforced it promptly and narrowed only the collateral damage. Accidental publication is not a license grant. Claude Code and the Agent SDK ship under "© Anthropic PBC. All rights reserved" (verified in `node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md`; `package.json` declares `"license": "SEE LICENSE IN README.md"`). Commercial Terms §D.4 bars accessing the Services "to build a competing product or service" and to "reverse engineer or duplicate the Services." Acabox is a commercial product shipping to users; provenance contamination is an asymmetric risk.

**And here is why that costs us nothing: everything architecturally useful is available legitimately, from three sources, and we have already used all three.**

1. **The published open standard.** Progressive disclosure is *specified*, not reverse-engineered: discovery loads name + description only; activation reads the full `SKILL.md`; execution loads bundled files on demand. `SKILL.md` bodies stay in context across turns once loaded, so every line is a recurring token cost.
2. **The official docs.** `code.claude.com/docs/en/skills` is more operationally detailed than most leak write-ups: the full frontmatter reference, discovery order (project skills load from `.claude/skills/` in the start directory and every parent up to repo root), the **1,536-character truncation cap** on `description` + `when_to_use` combined, `context: fork` subagent execution, `paths:` glob-scoped activation, `${CLAUDE_SKILL_DIR}` expansion.
3. **The CLI binary already in `node_modules`.** This team already set the precedent — the v0.1.6 OAuth root-cause was established from binary offsets in the shipped CLI, not from docs. I used the same method for this document and it settled two facts the proposals disagreed on:
   - The skill loader accepts symlinked directories. Verified string in `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`:
     ```js
     w.map(async(D)=>{if(!D.isDirectory()&&!D.isSymbolicLink())return;
       let j=kP.join(H,D.name), J=kP.join(j,"SKILL.md"), …})
     ```
     That is the *inclusive* form — a symlink is accepted, and the name is `D.name`, the **link's** name, not the target's basename. There is also a realpath dedupe (`function Me(H,_,q){let{resolvedPath:K}=H$(H,_);if(q.has(K))return!0;return q.add(K),!1}`) that protects against loading the same file twice through two paths. This is affirmative evidence that symlinked skill directories are a supported case, and it is the load-bearing fact under the architecture in section 2.
   - The allowlist predicate is `a$K(H,_){return H.name===_||Z5(H)===_||(H.aliases?.includes(_)??!1)}` wrapped by `r2H`, which additionally matches `q.name.endsWith(":"+K)`.

**Two immediately actionable lessons from the legitimate sources, neither of which requires the leak:**

- **Audit every `SKILL.md` description against the 1,536-character cap** on `description` + `when_to_use`. Anything past that is silently cut from the listing the model reads, so a skill whose trigger condition lives in the tail of a long description will never fire. Acabox's current total description payload is 10,193 chars across 21 skills; the largest single one is `xlsx` at 941, so nothing is currently truncated — but this becomes a real constraint the moment users start writing their own.
- **The packaging lesson applies to us directly.** Acabox ships `dist/agent-server.js` via `extraResource` and runs `npm run make`. Add a source-map check to the release verification that already inspects `Acabox.app/Contents/Resources`.

**What the leak has that legitimate sources do not:** unshipped features and internal flags (`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`, `ToolSearchTool`, coordinator-mode subagents, `undercover.ts`, `ANTI_DISTILLATION_CC`, 44 feature flags). All second-hand, all unverified, all describing code that is largely not shipped. That is precisely the material that is both legally hazardous and useless. There is no tradeoff here to agonise over.

---

## 2. Recommended architecture: **Pristine / Store / Render**

### The decision

**Adopt `overlay` (Pristine / Store / Render — symlink-composed).** Reject `plugin-native` and `git-backed` as whole designs; graft eleven specific things from them.

Skills stop being copied into the workspace and start being **linked** there. Bytes live in exactly one writable place per skill — a host-owned store at `<userData>/<channel>/skills/<id>/`. `<workspace>/.claude/skills/<id>` becomes an absolute symlink to it. The read-only shipped copy is never a link target and never written; it is a seed source, a revert source, and a hash reference.

### Why this one, over the alternatives

**1. It is the only design that preserves the path contract the agent is taught on every session.** I verified `src/cobuilding/CLAUDE.md` hardcodes `.claude/skills/` in two places:

> line 7: "To access skills: `.claude/skills/...`"
> line 35: "Skill scripts are located in the workspace at `.claude/skills/<skill-name>/scripts/`. Run them directly:"
> line 38: `<command> .claude/skills/<skill-name>/scripts/<script> <args>`

Seven skills ship `scripts/`, four of them the document skills a scientist touches most. `xlsx/SKILL.md:139` says `python scripts/recalc.py output.xlsx`, and `xlsx/SKILL.md:209` warns that skipping recalculation saves a file whose formulas are uncalculated strings. Both `plugin-native` and `git-backed` move skills out of `.claude/skills`; `git-backed` never lists `src/cobuilding/CLAUDE.md` as a modified file at all. Under the symlink render, `.claude/skills/xlsx/scripts/recalc.py` still resolves. **Zero content migration, zero prompt sweep, zero risk of a silently-missed reference.**

**2. It keeps skill names bare.** Plugin skills are namespaced `<plugin>:<skill>`. `main/ipc/reactions.ts:19-21`'s `DEFAULT_ACTIVITY_SUMMARY_PROMPT` invokes `activity-summary` and `reaction` by bare name, and a missed reference fails silently as the model simply not finding the skill. More importantly the namespaced name is what the model *prints in chat* — a scientist would see "I'll use the `my:qpcr-protocol` skill" and reasonably ask what `my:` means.

**3. The write-path problem is dissolved, not solved.** Because the render is a symlink, `open()` resolves the layer at write time. An agent `Edit`, a `Bash` heredoc, vim, TextEdit, and the Acabox UI all deposit bytes in the same inode. There is no second copy to reconcile and no sync direction to get backwards. I measured this on Node v25.9.0 against a real symlinked skill dir: write-through lands in the store; `rmSync(link, {recursive:true, force:true})` without a trailing slash unlinks and leaves the target intact.

**4. "Modified" is derived, not flagged.** `sha256(store file) !== baseline[relPath]`. Write-path-agnostic by construction, and self-healing when a user edits and edits back. No flag anyone can forget to set, no intent to infer.

**5. Its disable is the only real disable.** The SDK docstring is explicit that `Options.skills` is "a context filter, not a sandbox" — unlisted skills remain readable via `Read` and `Bash`. Under `plugin-native` and `git-backed`, a "disabled" skill sits on disk in a directory the agent can Grep, so a user who disables `academic-writing-agent` and later asks "what writing guidance do you have?" gets a confidently wrong turn about a skill they believe is off. Removing the symlink makes the content genuinely unreachable from cwd.

### What I grafted, and from where

| From | Graft | Why |
|---|---|---|
| `plugin-native` | **Per-*file* baseline hashes, not per-skill** | Decisive. One edited byte in `xlsx/SKILL.md` must not block upstream fixes to the other 53 files in that skill. Costs a map instead of a scalar. |
| `plugin-native` | **Repoint `syncMiniAppAssets` at the store** | **Mandatory.** Verified: `skills.ts:75` reads `path.join(getCobuildingSourceDir(),'skills','manage-mini-application','assets')`. Without this graft, a user edits `_reusable/useAppState.ts`, sees MODIFIED and a diff and a Revert button, and the next boot silently force-overwrites `.applications/_reusable` from pristine — a UI that positively asserts an edit took effect when it did not. |
| `plugin-native` | **`bin/acabox-install`, never `bin/install`** | Plugin `bin/` is prepended to the Bash PATH; a file named `install` shadows `/usr/bin/install` for every command the agent runs, breaking any makefile with an `install -m 755` rule. |
| `plugin-native` | **Treat the state file as a rebuildable cache** | The agent has Bash and the state file is in userData; it *will* be deleted or corrupted. Recovery: any store file whose hash equals the shipped hash is unmodified, anything else is modified. |
| `plugin-native` | **`rememberAgentSkills()` + one shared config builder** | The exact lesson `replaceConnectorAllowedTools` encodes. The live agent-server config and the crash-restart config must be computed by one exported function or a crash silently changes behaviour. |
| `git-backed` | **Hash the pristine tree at BOOT, not at build time** | The single cleanest idea in the set. It deletes the dev/packaged divergence CLAUDE.md already records as a trap: in dev the "shipped" tree *is* the git working tree, so a build-time manifest is stale the moment anyone edits a skill. ~10 ms for 255 files. One code path. |
| `git-backed` | **Generalise the reconciler over every provisioned path** | `.claude/CLAUDE.md`, `.claude/settings.json` and `.claude/hooks/` are force-overwritten by the identical mechanism at `skills.ts:187/123/171` with the identical silent-edit-destruction bug. Only this proposal noticed. |
| `git-backed` | **Conflicts as ActivityPanel "Needs attention" rows** | That surface already exists for "what happened while I wasn't looking," already has the compose-a-turn pattern, and it means an upgrade can never block a boot. |
| `git-backed` | **`requires-connectors` cross-links** | See 1a. |
| `git-backed` | **The reason git was rejected, verbatim into a code comment** | `/usr/bin/git` on macOS is a Command Line Tools shim: on a machine without CLT it exists, is executable, and fails with `xcrun: error: invalid active developer path`. Making skill provisioning depend on it recreates exactly the boot-brick class this work exists to remove. |
| Critiques | **Atomic writes via `main/manifestIO.ts` + `app.requestSingleInstanceLock()`** | `manifestIO.ts` already exists and was written for this exact class of bug ("observed live: `tool:opened` minted a fresh manifest over a fully populated one"). `grep -rn requestSingleInstanceLock src/` returns **zero hits** — two concurrently-booting instances share one userData channel today. |
| Critiques | **Version-check on editor save, reusing the conflict UI** | Closes a silent lost-update the first time someone edits a skill in the panel while asking the agent to edit it. |
| Critiques | **Reconcile is a gate `agentInfrastructure.start()` awaits** | Otherwise the CLI can read a half-copied `SKILL.md` mid-fast-forward, silently drop that skill for one chat, and produce an unreproducible "sometimes it forgets the skill." |

**What I explicitly did not graft:** plugin delivery for skills. `plugin-native`'s strongest argument is `strictPluginOnlyCustomization: ['skills']`, which is measured to strip every filesystem-sourced skill while sparing plugin ones — the only lever that stops a skill hiding in a shared research folder. I am giving that job to the **explicit `Options.skills` allowlist** instead (Phase 2), which rejects off-list names at the Skill tool with `errorCode: 8`. That defends the same attack for a fraction of the cost and without renaming every skill. Plugins get a narrower, better job: shipping hooks and `bin/` out of the agent-writable workspace (Phase 5), where there are no user-visible names to namespace.

### Disk layout — real paths

**Layer P — pristine. Read-only. Never written by Acabox.**
```
dev:       /Users/iliasbeshimov/Documents/Dev Folders/Acabox/src/cobuilding/skills/<id>/
packaged:  /Applications/Acabox.app/Contents/Resources/skills/<id>/
```
Resolved by the existing `getCobuildingSourceDir()` (`src/cobuilding/main/skills.ts:5-10`), already shipped by `forge.config.js:120-128`. All 255 packaged files are in `_CodeSignature/CodeResources`, so writing here breaks `codesign --verify --strict` and is destroyed wholesale by `selfUpdater.ts:249-254`'s bundle `mv`. Treating it as read-only is not policy, it is the only correct treatment.

**Layer W — the store. Writable, host-owned, survives workspace deletion.**
```
~/Library/Application Support/acabox/<channel>/
├── cobuilding-settings.json      unchanged (connectors + encrypted API key)
├── skills-state.json             NEW — the index
├── skills/                       NEW — the store
│   ├── acabox/SKILL.md
│   ├── xlsx/{SKILL.md, scripts/recalc.py, …}
│   └── my-lab-protocol/SKILL.md  custom — no Layer P counterpart
├── skills-trash/                 NEW — pre-revert forks, GC'd at 30d
│   └── xlsx-20260729T144412Z/
├── claude-config/                unchanged
└── workspace-data/               the workspace
```
`skills-state.json` is a separate file, not a key in `cobuilding-settings.json`, because that file holds the `safeStorage`-encrypted API key and connector headers and a skill edit must never be a reason to rewrite it. `skills-trash/` is a *sibling* of `skills/`, not inside it, so the renderer never tries to link it.

**Layer R — the render. Zero bytes. Rebuilt every provision.**
```
~/Library/Application Support/acabox/<channel>/workspace-data/.claude/
├── CLAUDE.md          reconciled (was: force-copied)
├── settings.json      reconciled (was: force-copied)
├── hooks/             reconciled (was: force-copied)
└── skills/
    ├── acabox  -> /Users/…/acabox/<channel>/skills/acabox        [absolute, 'dir']
    ├── xlsx    -> /Users/…/acabox/<channel>/skills/xlsx
    └── my-lab-protocol -> /Users/…/acabox/<channel>/skills/my-lab-protocol
    (differential-expression absent — disabled, so no link)
```

**Note the render is under `.claude/`, deliberately.** `git-backed` put its link at the workspace *root* (`<workspace>/skills`). I verified two independent reasons that is fatal: (1) `containerService.ts` syncWorkspaceSymlinks' reaper is `if (!e.isSymbolicLink()) continue; if (e.name.startsWith('.')) continue; if (expected.has(e.name)) continue;` then unlinks anything resolving outside the workspace — a root-level `skills` link matches every condition and is deleted on **every** `containerService.start()`; (2) `FilesTab.tsx:39-41`'s `isHiddenWorkspaceEntry` hides only `~$` and `.` prefixes, so it would put 255 files and 3.2 MB of OOXML schemas into the Home Drive FILES count — reintroducing the exact "Home says no files but I have files" bug fixed on 2026-07-24. Both are avoided by keeping the links under the dot-directory, at zero cost.

**New source files**
```
src/cobuilding/shared/skills.ts                       types, SKILL_ID_PATTERN, RESERVED_SKILL_IDS,
                                                       frontmatter parse (name+description+metadata),
                                                       validateSkillId, buildSkillRuntimeConfig()
src/cobuilding/main/skillHash.ts                       hashFile(), hashTree(), pristine manifest at boot
src/cobuilding/main/skillStore.ts                      reconcile/read/write/create/delete/revert/
                                                       setEnabled/restoreAllBuiltins
src/cobuilding/main/skillRender.ts                     renderSkills(workspaceDir)
src/cobuilding/main/mcpServers/skillsMcpServer.ts      host handlers for the 4 agent tools
src/cobuilding/renderer/components/extensions/
  ExtensionsPage.tsx | SkillsList.tsx | SkillDetail.tsx | SkillDiff.tsx | extensions.css
src/cobuilding/skills/managing-skills/SKILL.md         teaches the agent the store
src/cobuilding/shared/__tests__/skills.test.ts
src/cobuilding/main/__tests__/skillStore.test.ts       skills.ts has ZERO tests today
src/cobuilding/main/__tests__/skillRender.test.ts
```

**Modified source files**
```
src/cobuilding/main/skills.ts             DELETE copySkillsToWorkspace + the SKILLS array +
                                          the duplicated inline defaultSettings (skills.ts:122-156).
                                          syncMiniAppAssets reads the STORE, not pristine.
                                          Every step try/caught and logged (currently zero log calls).
src/cobuilding/main/index.ts              skills:* IPC, pushSkillsToAgent(),
                                          app.requestSingleInstanceLock(), reconcile gate
src/cobuilding/main/preload.ts            window.skillsAPI
src/cobuilding/renderer/types.d.ts        SkillsAPI, SkillDescriptorT, SkillMutationResultT
src/cobuilding/renderer/index.tsx         Extensions rail tab
src/cobuilding/renderer/components/DirectoryPermissions.tsx
                                          Connectors section → link to Extensions
src/cobuilding/agent-server/index.ts      POST /reload-skills; 4 skill tools on the workspace relay;
                                          log init.skills + init.plugins; pass Options.skills
src/cobuilding/agent-server/sessionConfig.ts   AgentConfig.skills?: string[]
src/cobuilding/main/containerService.ts   reloadAgentSkills(), rememberAgentSkills()
src/cobuilding/main/controllers/AgentInfrastructureController.ts
                                          skills: buildSkillRuntimeConfig(); drop bare 'Skill'
src/cobuilding/CLAUDE.md                  unchanged paths — but add the store path + revert rules
package.json                              add js-yaml ^4.1.0 + @types/js-yaml (present transitively
                                          at 4.1.1, not declared). Descriptions are multi-line;
                                          a hand-rolled frontmatter parser is not viable.
```
`diff ^8.0.4` and `react-diff-view ^3.3.2` are **already declared with zero importers** — the diff UI is free.

### The revert model, in exact mechanical detail

**What is stored where.** Pristine bytes: only Layer P, never duplicated. Working bytes: only `W/<id>`. The link between them: a **per-file** baseline in `skills-state.json`.

```jsonc
{
  "version": 1,
  "seededAppVersion": "0.1.6",
  "pristineRootHash": "sha256:…",        // triggers reconcile in dev without a version bump
  "skills": {
    "xlsx": {
      "origin": "builtin",
      "enabled": true,
      "removed": false,
      "baseline": {                       // relPath -> sha256 of the PRISTINE bytes we last wrote
        "SKILL.md": "sha256:ab12…",
        "scripts/recalc.py": "sha256:cd34…"
      },
      "dismissed": { "SKILL.md": "sha256:ef56…" }   // "keep mine", per file, per release
    },
    "my-lab-protocol": { "origin": "custom", "enabled": true, "createdAt": "2026-07-29T…" }
  }
}
```

There is no `modified` field.

**`hashFile`** is plain sha256 of the bytes. **`hashTree(dir)`** is sha256 over, for every file sorted by POSIX-relative path: the path string, a NUL, the file's sha256, and one byte for `mode & 0o111 ? 1 : 0`. Paths are included so a rename registers; the exec bit so `chmod +x scripts/*.py` registers. Symlinks inside a skill dir hash as their `readlink` target. mtime and inode are deliberately excluded, so `touch` is not a modification. Files over 5 MB fall back to size + mtime so a dataset dropped inside a skill dir cannot stall boot.

**Derivations, computed never stored:**
- `modifiedFiles(id)` = every `rel` where `hashFile(W/<id>/<rel>) !== baseline[rel]`, plus every baseline path missing from the store, plus every store path absent from baseline (a user-added file inside a shipped skill).
- `modified(id)` = `origin === 'builtin' && modifiedFiles(id).length > 0`.
- A custom skill has no baseline, so `modified` is *undefined* and the UI shows no chip — the honest rendering of "there is nothing to compare against."

**`revertFile(id, rel)`**
1. Assert `origin === 'builtin'` and `existsSync(P/<id>/<rel>)`. If pristine is gone, refuse with a real message. There is nothing to revert *to*, and fabricating one would be a mock.
2. `rename(W/<id>/<rel> → skills-trash/<id>-<ISO8601>/<rel>)`. Never a bare delete — the user may want one paragraph back.
3. `cpSync(P/<id>/<rel> → W/<id>/<rel>)`. Safe by construction: the destination was just renamed away, so `cpSync` writes into nothing and cannot hit the `EACCES` / `ERR_FS_CP_DIR_TO_NON_DIR` classes that brick boot today.
4. `baseline[rel] = hashFile(P/<id>/<rel>)`; `delete dismissed[rel]`.
5. `renderSkills()` (idempotent), then `pushSkillsToAgent()`.

**`revertSkill(id)`** = `rename(W/<id> → skills-trash/<id>-<ts>)`, `cpSync(P/<id> → W/<id>)`, rebuild the whole baseline map from pristine hashes, clear `dismissed`, clear `removed`. Files the user *added* inside the skill go to trash with the rest — stated verbatim in the confirm dialog.

**`restoreAllBuiltins()`** = for every id where `origin === 'builtin'`: clear `removed`, set `enabled: true`, and `revertSkill(id)` if modified. It iterates `state.skills` filtered by origin, so it is **structurally incapable** of touching a custom skill — the guarantee comes from the data model, not from care in the loop. The confirm dialog quotes real counts computed before the call: *"Reverts 3 modified built-in skills and restores 1 you removed. Your 4 custom skills are not affected."* Disabled with *"Everything already matches what shipped"* when both counts are zero.

**Deleting.** A custom skill: rename to trash, drop the state entry, re-render. A built-in: `removed = true`, rename to trash, re-render — the entry survives so `restoreAllBuiltins` can bring it back and so the seeder does not immediately re-seed it. The UI verbs differ ("Delete" vs "Remove") because the operations differ.

**Unknown directories in the render target are adopted, never pruned.** This is the deliberate inversion of `skills.ts:54-64`, which today `rmSync`s recursively and silently. When `renderSkills` finds a real directory (not a symlink) at `<ws>/.claude/skills/<name>`: if `hashTree` equals the pristine tree hash of a built-in of the same name, it is a pre-migration byte copy — delete it with a log line. Otherwise `rename` it into the store as `origin: 'custom'` (suffixed `-recovered-N` on collision), register, link. One rule covers both the one-time migration and the ongoing case of an agent that made a skill with `mkdir`. **Nothing is ever silently destroyed.** This is the graft that `plugin-native`'s unconditional `rmSync <workspace>/.claude/skills` and `git-backed`'s "empty and then remove" both need and neither has: as written, both destroy a just-created custom skill on the very upgrade that promises to protect edits.

### How app upgrades interact with local edits

`selfUpdater.ts` `mv`s the whole bundle, so Layer P is wholly new and nothing under `<userData>` is touched. On the next boot, `reconcile()` runs when `state.seededAppVersion !== app.getVersion()` **or** `state.pristineRootHash !== hashTree(P)` (the second clause is what makes a dev `git pull` behave identically to a release). It runs **after** `createMainWindow()`, inside its own try/catch, and `agentInfrastructure.start()` awaits its completion promise — the same way `containerService.start()` already awaits `prewarmLoginShellPath()`.

Per file, from three hashes: `baseline[rel]` (B), `hashFile(P/<id>/<rel>)` (Pn), `hashFile(W/<id>/<rel>)` (Wn).

| B | Pn | Wn | Action |
|---|---|---|---|
| B | B | B | no-op — the 99% case |
| B | B | ≠B | keep. Skill reads MODIFIED. |
| B | B | missing | keep deleted; skill reads MODIFIED |
| B | ≠B | B | **fast-forward**: write Pn; `baseline[rel] = Pn`. Silent, one log line. |
| B | ≠B | ∉{B,Pn} | **CONFLICT.** Keep the user's file. `updateAvailable[rel] = Pn`. Never merge. |
| B | ≠B | missing | conflict (`user-deleted-and-changed`); stays deleted, surfaced |
| — | Pn | missing | new file upstream → write; `baseline[rel] = Pn` |
| — | Pn | present | user created a file at a path upstream now ships → conflict |
| B | — | B | dropped upstream and untouched → delete; drop the baseline entry |
| B | — | ≠B | dropped upstream but edited → **keep**, drop the baseline entry, flag orphaned |

Skill-level outcomes:
- **New built-in in a release** — no state entry, ordinary seed path: copy, register, link, enabled.
- **Built-in dropped in a release** — if no file is modified, remove from store and state with a log line. If any file is modified, **keep it**: retag `origin: 'custom'`, `formerlyBuiltin: true`, clear baseline. The user's edits are theirs; Anthropic dropping a skill from our tree is not consent to delete their work. This is precisely the case today's prune loop gets catastrophically wrong.
- **Downgrade** — reconcile compares hashes, never version numbers, so an older shipped file is just a `changed-upstream` row. Version strings are labels here, never logic.

The three conflict actions, all non-destructive:
- **Show me the difference** — a two-way diff of `W/<id>/<rel>` against `P/<id>/<rel>`, honestly labelled as two-way. The *old* pristine bytes are gone; we do not fake a three-way merge view.
- **Take the new version** — literally `revertFile(id, rel)`. Same code path, so the fork goes to trash and is recoverable. One implementation, no second way to lose an edit.
- **Keep mine** — `dismissed[rel] = Pn`. The chip clears and does not return until the *next* release changes that file again.

**The `SKILLS` array is deleted.** Membership becomes `readdir(P)`. This alone removes a class of boot failure: an entry with no shipped directory currently throws `ENOENT` out of `provisionWorkspace` at `index.ts:744`, two lines above `createMainWindow()` at `:746`, producing an app with no window and a raw `ENOENT` dialog that never mentions skills.

**The dev/packaged asymmetry becomes benign.** Today, editing "the shipped skill" means a git working-tree change in dev and a code-signature break when packaged — two entirely different failure modes from one user action. Under this design both write to the store and Layer P is read-only in both.

### How the SDK is configured

`cwd: getWorkspaceRoot()` (`agent-server/index.ts:464`) and `settingSources: ['project']` (`AgentInfrastructureController.ts:270`) are **unchanged**. Verified in the CLI: the project scanner `p28` `statSync`s `.claude/skills` (which follows symlinks) and `ydH` reads it with the `isDirectory() || isSymbolicLink()` guard quoted in 1c, taking the **dirent's** name. So the render controls skill identity and no SDK option changes for Phase 1. A dangling link degrades safely — `readFile(link/SKILL.md)` returns ENOENT and the loader returns, so a broken store entry is an absent skill, not a crash.

**`settingSources` stays `['project']`.** Adding `'user'` would light up `<CLAUDE_CONFIG_DIR>/skills` — already in userData, already outside every sweep, tempting — but it also pulls in that tier's `settings.json`, and the research could not trace which file that resolves to once `CLAUDE_CONFIG_DIR` is redirected. Untraced settings inheritance in an app whose `.claude/settings.json` carries the install-blocking and secret-blocking hooks is not a trade worth making for a directory we can reach by symlink.

**`Options.skills` (Phase 2).** `AgentConfig` gains `skills?: string[]`, computed by the single exported `buildSkillRuntimeConfig()` used by **both** `AgentInfrastructureController.start()` and `containerService.rememberAgentSkills()`. The value is **every id in the store, enabled or not** — not just the enabled subset. Enablement is enforced by the symlink's absence from disk; the allowlist has a different job:

1. **Suppress the 7–8 Anthropic bundled skills** that load unconditionally today and survive even `settingSources: []`: `update-config`, `fewer-permission-prompts`, `debug`, `simplify`, `batch`, `loop`, `claude-api`, `keybindings-help`. `update-config`'s entire purpose is to get the agent to rewrite `settings.json` — the file holding Acabox's install-blocking and secret-blocking hooks. This is a correctness fix, not tidying, and it ships before any UI. Keep `claude-api` via an explicit `BUNDLED_ALLOW` in `shared/skills.ts`; it is genuinely useful to a scientist debugging an API call.
2. **Reject any skill we did not put there.** The CLI's project walk climbs ancestors of cwd and a separate walker climbs from touched files. A `.claude/skills` inside a user's shared research folder is therefore reachable. With an explicit allowlist, such a skill is refused at the Skill tool with `errorCode: 8, "is not in this session's skills allowlist"`. This is the defence `plugin-native` wanted `strictPluginOnlyCustomization` for, at a fraction of the cost.

Two real costs, both accepted: passing an array replaces blanket `Skill` auto-approve with per-skill `Skill(<name>)` entries in `--allowedTools`, so **remove bare `'Skill'` from `AgentInfrastructureController.ts:248`** and the list must be complete; and the allowlist is fixed at session create and survives `reloadPlugins()`, so a skill *created* mid-turn cannot fire in that chat. Listing the whole store rather than the enabled subset shrinks the second to genuinely-new skills only.

**Hot reload.** New `POST /reload-skills` on the agent server, shaped exactly like `POST /connectors` (`agent-server/index.ts:776-820`): rewrite `currentConfig.skills` **and** iterate live sessions calling `queryInstance.reloadPlugins()`, tolerating per-session failure. Rewriting `currentConfig` is not optional — omitting it reproduces the connector bug already in CLAUDE.md verbatim ("`POST /connectors` updated `mcpServers` but never `allowedTools`, so `mcp__hex` was absent for the running server's entire 12h life"). Host side: `containerService.reloadAgentSkills()`, 15s timeout, addressed to the `127.0.0.1` **literal** — not `localhost`, which can resolve `::1` first and which the connector work found wrong at four call sites.

Honest note for the code comment and the UI copy: because the host destroys a session at every turn end, at reload time there is usually **no live session at all** and `pushed` is normally `false`. That is correct, not a bug. Every mutation IPC returns `{...result, pushed}` so the UI says "Applied to your open chat" or "Applies to your next chat" without inventing either.

**Assert, do not assume.** Every `system`/`init` message carries `skills: string[]` and `plugins: {name,path,source}[]`. Log both at session create in `agentSession.ts` and diff `init.skills` against the array we requested; persist the result the way `recordConnectorStatus` does. A requested-but-absent skill becomes a log warning and an observed `NOT LOADED` chip. This is the only honest liveness signal a skill has, and it is what catches a bad path, malformed frontmatter, or an SDK behaviour change on upgrade — the SDK skips a missing plugin path silently and the session continues, so without this a mispackaged build looks identical to a working one.

### How the agent itself modifies a skill

**The safety net is the symlink.** Any `Edit`, `Write`, or `Bash` redirect against `<ws>/.claude/skills/<id>/…` lands in the store, correctly, with no cooperation required. That is what makes the whole thing robust, and it means every one of the 21 shipped skills' existing relative-path conventions keeps working.

**The paved road is four tools on the existing workspace relay MCP server** (`agent-server/index.ts:283`, already registered):

- `mcp__workspace__list_skills` → `[{id, origin, enabled, modified, description, path}]`
- `mcp__workspace__write_skill_file(id, relPath, content)` — writes into `W/<id>`, creating it as `origin:'custom'` if new; rejects `..`, absolute paths, and ids failing `SKILL_ID_PATTERN`; re-renders; fires the reload
- `mcp__workspace__revert_skill(id)`
- `mcp__workspace__delete_skill(id)`

Add all four explicitly to `allowedTools` alongside the existing `mcp__workspace__get_scanned_files` / `get_research_profile`.

They exist for four things raw `Edit` cannot do: a *new* skill lands in the store rather than as a bare workspace directory awaiting adoption; `skills-state.json` stays consistent immediately; the reload fires without a restart; and the host gets a log line and a UI event saying "the agent changed skill X" — the difference between a self-improving mechanism the user trusts and one that edits itself behind their back. `revert_skill` in particular is why this is not optional: a scientist who says *"PDF extraction is broken, undo whatever you changed"* is typing into **chat**, not Settings, and without a revert tool the agent's only available move is to write more and compound the damage. `git-backed` omits this entirely.

A new shipped skill, `src/cobuilding/skills/managing-skills/SKILL.md`, teaches: where the store is, that shipped-skill edits are revertible so it should be bold, that new skills are the user's and are never reconciled, the frontmatter contract (directory name is the name), and the one non-obvious constraint — **a newly created skill is not usable in the chat that created it.**

Deliberately **not** gating raw `Edit` behind the tool. With no `canUseTool` handler anywhere in the app, a gate would be theatre; the symlink already makes the ungated path correct.

### The UI surface

**One destination: a new `Extensions` rail tab, between Tools and Files.** Not a Settings subsection. A scientist will not open Settings hunting for a concept they do not know exists, and the requirement explicitly asks for a browse surface. `ConnectorsSettings.tsx` moves here **verbatim** — it is already a self-contained 556-line component with its own token-based CSS — with a one-line link left in Settings so the existing path is not broken.

**Two inner tabs: `SKILLS` | `CONNECTORS`.** Not three. `overlay` proposed a Plugins tab whose entire content until a later phase is a paragraph explaining why the user cannot use plugins — zero available actions, contradicting both the "delete whole slices" directive and the no-mocks spirit of hiding an element rather than showing an empty one. Deleted.

Above the tabs, one sentence that answers the taxonomy question where the user actually asks it:

> *Skills are instructions Claude can follow. Connectors are logins to outside services. A skill can tell Claude to use a connector, but only you can add one.*

**Skills list.** Rows reuse the `.connectorRow` / `.connectorDot` / `.connectorBtn` vocabulary so it reads as one system. Grouped **Yours** then **Built in**, each with a real count and a filter input over id + description. Per row: status dot, mono skill id, provenance chip, state chips, one-line frontmatter description, actions (Disable · Review · Revert, the last only when modified).

State chips, and **nothing appears that is not measured:**
- `MODIFIED` — any file's hash differs from its baseline
- `UPDATE AVAILABLE` — a shipped change collided with a local edit
- `DISABLED` — not linked into the render
- `NOT LOADED` — the id was absent from the last session's `init.skills`. Rendered **only** once we have observed a session; before that, no liveness chip at all — exactly as a connector reads "Unknown" rather than a fabricated "Connected."
- `NEEDS <CONNECTOR>` — `metadata.requires-connectors` names a connector not in `listConnectors()`
- `BROKEN FRONTMATTER` — unparseable. The row still renders with its id rather than being silently dropped, *because the CLI drops it silently and that silence is exactly what this surface exists to break.*

An unmodified, enabled, loaded built-in shows **no chips**, so any chip means something genuinely happened — the same discipline the tool-status rewrite settled on. Group header carries **Restore all built-in skills**.

**Skill detail** — a modal reusing the `FileViewer` shell already reused outside the Files tab by ToolsPage's saved-data viewer:
- File tree (most skills are one file; `docx`/`pptx`/`xlsx` are 49–59)
- **Read** — `MarkdownView`, existing Rendered/Source toggle, free
- **Edit** — a dirty-tracked `<textarea className="wsSettings__textarea">` with Cancel/Save, the established Settings pattern (SOUL.md, `DirectoryPermissions.tsx:46-84`). **Markdown only.** `scripts/*.py` gets Reveal in Finder, not an editor. Mounting CodeMirror for a markdown file is scope this feature does not need, and shipping a half-featured Python editor is worse than shipping none.
  - **Version check on save**: hash at open, re-hash at save; on mismatch show the same keep-mine / reload / diff affordance the upgrade path already builds. Closes the lost-update that happens the first time someone edits a skill in the panel while asking the agent to edit it.
- **Changes** — `createTwoFilesPatch()` from `diff` rendered by `react-diff-view` (both already declared, both currently unused). Per-file Revert.
- **Ask Claude to change this skill** — composes a chat turn naming the skill, its store path, and its description, reusing the "Ask Claude to fix it" pattern from `ActivityPanel`. *This is the self-improvement affordance* and it belongs one click from the skill, not buried in a chat the user has to phrase themselves.
- **Reveal in Finder** → the **store**, never the workspace symlink. Header carries a selectable absolute store path plus the sentence *"This is the same file Claude sees at `.claude/skills/<id>/`"* — one line that defuses the only real confusion the symlink creates.

**Conflicts** never modal, never block boot: a row in ActivityPanel's existing *Needs attention* section — *"3 built-in skills were updated, but you had edited them"* — plus a count badge on the Extensions rail tab.

**New skill** scaffolds `W/<id>/SKILL.md` with valid frontmatter validated against `SKILL_ID_PATTERN`, then opens the editor. Copy for a newly *created* skill is specifically *"Available in your next chat"* — the allowlist is fixed at session create and pretending otherwise is a lie the user catches within a minute.

**Degraded states are shown, not hidden.** If reconcile failed at boot the tab shows the real error and a Retry, not an empty list.

---

## 3. Failure modes I am deliberately accepting

**1. `rm -rf .claude/skills/<id>/` — with the trailing slash — resolves through the link and empties the store copy.** Measured: without the slash it merely unlinks and the target survives. For a built-in this self-heals at the next reconcile; for a custom skill only `skills-trash/` saves it, and only if the delete went through the UI. *Accepted* because the alternative is a sandbox we cannot build: with unrestricted Bash and no `canUseTool` handler anywhere in the app, any guard is a guardrail against incidental damage rather than a boundary. A `PreToolUse` matcher refusing `rm -rf` under `.claude/skills` goes in beside `block-secret-reads.sh` with that caveat stated in the same language CLAUDE.md already uses for the existing hooks.

**2. Content-hash modification detection is occasionally surprising.** A trailing-newline change, a CRLF conversion, or an editor reformat all read as MODIFIED and offer a Revert. *Accepted* — the alternative is a flag someone forgets to set, which is unfixable rather than merely surprising. The per-file Changes tab is the antidote, and it will get at least one "why does it say modified, I didn't change anything" report.

**3. A skill created mid-conversation cannot be used in that conversation.** `Options.skills` is fixed at `initialize` and survives `reloadPlugins()`. *Accepted* — it is unavoidable within the SDK surface, it is mitigated by passing the whole store rather than the enabled subset (so only genuinely-new skills are affected), and it makes *editing* a much better loop than *creating*, which is the more common self-improvement case anyway. It is stated in the UI copy and in `managing-skills/SKILL.md`.

**4. `reloadPlugins()` buys much less than the SDK surface suggests.** Because the host destroys a session at every turn end, it only matters for same-turn edit-then-use and pinned sessions. *Accepted* — it is ~20 lines and worth it, but the correctness mechanism is that the next turn is a new `query()` that re-reads disk. Nobody reading this should expect more.

**5. Symlinks are POSIX.** Acabox is arm64-macOS-only, so this costs nothing today, but it is a real constraint on a future Windows port: junctions behave differently and the CLI's `isSymbolicLink()` dirent guard may not fire the same way. *Accepted* and recorded here so it is a known cost rather than a discovery.

**6. Adopting unknown workspace directories accumulates debris.** An agent that scribbles a directory into `.claude/skills` permanently acquires a custom skill. *Accepted* — strictly better than today's silent recursive delete — with the filter input and an easy Delete as the mitigation.

**7. The docx/pdf/pptx/xlsx licence question is not solved by any architecture.** *Not accepted, escalated.* It is an explicit blocker on Phase 3, with a named engineering fallback (stop shipping them) if the answer is no.

---

### Failure modes I am designing around

**A. Downgrade brick.** Measured on Node v25.9.0 — and note the `overlay` proposal cited the wrong code: `fs.cpSync` of a directory onto an existing symlink throws **`ERR_FS_CP_DIR_TO_NON_DIR`** ("Cannot overwrite non-directory … with directory"), not `ERR_FS_CP_EINVAL`. An old build's prune loop filters `entry.isDirectory()`, which is **false** for a symlink dirent (measured), so the links survive the prune and then blow up the copy, two lines above `createMainWindow()`.

Designed around in two ways, both in Phase 0, shipped in its own release:
- Per-step try/catch around every provisioning step. A Phase-0 build opened against a Phase-1 workspace then catches the throw, logs it, continues to `createMainWindow()` — and *still works*, because it reads skills through the surviving symlinks.
- A three-line forward-compat shim in `copySkillsToWorkspace`: `if (lstatSync(dest).isSymbolicLink()) { log.info(...); continue; }`. A shim for an unshipped feature is normally a smell; this one turns "degrades with an error in the log" into "clean," and the comment says exactly why.

Anyone downgrading *past* the Phase-0 release still bricks and must delete `<workspace>/.claude/skills` by hand. That goes in the release notes, stated plainly, rather than being discovered in a support thread.

**B. `syncMiniAppAssets` reading pristine while the UI claims the edit landed.** Repointed at the store in Phase 1. Also add a boot assertion that `.applications/_bridge` exists after provisioning — this path is how `git-backed` would have silently broken every mini-app build on fresh installs.

**C. Torn state files and two concurrent instances.** Every `skills-state.json` write goes through `main/manifestIO.ts`'s temp-file + rename and its per-path serialized queue. Plus `app.requestSingleInstanceLock()`, which is absent from the entire tree today and is a latent hazard well beyond skills. Plus the rebuild-from-hashes recovery path, so a corrupted state file degrades to "we recompute" rather than "we re-seed and lose the fork."

**D. Half-copied `SKILL.md` read mid-reconcile.** `agentInfrastructure.start()` awaits a `reconcileComplete` promise before spawning.

**E. Live/crash-restart config divergence.** One exported `buildSkillRuntimeConfig()`, used by both, with a jest case asserting they compute an identical array.

**F. A skill hiding in a user's shared research folder.** The explicit `Options.skills` allowlist rejects it at the Skill tool with `errorCode: 8`.

---

## 4. Phased implementation plan

Verification standard for every phase: `npx tsc --noEmit` clean; `npx jest` no worse than the current 245/246 (only the pre-existing `fileMonitorIntegration` may fail); `npm start -- -- --smoke-test` exits 0 — and note the smoke test **does** exercise provisioning, unlike the agent server, because it quits at `index.ts:833`, well after `:744`.

---

### Phase 0 — Boot hardening. Ships **alone**, in its own release.

**Files:** `src/cobuilding/main/skills.ts`, `src/cobuilding/main/index.ts`

- Wrap each of the five steps in `provisionWorkspace` in its own try/catch that logs and continues. Today the whole function sits two lines above `createMainWindow()` with no local catch, and three ordinary user actions — `chmod 444` to protect an edit (`EACCES`), replacing a skill dir with a note file (`ERR_FS_CP_DIR_TO_NON_DIR`), a missing source dir (`ENOENT`) — each produce an app that never opens a window.
- Add logging. `grep -c 'log\.' src/cobuilding/main/skills.ts` returns **0** today, which is why "my skill edit vanished" is currently undiagnosable from `cobuilding.log`.
- Delete the hardcoded `SKILLS` array in favour of `readdir(pristineDir)`. Removes the `ENOENT` brick outright.
- The three-line symlink skip in the copy loop (forward-compat shim for Phase 1's downgrade).
- `app.requestSingleInstanceLock()`.

**Verified:** tsc, jest, smoke. Plus a manual reproduction of all three brick scenarios against a real `npm start`, each now producing a log line and a window. This must be a separate release — it is the version of headroom.

---

### Phase 1 — Store, render, reconciler. No UI.

**Create:** `shared/skills.ts`, `main/skillHash.ts`, `main/skillStore.ts`, `main/skillRender.ts`, `main/__tests__/skillStore.test.ts`, `main/__tests__/skillRender.test.ts`, `shared/__tests__/skills.test.ts`
**Modify:** `main/skills.ts` (delete `copySkillsToWorkspace` and the duplicated inline `defaultSettings` at `:122-156`; repoint `syncMiniAppAssets` at the store), `main/index.ts` (reconcile gate), `main/controllers/AgentInfrastructureController.ts` (await reconcile), `package.json` (`js-yaml`)

- `provisionWorkspace` becomes `reconcile()` + `renderSkills()`. The reconcile table subsumes seeding — first run is just "no baseline" rows — so there is no separate seed path to keep in sync.
- Reconcile is generalised over `.claude/CLAUDE.md`, `.claude/settings.json` and `.claude/hooks/` too. Those three have the identical silent-overwrite bug and nobody has noticed only because nobody edits them yet.
- Adopt-not-prune handles the one-time migration of the 21 existing byte copies.
- All state writes via `manifestIO`.

**Verified:** tsc, jest, smoke. Tests pin the empirically-measured semantics nothing currently pins — symlink dirent type, write-through, `rmSync` on a link, `cpSync` onto a link (`ERR_FS_CP_DIR_TO_NON_DIR`), the full 10-row reconcile table against a real temp tree, and an upgrade proven by pointing pristine at a mutated fixture. **Live:** a real `npm start`, confirm all 21 ids appear in the session's `system/init` `skills` array; edit `<ws>/.claude/skills/acabox/SKILL.md`, restart, confirm the edit survives and reads modified; confirm `.applications/_bridge` still exists and a mini-app still builds. Headline user-visible win with zero UI: **skill edits stop vanishing.**

---

### Phase 2 — Explicit allowlist, bundled-skill suppression, load assertion. Config only.

**Modify:** `shared/skills.ts` (`buildSkillRuntimeConfig`, `BUNDLED_ALLOW`), `agent-server/sessionConfig.ts`, `agent-server/index.ts`, `main/controllers/AgentInfrastructureController.ts` (drop bare `'Skill'` from `:248`), `main/containerService.ts` (`rememberAgentSkills`), `main/agentSession.ts` (log + diff `init.skills` / `init.plugins`)

**Prerequisite to check before implementing:** run a real turn with a 21+ entry `skills` array and confirm no skill silently drops and that `Skill(<name>)` per-entry auto-approve covers all of them. The failure mode changes here — an unlisted skill goes from "runs anyway" to a hard `errorCode: 8`.

**Verified:** tsc, jest (incl. the live-vs-crash-restart parity case). **Agent-server standalone:** run the built bundle directly with `COSCIENTIST_AGENT_CONFIG=<agent.json> COSCIENTIST_WORKSPACE=<dir> COSCIENTIST_AGENT_PORT=23288 node dist/agent-server.js`, curl `/health`, and confirm the `init` message's `skills` array contains our 21 and **not** `update-config` / `fewer-permission-prompts`.

---

### Phase 3 — Extensions tab, read-only. **Ships with the content-truth pass.**

**Create:** `renderer/components/extensions/{ExtensionsPage,SkillsList,SkillDetail}.tsx` + `extensions.css`
**Modify:** `renderer/index.tsx` (rail tab), `renderer/components/DirectoryPermissions.tsx`, `main/index.ts` (`skills:list|read`), `main/preload.ts`, `renderer/types.d.ts`

**Blocker: the docx/pdf/pptx/xlsx licence answer must land before this ships.** This is the release that puts them on screen.

**The content pass, in the same release** — a catalogue is the worst possible place to first display rot:
- `flow-cytometry` — the only skill that is broken **and silent**: all six scripts `import flowkit`, it is not in the venv, and `SKILL.md` has zero install instructions. FlowKit is pure-Python and pip-installable, so either add `.applications/install pip flowkit` to the skill or add the non-functional banner `differential-expression` already carries. Pick one; do not ship a browsable list containing it as-is.
- `acabox/SKILL.md:78,83,84-85` — claims R runs on the host and advertises `differential-expression` and `flow-cytometry` as "Domain skills ready to go," directly contradicting `differential-expression/SKILL.md:17`. Fork-original, so nobody upstream will fix it.
- `activity-summary` — shrink to file sessions, which is all `activityQuery.ts:21-23` can structurally return, and fix the matching stale "browser" source description at `agent-server/index.ts:207`.
- Delete `academic-writing-agent` and `differential-expression` (see section 5).

**Verified:** tsc, jest, smoke, plus live CDP screenshots of the tab in all states — populated, filtered, a modified skill, a `BROKEN FRONTMATTER` row, an empty Yours group — and a confirmation that `RUNNING` never appears anywhere.

---

### Phase 4 — Mutation and live apply.

**Create:** `main/mcpServers/skillsMcpServer.ts`, `renderer/components/extensions/SkillDiff.tsx`, `src/cobuilding/skills/managing-skills/SKILL.md`
**Modify:** `main/index.ts` (`skills:write|create|remove|setEnabled|revert|restoreAll|reveal`, `pushSkillsToAgent`), `main/preload.ts`, `renderer/types.d.ts`, `agent-server/index.ts` (`POST /reload-skills` + the four workspace-relay tools), `main/containerService.ts` (`reloadAgentSkills`), `renderer/components/command-desk/ActivityPanel.tsx` (conflict rows)

**Prerequisite to check before implementing:** confirm `reloadPlugins()` picks up an **edit** to an existing `SKILL.md`, not just an add. Only the add case was measured. The handler clears every skill cache (`rYH` → `pA()` → `Zs()` → `qb7()`, `S16()`, plus `MdH()` for the per-agent already-sent set), from which the edit case follows — but this phase depends on it and inference is not measurement.

**Verified:** tsc, jest, smoke. **Live CDP:** edit a skill in the panel and confirm the store file changed and the chip flipped; revert and confirm the trash entry exists; `restoreAllBuiltins` with a custom skill present and confirm it is untouched; a real chat turn where the agent calls `write_skill_file` and the change is visible in the next turn; and the version-check-on-save conflict path driven by editing the same file from `Bash` mid-edit.

---

### Phase 5 — First-party plugin for hooks and `bin/`. Hardening only.

**Create:** `src/cobuilding/acabox-plugin/{.claude-plugin/plugin.json, hooks/hooks.json, bin/acabox-install}`
**Modify:** `forge.config.js` (`extraResource`), `agent-server/sessionConfig.ts` + `index.ts` (`plugins: [{type:'local', path}]`), `main/skills.ts` (stop writing hooks into the workspace)

Moves `block-secret-reads.sh`, `block-host-installs.sh` and the install wrapper out of the **agent-writable workspace** and into a signed, read-only resource, referenced via `${CLAUDE_PLUGIN_ROOT}`. That is the entire justification; there is no user-visible change and no namespacing cost because hooks and binaries have no displayed names.

**Three prerequisites to check before implementing, none of them assumed:**
1. Does forge's `extraResource` carry a `.claude-plugin/` **dot-directory** into `Contents/Resources`? Known packaging trap, untested.
2. Does an ad-hoc-signed hardened-runtime packaged build load a `--plugin-dir` plugin and fire its hooks? Untested.
3. Does the plugin `bin/` PATH injection survive `~/Library/Application Support/acabox/...`? The CLI's filter appears to be `/[:"'$\`\\\n\r]/` — spaces should pass — but verify against the real binary before betting the install wrapper on it. If it fails, ship no `bin/` and leave the wrapper where it is.

**Verified:** tsc, jest, smoke, **plus a real `npm run package`** whose installed bundle boots, lists `plugin: acabox` in `init.plugins`, `codesign --verify --strict` passes, and both hooks demonstrably fire (an `apt-get install` attempt exits 2 with the new message; a `cat` of `agent.json` is refused).

---

## 5. What NOT to build

**1. Marketplaces. Not now, not behind a flag, not "just the official one."** Measured: `extraKnownMarketplaces` + `enabledPlugins` in `Options.settings` installs remote code **headlessly with zero prompting**, shallow-cloning into `<CLAUDE_CONFIG_DIR>/plugins`, putting the plugin's `bin/` on the Bash tool's PATH and its hooks into the PreToolUse chain — inside an app whose Bash is auto-approved with no `canUseTool` handler anywhere. `Options.settings` lands in flagSettings, which is merged **regardless of `settingSources`**, so `['project']` does not stop it. Acabox never sets those two keys. That is a hard rule, and it should be a comment in `sessionConfig.ts`.

**2. A user-facing "Plugins" tab or vocabulary.** No install story, therefore no actions, therefore no tab. `overlay`'s placeholder tab whose entire content explains why you cannot use it is exactly the half-built vertical slice this project deletes on sight.

**3. Third-party plugin install from a folder or a zip.** Same reasoning at smaller scale: installing a plugin is arbitrary code execution (`bin/` on PATH, hooks in the tool chain, MCP servers auto-started) in a process that already has unrestricted Bash. If this is ever wanted, it needs a real trust gate designed on its own terms — not a file picker bolted onto a skills panel.

**4. git, `isomorphic-git`, or any VCS.** `/usr/bin/git` on macOS is a CLT shim that exists, is executable, and fails with `xcrun: error: invalid active developer path` on a machine without Command Line Tools — making skill provisioning depend on it recreates precisely the boot-brick class this whole effort removes. And `isomorphic-git` brings an object DB, index, refs and packfiles to serve a history that is linear by construction, one baseline per release, merge unit one file. A per-file hash map plus `diff` gets closer to 100% of the value than 90%, because the one thing git would add — a real merge algorithm — is the one thing we must never do.

**5. Any automatic three-way merge of a scientist's edited `SKILL.md`.** Keep their file, store the new one, show the conflict, offer three explicit buttons. A merge that silently succeeds and is subtly wrong is far worse than a conflict that waits.

**6. `git-backed`'s object store, GC, journal, actor attribution, and History-with-restore tab.** It is the most elegant engineering in the set and it is the clearest over-engineering: an fs.watch journal that the proposal itself admits drops events under macOS load, cannot observe anything written while the app is closed, and will misreport the user's own in-panel save as the agent's edit (the watcher sees a live chat, so it renders "changed while chat X was running"). A history surface that is sometimes silently wrong is worse than none for a non-developer — it teaches distrust of the one screen built to create trust. Per-file baselines plus a 30-day trash cover the actual requirement.

**7. Anything in the UI we cannot measure.** No "last used," no invocation count, no health score, no "3 tokens saved." There is no source for any of them. `getContextUsage().skills` gives real per-skill token cost — if that is ever wanted, it belongs in the Debug tab, not on a scientist's skill row.

**8. A per-skill permission or sandbox UI.** The SDK **ignores** `SKILL.md`'s `allowed-tools` frontmatter entirely — it is honored only by the CLI — and Acabox supplies no `canUseTool` handler, so `allowedTools` is auto-approve rather than a restriction. Any UI implying a skill can be granted or denied capabilities would be a lie about the security model.

**9. A CodeMirror editor for skill `scripts/*.py`.** Reveal in Finder. A textarea is the right tool for markdown and the honest answer for Python is "open it in your editor."

**10. `settingSources: ['user', 'project']`.** The `<CLAUDE_CONFIG_DIR>/skills` tier is tempting — already in userData, already outside every sweep — but enabling it also loads that tier's `settings.json`, and nobody has traced which file that resolves to once `CLAUDE_CONFIG_DIR` is redirected. Untraced settings inheritance in an app whose `.claude/settings.json` holds the secret-blocking hooks is not worth a directory we already reach by symlink.

**11. `academic-writing-agent` — delete it.** 24 files, 128 KB, built entirely around three MCP servers this fork dropped: 15 references to `mcp__ms-word__*`, 9 to `mcp__citeright__*`, 3 to `mcp__zotero__*`. None of those servers exist in `agent-server/` or `main/`. `actions/cite.md` alone has 50 lines quoting precise tool signatures for servers that were deleted. Its 819-character description is the second-largest in the listing budget. Salvage `doctypes/` and `sections/` into a single new `scientific-writing` skill if anyone wants to; do not keep the vertical. Delete `src/cobuilding/main/mcpServers/__tests__/editApproval.test.ts` with it — it tests the ms-word server that no longer exists.

**12. `differential-expression` — delete it.** It is correctly marked non-functional at `SKILL.md:17`, but it still ships 57 KB of unusable R, still burns 591 characters of listing budget with a description that reads as fully functional ("Run differential expression analysis using DESeq2…"), and R **cannot** be installed: `which R Rscript` finds nothing, only the `python3` kernel is registered, and `packageInstaller.ts:371` refuses the R registry outright. Delete the skill and the `differentialExpression` mini-app template (whose notebook still hardcodes `"name": "ir"`). Point `pydeseq2` from the `acabox` skill instead. Marking dead things in place is what we did last time; deleting them is what this project's own directive says to do.

**13. A skill scaffolding wizard.** "New skill" creates a valid stub and opens the editor. Anything more elaborate is a worse version of asking Claude, which is the actual product.

**14. Rebuilding `ConnectorsSettings.tsx`.** It moves under a tab, verbatim. Its CSS is already self-contained and token-based. Touching it is pure risk.