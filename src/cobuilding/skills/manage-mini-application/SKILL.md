---
name: manage-mini-application
description: >
  Create or edit an interactive mini-application when the user would benefit
  from an interactive UI — for example, workflows that involve tweaking
  parameters, exploring data visually, or iterating on thresholds. Each
  mini-app is a standalone React app compiled with esbuild and loaded in an
  iframe. The agent writes the React code, creates a backing Jupyter
  notebook for computation, and builds the bundle.
---

# Manage Mini-Application

Each mini-app is a standalone React app that lives in its own directory under `.applications/<lowerCamelCaseName>`. The agent writes `src/App.tsx`, creates a backing Jupyter notebook for computation, and compiles the app with esbuild. The compiled bundle is loaded in an iframe inside the electron app.

## How to create a new mini-app

### Step 1: Create the directory and DB record

Run the script directly with Node.js (do NOT use Podman):

```bash
node .claude/skills/manage-mini-application/scripts/manage_mini_app.mjs \
  --name "<display name>" \
  [--template "<template name>"]
```

If `--template` is specified, the script copies template files from `.applications/_templates/<template name>/` into the mini-app's `src/` directory. Available templates:

- `differentialExpression` — Interactive differential expression analysis UI with file pickers, design configuration, parameter tuning, and visualization display. See `templates/differential_expression.md` for a complete example including notebook structure and parameter descriptions.

The script uses the `MINI_APP_WORKSPACE_DIR` environment variable (set automatically).

The script prints a JSON object with `name`, `dir_name`, and `dir` to stdout. The `dir_name` is the lowerCamelCase directory name used to open the mini-app. The script automatically creates:
- `<dir>/src/index.html` — HTML shell with Tailwind and script tag for the bundle
- `<dir>/src/index.tsx` — React mount boilerplate (imports the bridge and renders `<App />`)
- `<dir>/dist/` — output directory for the compiled bundle
- `<dir>/output/` — output directory for notebook results (all outputs should be written here)

### Step 2: Write `src/App.tsx`

Write the mini-app's React component to `<dir>/src/App.tsx`. This is the entry point rendered by the scaffolded `index.tsx`.

You can import from these packages (pre-installed in the Podman container):
- `react`, `react-dom` — React core
- `react-plotly.js` — Plotly charts
- `lucide-react` — Icons

### Step 3: Write the backing notebook

If the mini-app needs to execute R or Python code, create a notebook at `<dir>/notebook.ipynb` using the `NotebookEdit` tool. The notebook uses a **parameter cell + action cell** pattern:

1. **Parameters cell** — A cell with a known ID (e.g., `"de-params"`) and the `parameters` tag. Contains a single JSON string variable that the React app injects before execution:

   For R (`ir` kernel):
   ```r
   params_json <- '{"key": "value", ...}'
   ```

   For Python (`python3` kernel):
   ```python
   params_json = '{"key": "value", ...}'
   ```

2. **Action cell** — A cell with a known ID (e.g., `"de-run"`) and the `action` tag. Sources existing skill scripts and calls functions with the parsed parameters. All file paths in the notebook should be **relative** so they resolve correctly on both the host and inside the container.

   For R:
   ```r
   source(".claude/skills/<skill-name>/scripts/<script>.R")
   params <- jsonlite::fromJSON(params_json)
   # Call skill functions with params...
   # All paths in params (input files, output dir) should be relative
   ```

Notebook cells can call existing skill scripts rather than reimplementing logic from scratch.

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
  --format=iife
