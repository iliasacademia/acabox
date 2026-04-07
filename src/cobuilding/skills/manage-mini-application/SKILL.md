---
name: manage-mini-application
description: >
  Create or edit an interactive mini-application when the user would benefit
  from an interactive UI — for example, workflows that involve tweaking
  parameters, exploring data visually, or iterating on thresholds. Each
  mini-app is a standalone React app compiled with esbuild and loaded in an
  iframe. The agent writes the React code, optionally creates a backing Jupyter
  notebook, and builds the bundle.
---

# Manage Mini-Application

Each mini-app is a standalone React app that lives in its own directory under `.applications/<lowerCamelCaseName>`. The agent writes `src/App.tsx`, optionally creates a backing Jupyter notebook, and compiles the app with esbuild. The compiled bundle is loaded in an iframe inside the electron app.

## How to create a new mini-app

### Step 1: Create the directory and DB record

Run the script directly with Node.js (do NOT use Podman):

```bash
node .claude/skills/manage-mini-application/scripts/manage_mini_app.mjs \
  --name "<display name>" \
  [--template "<template name>"]
```

If `--template` is specified, the script copies template files from `.applications/_templates/<template name>/` into the mini-app's `src/` directory. Available templates:

- `differentialExpression` — Interactive differential expression analysis UI with file pickers, design configuration, parameter tuning, and visualization display.

The script uses the `MINI_APP_WORKSPACE_DIR` environment variable (set automatically).

The script prints a JSON object with `name`, `dir_name`, and `dir` to stdout. The `dir_name` is the lowerCamelCase directory name used to open the mini-app. The script automatically creates:
- `<dir>/src/index.html` — HTML shell with Tailwind and script tag for the bundle
- `<dir>/src/index.tsx` — React mount boilerplate (imports the bridge and renders `<App />`)
- `<dir>/dist/` — output directory for the compiled bundle
- `<dir>/output/` — output directory for script and notebook results (all outputs should be written here)

### Step 2: Write `src/App.tsx`

Write the mini-app's React component to `<dir>/src/App.tsx`. This is the entry point rendered by the scaffolded `index.tsx`.

You can import from these packages (pre-installed in the Podman container):
- `react`, `react-dom` — React core
- `react-plotly.js` — Plotly charts
- `lucide-react` — Icons

### Step 3: Write the backing notebook (optional)

If the mini-app needs to execute R or Python code, create a notebook at `<dir>/notebook.ipynb` using the `NotebookEdit` tool. Notebook cells can call existing skill scripts (e.g. `source("/skills/differential-expression/scripts/differential_expression.R")` in R or `subprocess.run(["Rscript", ...])` in Python) rather than reimplementing logic from scratch.

### Step 4: Build the bundle

Compile the React code using esbuild inside the Podman container:

```bash
podman exec cobuilding-container esbuild \
  .applications/<dir_name>/src/index.tsx \
  --bundle \
  --outfile=.applications/<dir_name>/dist/bundle.js \
  --jsx=automatic \
  --loader:.tsx=tsx \
  --loader:.ts=ts \
  --format=iife \
  --node-paths=/usr/lib/node_modules
```

Replace `<dir_name>` with the lowerCamelCase directory name from the `dir` field in step 1's output.

### Step 5: Open the mini-app

Call the `open_mini_application` tool with the returned `dir_name` to open the mini-application in the UI.

## Guidelines for building mini-apps

### Input and output files

- **Input data files** — use `window.filesAPI.selectFile()` to let the user pick files via the native file picker
- **Output files** — each mini-app has its own output directory at `.applications/<dir_name>/output/` (created automatically by the scaffolding script). Scripts should write all results to this directory. The app reads results from there after execution.

### Parameter flow

1. Parameters are initialized with defaults in `useState`
2. User adjusts parameters through the UI
3. On "Run", the current parameter values are passed to the container script or notebook, with the output directory set to `.applications/<dir_name>/output/`
4. The script writes output files to the mini-app's output directory
5. After execution, the app reads results from the output directory

## Bridge API

The scaffolded `index.tsx` imports a bridge that sets up `window.filesAPI` and `window.kernel` as postMessage wrappers. The mini-app can use these to communicate with the electron app:

- `window.filesAPI.readFile(path)` — Read a file from the host filesystem
- `window.filesAPI.writeFile(path, content)` — Write a file
- `window.filesAPI.selectFile(filters?)` — Open native file picker dialog
- `window.filesAPI.selectDirectory()` — Open native directory picker
- `window.filesAPI.readDirectory(path)` — List directory contents
- `window.kernel.connect(kernelName)` — Connect to a Jupyter kernel (e.g., `"ir"` for R, `"python3"` for Python)
- `window.kernel.executeCode(code)` — Execute code in the connected kernel, returns array of cell outputs
- `window.containerAPI.exec(command, args)` — Execute a command in the Podman container and return `{ stdout, stderr, exitCode }`. Use this to run R/Python scripts. Example: `window.containerAPI.exec("Rscript", [".claude/skills/differential-expression/scripts/differential_expression_cli.R", "--counts_file", "./counts.csv", "--outdir", ".applications/differentialExpression/output"])`. Timeout is 10 minutes.
- `window.getWorkspacePath()` — Returns the host filesystem path of the workspace. Use this to translate between host paths (from file pickers) and container paths. Container path = `"/data" + hostPath.slice(workspacePath.length)`. Host path = `workspacePath + containerPath.slice("/data".length)`.
