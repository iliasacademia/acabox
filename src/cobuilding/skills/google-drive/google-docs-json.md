# Google Docs JSON Structure

When a Google Doc is downloaded via `download_file`, it is fetched as structured JSON from the Google Docs API. These files can be very large. **Read in chunks using `offset`/`limit`** — start with the first 100-200 lines to understand the structure.

## Top-level structure

```
{
  "documentId": "...",
  "title": "...",
  "tabs": [
    {
      "tabProperties": { "tabId": "...", "title": "..." },
      "documentTab": {
        "body": {
          "content": [ ...StructuralElements... ]
        }
      }
    }
  ]
}
```

## Document content

The content lives at `tabs[0].documentTab.body.content` — an array of **StructuralElement** objects. Each has a `startIndex`, `endIndex`, and exactly one of:

| Field | What it contains |
|-------|-----------------|
| `paragraph` | Text content. Contains `elements[]` array, each with a `textRun.content` string and `textRun.textStyle` for formatting. The `paragraphStyle.namedStyleType` tells you the semantic type: `HEADING_1`, `HEADING_2`, `NORMAL_TEXT`, etc. |
| `table` | A table. Contains `rows`, `columns`, and `tableRows[]` → `tableCells[]` → `content[]` (which are themselves StructuralElements, usually paragraphs). |
| `sectionBreak` | Section boundary with `sectionStyle` (column layout, page size). |
| `tableOfContents` | Auto-generated TOC with `content[]`. |

## Extracting text

1. Navigate to `tabs[0].documentTab.body.content`
2. For each StructuralElement with a `paragraph`, extract `paragraph.elements[].textRun.content`
3. Check `paragraph.paragraphStyle.namedStyleType` to identify headings vs body text

## Python examples

Extract all text with headings:
```bash
python3 -c "
import json, sys
doc = json.load(open(sys.argv[1]))
for el in doc['tabs'][0]['documentTab']['body']['content']:
    p = el.get('paragraph')
    if not p: continue
    style = p.get('paragraphStyle', {}).get('namedStyleType', '')
    text = ''.join(pe.get('textRun', {}).get('content', '') for pe in p.get('elements', []))
    if style.startswith('HEADING'):
        print(f'\n## {text.strip()}')
    elif text.strip():
        print(text, end='')
" FILE.json
```

List all tables (row × col):
```bash
python3 -c "
import json, sys
doc = json.load(open(sys.argv[1]))
for i, el in enumerate(doc['tabs'][0]['documentTab']['body']['content']):
    t = el.get('table')
    if t: print(f'Table at index {i}: {t[\"rows\"]}×{t[\"columns\"]}')
" FILE.json
```

## Other top-level fields

- `inlineObjects` — images keyed by objectId, referenced from paragraph elements via `inlineObjectElement.inlineObjectId`
- `lists` — list/bullet definitions referenced by `paragraph.bullet.listId`
- `namedStyles` — style definitions (Normal Text, Heading 1, etc.)
- `footnotes` — footnote content keyed by footnoteId, referenced from paragraph elements
- `headers` / `footers` — page header/footer content
