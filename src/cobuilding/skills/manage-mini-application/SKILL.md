---
name: manage-mini-application
description: >
  Creates or edits interactive mini-applications when the user needs a UI for
  tweaking parameters, exploring data visually, or iterating on thresholds.
  Triggers when the user asks to build an interactive app, create a data
  exploration tool, or make a parameter-tuning interface. Each mini-app is a
  standalone React app compiled with esbuild and loaded in an iframe, backed
  by an optional Jupyter notebook for computation.
---

# Manage Mini-Application

Each mini-app lives under `.applications/<lowerCamelCaseName>`. The agent writes `src/App.tsx`, optionally creates a backing Jupyter notebook, and compiles with esbuild.

## Creating a mini-app

### Step 1: Scaffold the directory

Run directly with Node.js (NOT Podman):

```bash
node .claude/skills/manage-mini-application/scripts/manage_mini_app.mjs \
  --name "<display name>" \
  [--template "<template name>"]
```

The script prints `{ name, dir_name, dir }` to stdout and creates:
- `<dir>/src/index.html` — HTML shell with Tailwind
- `<dir>/src/index.tsx` — React mount boilerplate with error boundary
- `<dir>/dist/` and `<dir>/output/` directories

If `--template` is specified, template files from `.applications/_templates/<name>/` are copied into `src/`. Available templates:

- `differentialExpression` — DESeq2 analysis with interactive volcano/MA plots. See [templates/differential_expression.md](templates/differential_expression.md).

### Step 2: Write `src/App.tsx`

Write the React component to `<dir>/src/App.tsx`.

Available packages (pre-installed in the container):
- `react`, `react-dom`
- `react-plotly.js` — Plotly charts. See the **react-plotly** skill (`.claude/skills/react-plotly/SKILL.md`) for responsive container patterns, design system, trace types, and complete examples.
- `lucide-react` — Icons
- `@reusable` — Shared components (VolcanoPlot, MAPlot, csv-utils, types). Resolved via esbuild alias to `.applications/_reusable/`.

**Prefer Plotly.js for all data visualizations** (charts, plots, graphs, heatmaps). Do not use custom SVG/Canvas rendering or other charting libraries when Plotly can handle the visualization.

### Step 3: Write the backing notebook (optional)

If the app needs R or Python computation, create a notebook at `<dir>/notebook.ipynb` using `NotebookEdit` with the **parameter cell + action cell** pattern:

1. **Parameters cell** (known ID, `parameters` tag) — a single JSON string variable the React app injects before execution.
2. **Action cell** (known ID, `action` tag) — sources existing skill scripts and calls functions with parsed parameters. Use relative file paths.

### Step 4: Build the bundle

```bash
podman exec cobuilding-container esbuild \
  .applications/<dir_name>/src/index.tsx \
  --bundle \
  --outfile=.applications/<dir_name>/dist/bundle.js \
  --jsx=automatic \
  --loader:.tsx=tsx \
  --loader:.ts=ts \
  --format=iife \
  --alias:@reusable=.applications/_reusable
```

If the build fails, read the error output, fix the issue in `App.tsx`, and rebuild.

### Step 5: Open the mini-app

Call `open_mini_application` with the `dir_name` from Step 1.

## Guidelines

### File paths

All files must be within the workspace. Convert absolute host paths (from file pickers) to relative paths before passing to notebooks:

```typescript
const relativePath = "./" + hostPath.slice(window.getWorkspacePath().length + 1);
```

### Output files

Each mini-app writes results to `.applications/<dir_name>/output/`. The app reads results from there after execution.

### Bridge API

See [bridge-api.md](bridge-api.md) for the full API reference (`window.filesAPI`, `window.kernel`, `window.containerAPI`, `window.getWorkspacePath()`).
