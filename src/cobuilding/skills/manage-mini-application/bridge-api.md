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

- `window.filesAPI.readFile(path)` — Read a file from the host filesystem. Returns a discriminated union — you must check the shape before using:
  - `{ type: "text", content: string }` — text file (most things you'll touch)
  - `{ type: "image", fileUrl: string }` — image; use `fileUrl` as an `<img src>`
  - `{ error: "too-large", size: number }` — file exceeded the 10 MB limit; nothing was read
  Common bug: `parseCsv(await window.filesAPI.readFile(path))` passes the whole object instead of `.content`. For input slots managed by `useAppState`, prefer `readInput(slot)` which extracts the text for you.
- `window.filesAPI.writeFile(path, content)` — Write a file.
- `window.filesAPI.copyFile(sourcePath, destinationDir)` — Copy a file (typically a host-absolute path returned by `selectFile`) into a workspace directory. Creates the destination directory if missing. The copy lands at `destinationDir/<basename>`. This is the right primitive for "snapshot the user's input file into the app folder so it stays available later" — `useAppState`'s `selectInput` is built on top of it.
- `window.filesAPI.deleteFile(path)` — Recursively delete a file or directory inside the workspace. Used by `useAppState`'s `selectInput` / `clearInput` to wipe the previous file in an input slot before copying the new one.
- `window.filesAPI.downloadFile(filename, content)` — Download a file to the user's computer. Shows a native save dialog with the suggested filename. The `content` is a string (use `JSON.stringify()` for objects, or generate CSV/TSV text directly).
- `window.filesAPI.showInFinder(path)` — Open the containing folder in the OS file manager and highlight the item. The `path` must be a relative workspace path.
- `window.filesAPI.selectFile(filters?)` — Open native file picker dialog. Returns the selected absolute path or `null`.
- `window.filesAPI.selectDirectory()` — Open native directory picker. Returns the selected path.
- `window.filesAPI.readDirectory(path)` — List directory contents. Returns `{ name, isDirectory }[]`.

## Container API (alternative — for one-shot script execution)

- `window.containerAPI.exec(command, args)` — Execute a command in the Podman container and return `{ stdout, stderr, exitCode }`. Use this for simple one-shot script execution that doesn't need kernel state. Example: `window.containerAPI.exec("Rscript", [".claude/skills/.../script.R", "--arg", "value"])`. Timeout is 10 minutes.

## Anthropic API

Call Claude from within a mini-app. The API key is managed by the host — it is never exposed to the iframe.

- `window.anthropicAPI.complete(params)` — Single request/response. Returns a full `AnthropicMessage` once the model finishes.
- `window.anthropicAPI.stream(params, onChunk)` — Streaming. Calls `onChunk(text)` for each text delta as it arrives, then resolves with the final `AnthropicMessage`.

**`params` fields:**
- `messages` *(required)* — `Array<{ role: "user" | "assistant"; content: string }>`
- `model` *(optional)* — defaults to `"claude-haiku-4-5-20251001"`
- `max_tokens` *(optional)* — defaults to `1024`
- `system` *(optional)* — system prompt string

**Examples:**
```typescript
// Non-streaming
const msg = await window.anthropicAPI.complete({
  messages: [{ role: 'user', content: 'Summarize this in one sentence: ...' }],
});
console.log(msg.content[0].text);

// Streaming
let output = '';
await window.anthropicAPI.stream(
  { messages: [{ role: 'user', content: 'Explain CRISPR step by step.' }] },
  (chunk) => { output += chunk; setDisplayText(output); },
);
```

## Utilities

- `window.getWorkspacePath()` — Returns the host filesystem path of the workspace. Use this to convert absolute host paths (from file pickers) to relative workspace paths: `"./" + hostPath.slice(workspacePath.length + 1)`. Relative paths resolve correctly both on the host and inside the container.
