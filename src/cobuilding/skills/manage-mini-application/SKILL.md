---
name: manage-mini-application
description: >
  PRIORITY SKILL: Invoke this skill BEFORE any analysis or data-processing 
  skills whenever the user's PRIMARY intent is to build, create, make, develop, 
  or update an application, tool, dashboard, or UI — even if the request 
  mentions scientific methods like differential expression, PCA, or clustering. 
  Those methods describe what the app should do internally, not what you should 
  execute now. DO NOT run analysis skills as a prerequisite step.

  Use this skill when the user says things like: "make an app", "build a tool", 
  "create an interface", "I want a UI for X", "develop a dashboard", or 
  "update/edit/change the app".

  Do NOT use this skill when the user wants to directly run an analysis on 
  their data with no mention of building a UI or application.
---

# Manage Mini-Application

Each mini-app lives under `.applications/<lowerCamelCaseName>`. The agent writes `src/App.tsx`, optionally creates a backing Jupyter notebook, and compiles with esbuild.

## Creating a mini-app

### Step 1: Scaffold the directory

```bash
podman exec cobuilding-container node \
  .claude/skills/manage-mini-application/scripts/manage_mini_app.mjs \
  --name "<display name>" \
  [--template "<template name>"]
```

The script prints `{ name, dir_name, dir }` to stdout and creates:
- `<dir>/src/index.html` — HTML shell with Tailwind
- `<dir>/src/index.tsx` — React mount boilerplate with error boundary
- `<dir>/dist/`, `<dir>/output/`, `<dir>/input/` directories
- `<dir>/notebook.ipynb` — canonical notebook with a `parameters` cell + cobuild metadata; default kernel is `python3` (override with `--kernel ir` for R)

If `--template` is specified, template files from `.applications/_templates/<name>/` are copied into `src/`. Available templates:

- `differentialExpression` — DESeq2 analysis with interactive volcano/MA plots. See [templates/differential_expression.md](templates/differential_expression.md).

### Step 2: Write `src/App.tsx`

Write the React component to `<dir>/src/App.tsx`.

Available packages (pre-installed in the container):
- `react`, `react-dom`
- `react-plotly.js` — Plotly charts. See the **react-plotly** skill (`.claude/skills/react-plotly/SKILL.md`) for responsive container patterns, design system, trace types, and complete examples.
- `lucide-react` — Icons
- `@reusable` — Shared building blocks. Resolved via esbuild alias to `.applications/_reusable/`. **Compose these instead of writing your own — they are how the framework enforces consistent behavior across apps.**
  - **State**: `useAppState` (params + inputs + outputs + runResult, all persisted to the notebook).
  - **Kernel runs**: `useKernelAction` (connect, inject params, execute action cell, surface errors).
  - **UI building blocks**: `<FileSlotPicker>`, `<RunButton>`, `<RunStateBadge>`, `<OutputFileList>`, `<VolcanoPlot>`, `<MAPlot>`, `<ErrorDisplay>` (auto-mounted by the scaffolded `index.tsx`; do not add a second one).
  - **Utilities**: `readJsonOutput<T>(path)`, `parseCsvLine`, `formatParamsAssignment`.

#### Persistent state — use `useAppState`

