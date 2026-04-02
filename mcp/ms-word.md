MCP tools for working with Microsoft Word documents.

Every tool response is automatically prefixed with `[Active document: ...]` showing which document was operated on. If the active document is not the one you expect, use `ms_word_open_document` to switch.

## Workflow: Switch to a specific document

When multiple Word documents are open, use this to target the one you want to work on:

1. Call `ms_word_open_document` with the full file path to open/focus that document
2. All subsequent MCP tool calls will operate on this document

## Workflow: Read a document

1. Call `ms_word_save_document` to ensure no unsaved changes
2. Call `ms_word_get_file_path` to get the file path
3. Read the .docx file directly using the Read tool with the returned path

Alternatively, use `ms_word_get_text` to read the document content directly (supports pagination via offset/limit).

## Workflow: Insert a paragraph

1. Save and read the document (see above)
2. Call `ms_word_position_cursor` to place cursor at the target location
3. Call `ms_word_insert_paragraph` to insert content

## Workflow: Apply a style

1. Save and read the document (see above)
2. Call `ms_word_select_text` with the text to style
3. Call `ms_word_apply_style` with the style name (e.g., "Heading 1", "Normal")

## Workflow: Apply formatting

1. Save and read the document (see above)
2. Call `ms_word_select_text` with the text to format
3. Call `ms_word_apply_formatting` with the desired formatting options (bold, italic, etc.)

## Workflow: Delete text

1. Save and read the document (see above)
2. Call `ms_word_select_text` with the exact text to delete
3. Call `ms_word_delete_selection` to remove it

## Tools

### `ms_word_open_document`
Opens (or focuses) a Word document by file path, making it the active document for all subsequent operations.
```json
{ "filePath": "/Users/me/Documents/paper.docx" }
```

### `ms_word_get_file_path`
Returns the file path and name of the active Word document. No parameters.

### `ms_word_save_document`
Saves the active Word document. No parameters. Call before reading or after editing.

### `ms_word_get_text`
Gets the text content of the active document with pagination support. Returns fileName, totalLength, offset, limit, content, and hasMore.
```json
{ "offset": 0, "limit": 8000 }
```
Both parameters are optional (defaults: offset=0, limit=8000).

### `ms_word_get_selection`
Returns the currently selected text in the active document. No parameters. Useful for verifying what is selected before deleting or formatting.

### `ms_word_position_cursor`
Places cursor before or after anchor text found via Cmd+F. Use "after" with the last ~60 chars of the preceding paragraph, or "before" with the first ~60 chars of the following paragraph.
```json
{
  "anchor": "last 60 chars of preceding paragraph text",
  "type": "after"
}
```
`type` is optional (default: "after").

### `ms_word_insert_paragraph`
Inserts a new paragraph at the current cursor position. Set `position` to match the `type` used in `ms_word_position_cursor`.
```json
{ "content": "New paragraph text.", "position": "after" }
```
`position` is optional (default: "after"). "after" = Enter then paste. "before" = paste then Enter.
`defaultColor` is optional. A hex color (e.g. `"#0000FF"`) to apply to inserted text. If omitted, text uses the document default color.

### `ms_word_select_text`
Finds and selects exact text in the document using Cmd+F and binary search on selection length.
```json
{ "text": "The exact text to select." }
```

### `ms_word_apply_style`
Applies a named paragraph style to the current selection. Use `ms_word_select_text` first.
```json
{ "style": "Heading 1" }
```
Common styles: "Normal", "Heading 1", "Heading 2", "Heading 3", "Title", "Subtitle", "Body Text".

### `ms_word_apply_formatting`
Applies character-level formatting to the current selection. Use `ms_word_select_text` first. Boolean properties: set `true` to enable, `false` to disable. Color accepts a hex string.
```json
{ "bold": true, "color": "#FF0000" }
```
Available options: `bold`, `italic`, `underline`, `strikethrough`, `allCaps`, `smallCaps`, `superscript`, `subscript`, `color` (hex string, e.g. `"#FF0000"`).

### `ms_word_delete_selection`
Deletes whatever is currently selected. No parameters.
