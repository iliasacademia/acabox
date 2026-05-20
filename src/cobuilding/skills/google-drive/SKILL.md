---
name: google-drive
description: >
  MUST READ before using any mcp__google-drive__* tool (get_drive_tree, list_files,
  search_files, get_file_metadata, download_file). Contains required instructions
  for accessing the user's Google Drive files, download permissions, caching behavior,
  and file size handling. Use when the user asks about Google Drive, cloud files,
  or any time you need to call a google-drive MCP tool.
license: Proprietary
---

# Google Drive

You have access to the user's Google Drive through MCP tools. The user has selected specific files and folders that you can download — but you can browse the full Drive structure for context.

## Getting started

**Always call `get_drive_tree` first.** It returns the full tree showing the hierarchy from the Drive root down to each selected item, with contents for selected folders. Items marked with ⬇ are downloadable. This gives you the complete picture in one call.

## Available tools

| Tool | Purpose |
|------|---------|
| `mcp__google-drive__get_drive_tree` | **Start here.** Returns the connected Drive tree with hierarchy, metadata, and download markers. |
| `mcp__google-drive__download_file` | Download a file (must be marked ⬇ or inside a ⬇ folder). Returns `containerPath` for reading. |
| `mcp__google-drive__search_files` | Search by filename across the user's entire Drive, including shared drives. |
| `mcp__google-drive__list_files` | List files in any Drive folder. For exploring outside the connected tree. |
| `mcp__google-drive__get_file_metadata` | Get detailed metadata for any file by ID. |

## Browse vs download permissions

- **Browsing** is unrestricted — `list_files`, `search_files`, and `get_file_metadata` work on any Drive item.
- **Downloading** is restricted to items the user selected (marked ⬇ in the tree) or descendants of selected folders.

## Reading file contents

1. Call `get_drive_tree` to see what's available and find file IDs
2. Call `download_file` with the `file_id`
3. Use `Read` on the returned `containerPath` to read the contents

Always use the `containerPath` returned by `download_file` — do not construct paths manually.

### Caching

Downloaded files are cached locally. `download_file` handles staleness checks automatically — if the file changed in Drive, it re-downloads; otherwise returns the cached version instantly.

### Google Workspace files

Google Docs, Sheets, and Slides are fetched as structured JSON via their native APIs:
- Google Docs → `.json` (full document structure including headings, tables, lists, formatting)
- Google Sheets → `.json` (all sheets, cell values, formulas, formatting)
- Google Slides → `.json` (slide structure, text, speaker notes)
- Google Drawings → `.png`

## Download strategy

**Small files** (under ~5 MB): Download freely.

**Large files**: Check `size` in the tree metadata or via `get_file_metadata` before downloading. If >100 MB, warn the user and confirm before proceeding.

## Common workflows

### See what's connected and read a file
```
1. get_drive_tree()                        → see full tree with ⬇ markers
2. download_file(file_id: "abc123")        → get containerPath
3. Read(file_path: containerPath)          → read contents
```

### Find a file not in the connected tree
```
1. search_files(query: "quarterly report") → find file id
2. download_file(file_id: "xyz789")        → only works if within a ⬇ folder
```