**All persistent params and selected input files MUST go through `useAppState`.** This is the only mechanism that survives tab switches and Electron restarts. Raw `useState` is only for transient UI (open/closed sections, in-flight viz adjustments that don't need to be preserved).

```tsx
import { useAppState } from "@reusable/useAppState";

interface MyParams {
  threshold: number;
  input_csv: string;       // file path slot
  variant: "a" | "b";
}

const DEFAULTS: MyParams = { threshold: 0.5, input_csv: "", variant: "a" };

import type { OutputFile } from "@reusable/OutputFileList";

// Optional: define a typed "run result" shape if your app produces structured
// data beyond a flat file list (summary stats, viz descriptors, etc.).
interface MyRunResult {
  summary: { count: number };
  // ...whatever your app needs to re-render after a remount
}

const {
  loading,
  params, setParams,
  selectInput, clearInput, readInput,
  outputs, setOutputs,         // persisted list of generated output files
  runResult, setRunResult,     // persisted structured run summary (or null)
  freshness,                   // 'never' | 'fresh' | 'stale' — drive <RunStateBadge>
  markRunComplete,
} = useAppState<MyParams, OutputFile, MyRunResult>({
  dirName: "myApp",
  defaults: DEFAULTS,
  inputSlots: ["input_csv"],   // param keys that hold file paths
});

// `runResult` is for structured run output beyond the flat file list —
// summary statistics, visualization descriptors, etc. Persisted in
// `notebook.metadata.cobuild.runResult` and hydrated on mount, so the UI
// re-renders the previous run's results without any disk I/O. Apps with
// no structured result can omit the third type param and ignore the field.

// Pick a file, then read its content:
const path = await selectInput("input_csv", [{ name: "CSV", extensions: ["csv"] }]);
if (path) {
  const text = await readInput("input_csv");  // string content, or null
  if (text) {
    const rows = parseCsv(text);
    // ...
  }
}

// Re-load on mount (so the user sees their previously-picked file):
useEffect(() => {
  if (loading || !params.input_csv) return;
  (async () => {
    const text = await readInput("input_csv");
    if (text) setRows(parseCsv(text));
  })();
}, [loading, params.input_csv]);

// After producing a result, persist its descriptor so it survives remounts:
const outName = "result.csv";
await window.filesAPI.writeFile(`.applications/myApp/output/${outName}`, csv);
setOutputs([{ name: outName, description: "...", path: `.applications/myApp/output/${outName}` }]);
await markRunComplete();
// → next time the user opens this app, `outputs` is already populated and
//   <OutputFileList files={outputs} ... /> renders without any extra work.

// Update a value (debounced auto-save to notebook.ipynb):
setParams({ threshold: 0.8 });

// After a successful run, record what was used:
await markRunComplete();
// → `freshness` becomes 'fresh' until the user changes any param,
//   then flips to 'stale' so <RunStateBadge> warns that results are out of date.
```

The hook hydrates from the notebook's `parameters` cell on mount (so the user sees what they left), debounces writes back to the same cell on every change, and stores run-completion metadata in `notebook.metadata.cobuild.lastRun`. Render a loading state while `loading` is true.

**Do not call `window.filesAPI.selectFile` directly for input files** — bypass `selectInput` and the file is not copied into the portable `input/` folder, the path is not persisted, and the staleness check is broken.

**Prefer `readInput(slot)` over calling `window.filesAPI.readFile` on a slot path** — it returns the text content directly (or `null`), so you don't have to handle the discriminated `{ type, content } | { type, fileUrl } | { error }` return shape yourself. Forgetting to extract `.content` is a common source of "the file shows up but nothing happens" bugs.

**Prefer `readJsonOutput<T>(path)` for reading JSON files in `output/`** — same reason: it parses and returns `T | null` instead of forcing you to dance around the readFile return shape.

#### Kernel-backed runs — use `useKernelAction`

**Do not hand-roll the connect/inject/execute/error flow.** `useKernelAction` is the single way to run a notebook-backed analysis. It handles kernel connection, parameter injection (using the same canonical format the persisted parameters cell uses), action-cell lookup by tag, error dispatch into the global `<ErrorDisplay>`, and the elapsed-time + phase tracking that drives `<RunButton>`.

```tsx
import { useKernelAction } from "@reusable/useKernelAction";
import { RunButton } from "@reusable/RunButton";
import { RunStateBadge } from "@reusable/RunStateBadge";
import { readJsonOutput } from "@reusable/readJsonOutput";

const action = useKernelAction({
  dirName: "myApp",
  kernel: "ir",                         // or "python3"
  buildKernelParams: () => ({
    ...params,
    outdir: `.applications/myApp/output`,
  }),
});

const handleRun = async () => {
  setRunResult(null);
  setOutputs([]);

  const result = await action.run();
  if (!result.ok) return;               // error already in the floating ErrorDisplay

  // Read whatever your action cell produced and translate into the hook:
  const meta = await readJsonOutput<MyRunResultFile>(
    `.applications/myApp/output/run_metadata.json`,
  );
  if (meta) {
    setRunResult({ /* ...derived from meta... */ });
    setOutputs(meta.files.map(toOutputFile));
  }
  await markRunComplete();
};

// In the JSX:
<RunButton action={action} onRun={handleRun} disabled={!canRun}>
  Run Analysis
</RunButton>
{runResult && <RunStateBadge freshness={freshness} />}
```

**Errors from the kernel surface in the global floating `<ErrorDisplay>` panel** — auto-mounted by the scaffolded `index.tsx`. Do not add a second error UI inside the app's main flow.

#### File pickers — use `<FileSlotPicker>`

```tsx
import { FileSlotPicker } from "@reusable/FileSlotPicker";

<FileSlotPicker
  state={appState}
  slot="input_csv"
  label="Counts CSV"
  filters={[{ name: "CSV", extensions: ["csv"] }]}
/>
```

The component reads the slot from `params`, calls `selectInput`/`clearInput`, and renders the upload affordance vs. the filename + clear button. Don't reimplement this layout in each app.

**Prefer Plotly.js for all data visualizations** (charts, plots, graphs, heatmaps). Do not use custom SVG/Canvas rendering or other charting libraries when Plotly can handle the visualization.

**App Style** This app is for use by scientists to analyze and viualize their data. Keep the style modern and professional with a `bg-gray-50` background. 

### Step 3: Add an action cell to the notebook (only for kernel-backed apps)

Every app already has a `<dir>/notebook.ipynb` from the scaffold, with a markdown doc cell, a `parameters`-tagged cell that `useAppState` reads/writes, and `cobuild` metadata for run-state bookkeeping.

If the app needs R or Python computation, append an **action cell** (tag: `action`) using `NotebookEdit`. It should source existing skill scripts and call functions with parsed parameters. Use relative file paths.

```r
source(".claude/skills/<skill-name>/scripts/<script>.R")
params <- jsonlite::fromJSON(params_json)
# ... call your functions with params$<field> ...
```

The React app injects a fresh `params_json` (built from the persistent `params` plus run-time-only fields like `outdir`) into the kernel before executing this cell, so the cell can rely on `params_json` being defined.

If your app does no kernel computation (everything happens in the React side), do not add an action cell — the parameters cell alone is enough to make the directory a self-describing record of the user's configuration.

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

- Write output files **immediately when data is generated** (e.g. when the user clicks a button like "Run"), not in a separate "Save" or "Download" step. The user should see the output list appear as soon as processing finishes.
- Use `setOutputs` from `useAppState` (not a local `useState`) so the list survives remounts and Electron restarts. The descriptors are persisted alongside the rest of the app state in `notebook.metadata.cobuild.outputs`.
- Wrap `writeFile` in try/catch, but **always call `setOutputs` AFTER the try/catch** (not inside it) so the output list appears even if the file write fails.
- The `OutputFileList` must always be rendered at the very bottom of the app layout, outside any conditional result sections.
- The `OutputFileList` provides its own "Download" button (native save dialog) for each file — do not add separate download buttons elsewhere.

```typescript
import { OutputFileList, type OutputFile } from "@reusable/OutputFileList";
```

```tsx
const { outputs, setOutputs, markRunComplete } = useAppState<MyParams, OutputFile>({ ... });

// Write output as soon as data is generated (e.g. in the shuffle/run handler):
const handleProcess = async () => {
  const result = processData(input);
  const outName = "results.csv";
  try {
    await window.filesAPI.writeFile(`.applications/${dirName}/output/${outName}`, result);
  } catch (err) {
    console.error("Failed to write output:", err);
  }
  setOutputs([{
    name: outName,
    description: "Processed results",
    path: `.applications/${dirName}/output/${outName}`,
  }]);
  await markRunComplete();
};

// Always render at the bottom of the app, outside conditional sections:
<OutputFileList files={outputs} outputDir={`.applications/${dirName}/output`} />
```

Each `OutputFile` has `name` (display name), `description` (short summary), and `path` (relative workspace path). The component renders each file with inline "Show in Finder" and "Download" buttons.

### Downloading files

Use the bridge download API to let users save/export data:

```typescript
const csvContent = [header, ...rows].map(r => r.join(",")).join("\n");
await window.filesAPI.downloadFile("results.csv", csvContent);
```

Do NOT use `document.createElement('a')` with blob URLs — it does not work reliably in the sandboxed iframe.

### Image tags

Mini-apps run inside an iframe on the Electron host. The `<img>` tag `src` attribute cannot use relative paths or container paths — it must use the `local-file://` protocol with an absolute host path built from the workspace path.

Construct image `src` values by combining `window.getWorkspacePath()` with the path to the image in the application's output directory:

```typescript
const workspacePath = window.getWorkspacePath();
const dirName = "myApp"; // the application dir_name

// For an image generated by a backing notebook into the output dir:
const src = `local-file://${workspacePath}/.applications/${dirName}/output/${imageFileName}`;
```

```tsx
<img
  src={`local-file://${workspacePath}/.applications/${dirName}/output/plot.png`}
  alt="Plot description"
/>
```

**For img tags do NOT use:**
- Relative paths (`./output/image.png`) — won't resolve in the iframe context
- Container paths (`/data/.applications/...`) — the Electron host cannot access container-internal paths
- Blob URLs or data URIs for files that already exist on disk

### Error display

Runtime errors are captured automatically by the bridge and shown in a floating red overlay (bottom-right of the iframe). This covers uncaught exceptions, unhandled promise rejections, `console.error` calls, failed fetches (non-2xx), resource load failures, and React render errors. **Do not add your own error UI** — the overlay is already mounted by the scaffolded `index.tsx`.

### Calling Claude from a mini-app

Use `window.anthropicAPI` — **do NOT pass `ANTHROPIC_API_KEY` into the container, read it from env, or make direct API calls from notebook cells.** The key is managed by the host; the bridge handles auth transparently.

```tsx
// Non-streaming — await the full response
const msg = await window.anthropicAPI.complete({
  messages: [{ role: 'user', content: userText }],
  system: 'You are a helpful assistant.',   // optional
  model: 'claude-haiku-4-5-20251001',       // optional, this is the default
  max_tokens: 1024,                         // optional, this is the default
});
const reply = msg.content[0].text;

// Streaming — onChunk fires for each text delta
let output = '';
await window.anthropicAPI.stream(
  { messages: [{ role: 'user', content: userText }] },
  (chunk) => { output += chunk; setDisplayText(output); },
);
```

### Bridge API

See [bridge-api.md](bridge-api.md) for the full API reference (`window.filesAPI`, `window.kernel`, `window.containerAPI`, `window.anthropicAPI`, `window.getWorkspacePath()`).
