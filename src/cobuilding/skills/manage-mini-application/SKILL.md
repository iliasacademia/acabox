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
- `@reusable` — Shared components (OutputFileList, VolcanoPlot, MAPlot, csv-utils, types). Resolved via esbuild alias to `.applications/_reusable/`.

**Prefer Plotly.js for all data visualizations** (charts, plots, graphs, heatmaps). Do not use custom SVG/Canvas rendering or other charting libraries when Plotly can handle the visualization.

**App Style** This app is for use by scientists to analyze and viualize their data. Keep the style modern and professional with a white background. 

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
  --alias:@reusable=/data/.applications/_reusable
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

All output files must be written to `.applications/<dir_name>/output/`, regardless of how they are generated. There are two ways output files are created:

1. **From a backing notebook** — R or Python code writes results to the output directory during kernel execution (e.g. CSVs, images, JSON metadata).
2. **From the React app** — The app generates data in-browser (e.g. a user transforms a dataset, shuffles rows, exports a selection) and writes it via `window.filesAPI.writeFile()`.

Both cases must follow the same pattern: write to the output directory as soon as data is generated, then display all outputs using the `OutputFileList` reusable component at the bottom of the app UI. Every app that has output files should render this component.

**Important rules:**

- Write output files **immediately when data is generated** (e.g. when the user clicks a button like"Run"), not in a separate "Save" or "Download" step. The user should see the output list appear as soon as processing finishes.
- Wrap `writeFile` in try/catch, but **always call `setOutputFiles` AFTER the try/catch** (not inside it) so the output list appears even if the file write fails. See the example below — note that `setOutputFiles` is outside the try/catch block.
- The `OutputFileList` must always be rendered at the very bottom of the app layout, outside any conditional result sections.
- The `OutputFileList` provides its own "Download" button (native save dialog) for each file — do not add separate download buttons elsewhere.

```typescript
import { OutputFileList, type OutputFile } from "@reusable/OutputFileList";
```

```tsx
const [outputFiles, setOutputFiles] = useState<OutputFile[]>([]);

// Write output as soon as data is generated (e.g. in the shuffle/run handler):
const handleProcess = async () => {
  const result = processData(input);
  const outName = "results.csv";
  try {
    await window.filesAPI.writeFile(`.applications/${dirName}/output/${outName}`, result);
  } catch (err) {
    console.error("Failed to write output:", err);
  }
  setOutputFiles([{
    name: outName,
    description: "Processed results",
    path: `.applications/${dirName}/output/${outName}`,
  }]);
};

// Always render at the bottom of the app, outside conditional sections:
<OutputFileList files={outputFiles} outputDir={`.applications/${dirName}/output`} />
```

Each `OutputFile` has `name` (display name), `description` (short summary), and `path` (relative workspace path). The component renders each file with inline "Show in Finder" and "Download" buttons.

### Downloading files

Use the bridge download API to let users save/export data:

```typescript
const csvContent = [header, ...rows].map(r => r.join(",")).join("\n");
await window.filesAPI.downloadFile("results.csv", csvContent);
```

Do NOT use `document.createElement('a')` with blob URLs — it does not work reliably in the sandboxed iframe.

### Bridge API

See [bridge-api.md](bridge-api.md) for the full API reference (`window.filesAPI`, `window.kernel`, `window.containerAPI`, `window.getWorkspacePath()`).
