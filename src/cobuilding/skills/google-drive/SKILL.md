---
name: google-drive
description: >
  MUST READ before using any mcp__google-drive__* tool (get_drive_tree,
  search_files, download_file). Contains required instructions for accessing
  the user's Google Drive files, download permissions, caching behavior,
  and how to navigate the JSON structure of Google Workspace files.
  Use when the user asks about Google Drive, cloud files, or any time
  you need to call a google-drive MCP tool.
license: Proprietary
---

# Google Drive

You have access to the user's Google Drive through MCP tools. The user has selected specific files and folders that you can download.

## Getting started

**Always call `get_drive_tree` first.** It returns the full tree showing the hierarchy from the Drive root down to each selected item, with contents for selected folders. Items marked with ⬇ are downloadable. Each item includes its file ID inline for use with `download_file`.

## Available tools

| Tool | Purpose |
|------|---------|
| `mcp__google-drive__get_drive_tree` | **Start here.** Returns the connected Drive tree with hierarchy, metadata, and download markers (⬇). |
| `mcp__google-drive__search_files` | Search by filename within connected files. Only returns downloadable results. |
| `mcp__google-drive__download_file` | Download a file (must be marked ⬇ or inside a ⬇ folder). Returns `containerPath` for reading. |

## Download permissions

Only items the user selected are downloadable:
- Items marked ⬇ in the tree can be downloaded directly
- All descendants of a ⬇ folder can be downloaded
- Ancestor folders shown for context (without ⬇) are not downloadable

## Reading file contents

1. Call `get_drive_tree` to see what's available and find file IDs
2. Call `download_file` with the `file_id`
3. Use `Read` on the returned `containerPath` to read the contents

Always use the `containerPath` returned by `download_file` — do not construct paths manually.

### Caching

Downloaded files are cached locally. `download_file` handles staleness checks automatically — if the file changed in Drive, it re-downloads; otherwise returns the cached version instantly.

## Google Workspace files

Google Docs, Sheets, and Slides are fetched as structured JSON via their native APIs. These files can be very large. **Do not read the entire file at once.** Use `Read` with `offset` and `limit` to read specific sections.

| Type | Extension | JSON structure reference |
|------|-----------|------------------------|
| Google Docs | `.json` | See [google-docs-json.md](google-docs-json.md) |
| Google Sheets | `.json` | See [google-sheets-json.md](google-sheets-json.md) |
| Google Slides | `.json` | See [google-slides-json.md](google-slides-json.md) |
| Google Drawings | `.png` | PNG image — read directly |

Read the relevant reference file before navigating a downloaded Google Workspace file.

## Download strategy

**Small files** (under ~5 MB): Download freely.

**Large files**: Check the size shown in the tree metadata before downloading. If >100 MB, warn the user and confirm before proceeding.

**Google Workspace JSON**: Always read in chunks. Start with the first 100-200 lines to understand the structure, then target specific sections with `offset`/`limit`. For complex queries, use Python:

```bash
python3 -c "
import json, sys
doc = json.load(open(sys.argv[1]))
# Example: extract all paragraph text from a Google Doc
for el in doc['tabs'][0]['documentTab']['body']['content']:
    for pe in el.get('paragraph', {}).get('elements', []):
        text = pe.get('textRun', {}).get('content', '')
        if text.strip():
            print(text, end='')
" /data/google-drive/{fileId}/filename.json
```

## Example workflow

```
1. get_drive_tree()                        → see full tree with ⬇ markers and file IDs
2. download_file(file_id: "abc123")        → get containerPath
3. Read(file_path: containerPath, limit: 200)  → read first 200 lines for structure
4. Read(file_path: containerPath, offset: 50, limit: 500)  → read specific section
```
