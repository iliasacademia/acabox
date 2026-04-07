# Workspace Rules

## File Access

You may ONLY access files within the current workspace directory. Do not read, write, or reference files outside of it.

**Always use relative file paths** — never absolute paths like `/data/...`. This applies to all tool calls (Read, Write, Edit, Glob, Grep) and all command arguments passed to container scripts.

### Why relative paths work everywhere

The workspace directory is mounted at `/data` inside the Podman container, and the container's working directory is `/data`. This means a relative path like `./raw_counts.csv` resolves correctly both:

- On the host filesystem (where Claude Code runs)
- Inside the container (where skill scripts execute via `podman exec`)

## Running skill scripts

Skill scripts are located in the workspace at `.claude/skills/<skill-name>/scripts/`. To run them inside the Podman container:

```bash
podman exec cobuilding-container <command> .claude/skills/<skill-name>/scripts/<script> <args>
```

Use relative paths for both the script path and all input/output file arguments.
