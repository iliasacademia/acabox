# Bridge API Reference

The scaffolded `index.tsx` imports a bridge that sets up `window.filesAPI`, `window.kernel`, and `window.containerAPI` as postMessage wrappers. The mini-app can use these to communicate with the electron app.

## Kernel API (primary — for notebook-backed computation)

- `window.kernel.connect(kernelName)` — Connect to a Jupyter kernel. Use `"ir"` for R or `"python3"` for Python. Starts the kernel gateway container automatically if needed.
- `window.kernel.executeCode(code)` — Execute code in the connected kernel. Returns an array of cell outputs, each with an `output_type` field:
  - `"stream"` — stdout/stderr text (`name`, `text` fields)
  - `"execute_result"` — result data (`data`, `metadata`, `execution_count` fields)
  - `"display_data"` — display data like images (`data`, `metadata` fields)
  - `"error"` — execution error (`ename`, `evalue`, `traceback` fields)

## Files API

- `window.filesAPI.readFile(path)` — Read a file from the host filesystem. Returns `{ type: string, content: string }`.
- `window.filesAPI.writeFile(path, content)` — Write a file.
- `window.filesAPI.selectFile(filters?)` — Open native file picker dialog. Returns the selected absolute path or `null`.
- `window.filesAPI.selectDirectory()` — Open native directory picker. Returns the selected path.
- `window.filesAPI.readDirectory(path)` — List directory contents. Returns `{ name, isDirectory }[]`.

## Container API (alternative — for one-shot script execution)

- `window.containerAPI.exec(command, args)` — Execute a command in the Podman container and return `{ stdout, stderr, exitCode }`. Use this for simple one-shot script execution that doesn't need kernel state. Example: `window.containerAPI.exec("Rscript", [".claude/skills/.../script.R", "--arg", "value"])`. Timeout is 10 minutes.

## Utilities

- `window.getWorkspacePath()` — Returns the host filesystem path of the workspace. Use this to convert absolute host paths (from file pickers) to relative workspace paths: `"./" + hostPath.slice(workspacePath.length + 1)`. Relative paths resolve correctly both on the host and inside the container.
