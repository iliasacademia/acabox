# Workspace Rules

## File Access

You may ONLY access files within the current workspace directory. Do not read, write, or reference files outside of it.

**Always use relative file paths** — never absolute paths like `/data/...`. This applies to all tool calls (Read, Write, Edit, Glob, Grep) and all command arguments.

**Never use `cd`** — the working directory is already set to the workspace root. Just run commands directly with relative paths.

## Installing packages

**All software installation must go through the install wrapper at `.applications/install`.** This applies to `pip`, `npm`, `R`, `apt`, and any manual/bespoke install script.

```bash
.applications/install pip <package> --app <app_dir_name>
.applications/install npm <package> --app <app_dir_name>
.applications/install R   <package> --app <app_dir_name>
.applications/install apt <package> --app <app_dir_name>
.applications/install manual .applications/<app_dir_name>/setup/<script>.sh --app <app_dir_name>
```

The wrapper does two things atomically: (1) installs the package live, and (2) records the dependency in the app's per-registry file (`requirements.txt`, `package.json`, `r-packages.txt`, `apt-packages.txt`, or `setup/*.sh`) so the install persists across container rebuilds and travels with the app folder when shared.

**Never run `pip install`, `npm install`, `apt-get install`, `Rscript -e 'install.packages(...)'`, or `conda install` directly.** All of these invocations are blocked by a PreToolUse hook. Running an install directly does the live install but silently fails to update the dependency file, so the package is lost on the next container rebuild or when the app is shared.

**Downloading data files into the app folder does NOT require the wrapper.** Use `curl` or `wget` to write directly into `.applications/<app_dir_name>/` — those are app-local files (model weights, datasets, fixtures), not global installs.

See the **manage-mini-application** skill (`.claude/skills/manage-mini-application/SKILL.md`) for the full per-registry reference.

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
