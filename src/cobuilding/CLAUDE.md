# Workspace Rules

## File Access

You may ONLY access files within the current workspace directory. Do not read, write, or reference files outside of it.

**Always use relative file paths** — never absolute paths like `/data/...`. This applies to all tool calls (Read, Write, Edit, Glob, Grep) and all command arguments passed to container scripts.

**Never use `cd`** — the working directory is already set to the workspace root. Running `cd /absolute/path && command` will fail. Just run commands directly with relative paths.

### Why relative paths work everywhere

The workspace directory is mounted at `/data` inside the Podman container, and the container's working directory is `/data`. This means a relative path like `./raw_counts.csv` resolves correctly both:

- On the host filesystem (where Claude Code runs)
- Inside the container (where skill scripts execute via `podman exec`)

## Installing packages

**All software installation must go through the install wrapper at `.applications/install`.** This applies to `pip`, `npm`, `R`, `apt`, and any manual/bespoke install script.

```bash
.applications/install pip <package> --app <app_dir_name>
.applications/install npm <package> --app <app_dir_name>
.applications/install R   <package> --app <app_dir_name>
.applications/install apt <package> --app <app_dir_name>
.applications/install manual .applications/<app_dir_name>/setup/<script>.sh --app <app_dir_name>
```

The wrapper does two things atomically: (1) installs the package live in the running container, and (2) records the dependency in the app's per-registry file (`requirements.txt`, `package.json`, `r-packages.txt`, `apt-packages.txt`, or `setup/*.sh`) so the install persists across container rebuilds and travels with the app folder when shared.

**Never run `pip install`, `npm install`, `apt-get install`, `Rscript -e 'install.packages(...)'`, or `conda install` — not on the host, and not through `podman exec`.** All of these invocations are blocked by a PreToolUse hook. Running an install directly does the live install but silently fails to update the dependency file, so the package is lost on the next container rebuild or when the app is shared.

**Downloading data files into the app folder does NOT require the wrapper.** Use `curl` or `wget` to write directly into `.applications/<app_dir_name>/` — those are app-local files (model weights, datasets, fixtures), not global installs.

See the **manage-mini-application** skill (`.claude/skills/manage-mini-application/SKILL.md`) for the full per-registry reference.

## Container recovery

If a `podman exec cobuilding-container` command fails because the container is not running, restart it by running:

```bash
.academia/start-container
```

Then retry your command. Do not attempt to start the container any other way.

## Running skill scripts

Skill scripts are located in the workspace at `.claude/skills/<skill-name>/scripts/`. To run them inside the Podman container:

```bash
podman exec cobuilding-container <command> .claude/skills/<skill-name>/scripts/<script> <args>
```

Use relative paths for both the script path and all input/output file arguments.

## Progress Tracking

When working on multi-step tasks (3 or more steps), use the `TodoWrite` tool to create and maintain a task list so the user can follow along with your progress. Update task statuses as you work — mark items as `in_progress` when you start them and `completed` when you finish. This is especially important for longer-running tasks like data analysis, file processing, or building mini-applications.
