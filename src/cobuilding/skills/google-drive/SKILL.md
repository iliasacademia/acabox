---
name: google-drive
description: >
  MUST READ before using any mcp__google-drive__* tool (list_files, search_files,
  get_file_metadata, download_file). Contains required instructions for accessing
  the user's Google Drive files, scoped access rules, download caching behavior,
  and file size handling. Use when the user asks about Google Drive, cloud files,
  or any time you need to call a google-drive MCP tool.
license: Proprietary
---

# Google Drive

You have access to the user's Google Drive through MCP tools. **Only files from folders the user has explicitly connected to their workspace are accessible** — you cannot browse or access anything else in their Drive.

## Available tools

| Tool | Purpose |
|------|---------|
| `mcp__google-drive__list_files` | List files in a connected folder. Omit `folder_id` to list top-level contents of all connected folders. Pass `folder_id` to list a specific subfolder. |
| `mcp__google-drive__search_files` | Search by filename across all connected folders. Results are filtered to only include files within connected folders. |
| `mcp__google-drive__get_file_metadata` | Get detailed metadata (size, modified time, owners, description) for a file by ID. |
| `mcp__google-drive__download_file` | Download a file to the local cache. Verifies the file is within a connected folder before downloading. Returns the `containerPath` for reading. |

## Scoped access — important

The user selected specific folders from their Drive during workspace setup. All MCP tools enforce this scope:

- **`list_files`** without `folder_id` returns the contents of each connected folder (not Drive root). The response includes `connectedFolders` showing which folders are available.
- **`list_files`** with `folder_id` only works if that folder is a connected folder or a subfolder within one. Attempting to list a folder outside the scope returns an error.
- **`search_files`** searches across the user's Drive but filters results to only return files that are within connected folders. Files outside the scope are silently excluded.
- **`download_file`** verifies the file is within a connected folder before downloading. If it is not, it returns an error.

When you first interact with Drive, call `list_files()` without arguments to see which folders are connected and their contents.

## Reading file contents

Drive files are not on the local filesystem by default. To read a file's contents:

1. Use `list_files` or `search_files` to find the file and get its `id`
2. Call `download_file` with the `file_id`
3. The response includes `containerPath` — use `Read` on that path to read the contents

### File path structure

Downloaded files preserve the Drive folder structure under `/data/google-drive/`. The path is rooted at the connected folder name:

```
Connected folder: "Research Papers"
File in Drive:    Research Papers/Neuroscience/study.pdf
Container path:   /data/google-drive/Research Papers/Neuroscience/study.pdf
```

Always use the `containerPath` returned by `download_file` — do not construct paths manually.

### Caching and staleness

Downloaded files are cached locally. When you call `download_file`:
- If the file was already downloaded and hasn't changed in Drive, the cached version is returned instantly (`cached: true`)
- If the file was modified in Drive since the last download, it is automatically re-downloaded
- If the file was moved or renamed in Drive, the old cache is cleaned up and the file is downloaded to its new path

You do not need to manage cache invalidation — `download_file` handles staleness checks automatically using the file's modification timestamp and checksum.

### Google Workspace files

Google Docs, Sheets, and Slides are not regular files — they are exported to readable formats when downloaded:
- Google Docs → `.txt` (plain text)
- Google Sheets → `.csv`
- Google Slides → `.txt` (plain text)

The exported filename includes the extension (e.g. `My Document.txt`). The `containerPath` in the response reflects this.

## Download strategy

**Small files** (documents, text, code, CSVs under ~5 MB): Download freely — the overhead is minimal.

**Large files** (datasets, media, archives): Delay downloading until the user explicitly needs the file content. Instead:
- Use `get_file_metadata` to check the file's `size` before downloading
- Summarize what the file is based on its name, type, and metadata
- Only call `download_file` when the user asks you to read, analyze, or process the file
- If the file is very large (>100 MB), warn the user about the size and confirm before downloading

This avoids consuming unnecessary disk space on the user's machine.

## Common workflows

### See what's connected
```
1. list_files()                            → shows connected folders and their contents
   Response includes connectedFolders: [{id, name}, ...]
```

### Browse into a subfolder
```
1. list_files()                            → find a subfolder id
2. list_files(folder_id: "subfolder_id")   → list its contents
```

### Find and read a document
```
1. search_files(query: "thesis draft")     → get file id
2. download_file(file_id: "abc123")        → get containerPath
3. Read(file_path: containerPath)          → read the contents
```

### Check before downloading a large file
```
1. get_file_metadata(file_id: "abc123")    → check size field
2. If size is small: download_file(file_id: "abc123")
   If size is large: inform user and ask if they want to proceed
```
