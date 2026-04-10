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

**Never run `pip install`, `pip3 install`, `conda install`, or `R install.packages()` on the host.** All package installation must happen inside the Podman container.

If a skill requires a package that isn't available, install it into the container:

```bash
# Python
podman exec cobuilding-container pip3 install --break-system-packages <package>

# R
podman exec cobuilding-container Rscript -e 'install.packages("<package>", repos="https://cloud.r-project.org")'
```

This applies even if a skill's documentation shows a bare `pip install` command — always run it through `podman exec`.

## Running skill scripts

Skill scripts are located in the workspace at `.claude/skills/<skill-name>/scripts/`. To run them inside the Podman container:

```bash
podman exec cobuilding-container <command> .claude/skills/<skill-name>/scripts/<script> <args>
```

Use relative paths for both the script path and all input/output file arguments.

## Progress Tracking

When working on multi-step tasks (3 or more steps), use the `TodoWrite` tool to create and maintain a task list so the user can follow along with your progress. Update task statuses as you work — mark items as `in_progress` when you start them and `completed` when you finish. This is especially important for longer-running tasks like data analysis, file processing, or building mini-applications.
