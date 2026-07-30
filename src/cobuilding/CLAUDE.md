# Workspace Rules

## File Access

Your working directory contains agent-managed files (`.claude/`, `.applications/`, `.academia/`). User research directories are mounted as subdirectories (e.g. `MyResearch/`, `LabData/`).

**Always use relative file paths.** To access user files: `MyResearch/paper.docx`. To access skills: `.claude/skills/...`. Do not hardcode absolute paths — the workspace lives somewhere different on every machine, so an absolute path stops working the moment the app or notebook is shared.

**Never use `cd`** — the working directory is already set to the workspace root. Just run commands directly with relative paths.

## Installing packages

**All software installation must go through the install wrapper at `.applications/install`.** It supports `pip`, `npm`, and manual/bespoke install scripts.

```bash
.applications/install pip <package> --app <app_dir_name>
.applications/install npm <package> --app <app_dir_name>
.applications/install manual .applications/<app_dir_name>/setup/<script>.sh --app <app_dir_name>
```

The wrapper does two things atomically: (1) installs the package live, and (2) records the dependency in the app's per-registry file (`requirements.txt`, `package.json`, or `setup/*.sh`) so the install travels with the app folder when it is shared. pip installs go into Acabox's own Python venv and npm into Acabox's own npm prefix — never the user's system Python or a global `node_modules`.

**`apt`, `R`, and `conda` are not available.** Acabox runs directly on the user's machine and will not install into their system package manager; the wrapper refuses these registries. If a task seems to need one, find a pip/npm alternative or tell the user what to install themselves.

**Never run `pip install`, `npm install`, `apt-get install`, `Rscript -e 'install.packages(...)'`, or `conda install` directly.** All of these invocations are blocked by a PreToolUse hook. A direct pip/npm install does work live but silently fails to update the dependency file, so the package is lost when the app is shared.

**Downloading data files does NOT require the wrapper.** Use `curl` or `wget` to write them directly — these are app-local files (model weights, datasets, fixtures), not global installs.

**Put working files in the durable data dirs, not loose in the app folder.** Each app has `.applications/<app_dir_name>/input/` and `.../output/`, which are symlinks into `tool-data/<app_dir_name>/`. Anything the user should keep — downloaded datasets, model weights, generated results — belongs under `input/` (fetched/reference data) or `output/` (results). Files written loosely into `.applications/<app_dir_name>/` are treated as code and are **deleted when the tool is deleted**; files under `input/`/`output/` survive.

See the **manage-mini-application** skill (`.claude/skills/manage-mini-application/SKILL.md`) for the full per-registry reference.

## Calling APIs

The user can configure HTTP APIs in Settings → APIs. They are reachable through
Acabox's local proxy, which holds the credentials and attaches them for you:

```bash
curl -sH "x-acabox-api-token: $ACABOX_API_TOKEN" \
  "$ACABOX_API_BASE/<api-id>/<path>"
```

Both variables are already in your environment. If `$ACABOX_API_BASE` is empty,
the proxy isn't running and no API is callable — say so rather than falling back
to an unauthenticated `curl` to the same service.

Use `mcp__apis__list_apis` for the configured ids, their base URLs, and the
user's notes on each. It reads live state, so check it if a call is refused or
if you suspect an API was added after this conversation started.

**Never ask the user for an API key, and never write one into a script or a
notebook.** A key pasted into chat is a key in the message database forever. If
an API you need isn't configured, say so and tell them to add it in
Settings → APIs.

**A `405 read-only` is the user's setting, not an obstacle to route around.**
Tell them which API needs writes rather than trying another path to the same
change. Likewise a `403` naming a refused host: report the host, don't retry.

Responses stream, so a large download goes to disk rather than through this
conversation — use `curl -o` for anything big instead of reading it into
context.

**Mini-apps reach the same APIs** through `window.hostAPI.api.fetch(apiId, path)`,
but only for APIs the user has granted to that specific tool in its Settings
panel. When you build a tool that needs one, tell the user which API to grant —
you cannot grant it yourself, and an ungranted call returns 403.

## Running skill scripts

Skill scripts are located in the workspace at `.claude/skills/<skill-name>/scripts/`. Run them directly:

```bash
<command> .claude/skills/<skill-name>/scripts/<script> <args>
```

Use relative paths for both the script path and all input/output file arguments.

## Opening mini-applications

When the user asks to open, launch, show, or run a mini-app/tool (e.g. "open my tool randomPlot", "show me the differentialExpression app"), call the `mcp__mini-apps__open_mini_application` tool with the app's `dir_name`. Do not just claim the app is open — the tool call is what actually opens it in the UI.

Use `mcp__mini-apps__build_and_open_mini_application` instead when you've just created or edited the app's source and the bundle needs to be rebuilt before the user sees the change.

## Workspace Files and Research Profile

When the user asks about their files, references, manuscripts, grants, or presentations in their workspace, use `mcp__workspace__get_scanned_files` to query the workspace file index. You can filter by file_type (`manuscript`, `grant`, `presentation`, `reference`) or return all types.

When the user asks about their research profile or what you know about them, use `mcp__workspace__get_research_profile` to retrieve the profile summary generated during the workspace scan.

## Progress Tracking

When working on multi-step tasks (3 or more steps), use the `TodoWrite` tool to create and maintain a task list so the user can follow along with your progress. Update task statuses as you work — mark items as `in_progress` when you start them and `completed` when you finish. This is especially important for longer-running tasks like data analysis, file processing, or building mini-applications.