```

Replace `<dir_name>` with the lowerCamelCase directory name from the `dir` field in step 1's output.

### Step 5: Open the mini-app

Call the `open_mini_application` tool with the returned `dir_name` to open the mini-application in the UI.

## Guidelines for building mini-apps

### All file paths must be in the workspace

All input files selected via a file picker or referenced by path must be within the workspace directory. Files outside the workspace are not accessible inside the Podman container.

When passing file paths to a backing notebook, **always use paths relative to the workspace directory** (e.g., `./sample_data/counts.csv`, `.applications/myApp/output/`). Relative paths resolve correctly both on the host and inside the Podman container.

To convert a host absolute path (returned by file pickers) to a relative path:
```typescript
const workspacePath = window.getWorkspacePath();
const relativePath = "./" + hostPath.slice(workspacePath.length + 1);
```

### Input and output files

- **Input data files** — use `window.filesAPI.selectFile()` to let the user pick files via the native file picker. The selected file must be within the workspace. Convert the returned absolute path to a relative path before passing it to the notebook.
- **Output files** — each mini-app has its own output directory at `.applications/<dir_name>/output/` (created automatically by the scaffolding script). Scripts should write all results to this directory using the relative path. The app reads results from there after execution.

### Parameter flow

1. Parameters are initialized with defaults in `useState`
2. User adjusts parameters through the UI
3. On "Run", serialize parameters to JSON, inject into the notebook's parameter cell via `window.kernel.executeCode(paramsCode)`, then read and execute the action cell via `window.kernel.executeCode(actionCode)`
4. The notebook writes output files to the mini-app's output directory
5. After execution, the app reads results from the output directory

### Notebook execution pattern

The standard `handleRun` function in a mini-app follows this pattern:

```typescript
const handleRun = async () => {
  // 1. Connect to the kernel
  await window.kernel.connect("ir"); // or "python3"

  // 2. Inject parameters
  const paramsCode = `params_json <- '${JSON.stringify(params)}'`;
  let outputs = await window.kernel.executeCode(paramsCode);

  // Check for errors
  for (const o of outputs as any[]) {
    if (o.output_type === "error") {
      setError(`${o.ename}: ${o.evalue}`);
      return;
    }
  }

  // 3. Read the notebook and find the action cell
  const nbResult = await window.filesAPI.readFile(`${APP_DIR}/notebook.ipynb`);
  const notebook = JSON.parse(nbResult.content);
  const actionCell = notebook.cells.find((c: any) => c.id === "de-run");
  const actionCode = Array.isArray(actionCell.source)
    ? actionCell.source.join("")
    : actionCell.source;

  // 4. Execute the action cell
  outputs = await window.kernel.executeCode(actionCode);

  // Check for errors
  for (const o of outputs as any[]) {
    if (o.output_type === "error") {
      setError(`${o.ename}: ${o.evalue}`);
      return;
    }
  }

  // 5. Read results from the output directory
  const resultFile = await window.filesAPI.readFile(`${APP_DIR}/output/results.json`);
  // ... process results
};
```

Where `APP_DIR` is the mini-app's directory on the host filesystem (typically obtained from `window.getWorkspacePath()` + `/.applications/<dir_name>`).

## Bridge API

The scaffolded `index.tsx` imports a bridge that sets up `window.filesAPI`, `window.kernel`, and `window.containerAPI` as postMessage wrappers. The mini-app can use these to communicate with the electron app:

### Kernel API (primary — for notebook-backed computation)

- `window.kernel.connect(kernelName)` — Connect to a Jupyter kernel. Use `"ir"` for R or `"python3"` for Python. Starts the kernel gateway container automatically if needed.
- `window.kernel.executeCode(code)` — Execute code in the connected kernel. Returns an array of cell outputs, each with an `output_type` field:
  - `"stream"` — stdout/stderr text (`name`, `text` fields)
  - `"execute_result"` — result data (`data`, `metadata`, `execution_count` fields)
  - `"display_data"` — display data like images (`data`, `metadata` fields)
  - `"error"` — execution error (`ename`, `evalue`, `traceback` fields)

### Files API

- `window.filesAPI.readFile(path)` — Read a file from the host filesystem
- `window.filesAPI.writeFile(path, content)` — Write a file
- `window.filesAPI.selectFile(filters?)` — Open native file picker dialog
- `window.filesAPI.selectDirectory()` — Open native directory picker
- `window.filesAPI.readDirectory(path)` — List directory contents

### Container API (alternative — for one-shot script execution)

- `window.containerAPI.exec(command, args)` — Execute a command in the Podman container and return `{ stdout, stderr, exitCode }`. Use this for simple one-shot script execution that doesn't need kernel state. Example: `window.containerAPI.exec("Rscript", [".claude/skills/.../script.R", "--arg", "value"])`. Timeout is 10 minutes.

### Utilities

- `window.getWorkspacePath()` — Returns the host filesystem path of the workspace. Use this to convert absolute host paths (from file pickers) to relative workspace paths: `"./" + hostPath.slice(workspacePath.length + 1)`. Relative paths resolve correctly both on the host and inside the container.
