# Google Slides JSON Structure

When a Google Slides presentation is downloaded via `download_file`, it is fetched as structured JSON from the Google Slides API. **Read in chunks using `offset`/`limit`** — start with the first 50-100 lines to get the title and slide count.

## Top-level structure

```
{
  "presentationId": "...",
  "pageSize": { "width": {...}, "height": {...} },
  "title": "...",
  "slides": [
    {
      "objectId": "slide_001",
      "pageElements": [ ...shapes, images, tables... ],
      "slideProperties": {
        "notesPage": {
          "pageElements": [ ...speaker notes... ]
        }
      }
    }
  ],
  "masters": [...],
  "layouts": [...]
}
```

## Slide content

Each slide's content lives at `slides[N].pageElements` — an array of **PageElement** objects. Each has a `size`, `transform` (position), and exactly one of:

| Field | What it contains |
|-------|-----------------|
| `shape` | A text box or shape. Text is at `shape.text.textElements[]` (see below). The `shape.placeholder.type` field identifies it: `TITLE`, `SUBTITLE`, `BODY`, `SLIDE_NUMBER`, etc. |
| `table` | A table with `rows`, `columns`, and `tableRows[]` → `tableCells[]` → `text.textElements[]`. |
| `image` | An image with `contentUrl` and `imageProperties`. |
| `elementGroup` | A group of child `pageElements`. |

## Text extraction

Text inside a shape is at `shape.text.textElements[]` — an array of **TextElement** objects. Each has either:

- `paragraphMarker` — marks the start of a new paragraph, with `style` (alignment, spacing) and optional `bullet` (for lists)
- `textRun` — the actual text in `textRun.content`, with character-level styling in `textRun.style`

To extract all text from a shape: collect all `textRun.content` strings from its `textElements`.

## Speaker notes

Notes for each slide are at `slides[N].slideProperties.notesPage.pageElements` — same structure as slide pageElements. Look for shapes with text to get the notes content.

## Tips

- Use `shape.placeholder.type` to identify title vs body text on each slide
- Skip `masters` and `layouts` arrays — they contain template definitions, not user content
- The `transform` field gives position/rotation in EMU (English Metric Units) — only relevant if you need spatial layout

## Python examples

Extract all slide text (title + body):
```bash
python3 -c "
import json, sys
pres = json.load(open(sys.argv[1]))
for i, slide in enumerate(pres.get('slides', []), 1):
    print(f'--- Slide {i} ---')
    for pe in slide.get('pageElements', []):
        shape = pe.get('shape', {})
        ph = shape.get('placeholder', {}).get('type', '')
        texts = []
        for te in shape.get('text', {}).get('textElements', []):
            content = te.get('textRun', {}).get('content', '')
            if content.strip(): texts.append(content)
        if texts:
            label = f'[{ph}] ' if ph else ''
            print(f'{label}{\"  \".join(t.strip() for t in texts)}')
" FILE.json
```

Extract speaker notes:
```bash
python3 -c "
import json, sys
pres = json.load(open(sys.argv[1]))
for i, slide in enumerate(pres.get('slides', []), 1):
    notes_page = slide.get('slideProperties', {}).get('notesPage', {})
    texts = []
    for pe in notes_page.get('pageElements', []):
        for te in pe.get('shape', {}).get('text', {}).get('textElements', []):
            c = te.get('textRun', {}).get('content', '')
            if c.strip(): texts.append(c.strip())
    if texts: print(f'Slide {i} notes: {\" \".join(texts)}')
" FILE.json
```
