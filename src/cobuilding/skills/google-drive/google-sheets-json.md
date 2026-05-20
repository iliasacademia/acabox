# Google Sheets JSON Structure

When a Google Sheet is downloaded via `download_file`, it is fetched as structured JSON from the Google Sheets API with `includeGridData=true`. These files can be very large — a 1000-row × 26-column sheet may produce 5MB+ of JSON. **Read in chunks using `offset`/`limit`.**

## Top-level structure

```
{
  "spreadsheetId": "...",
  "properties": { "title": "..." },
  "sheets": [
    {
      "properties": {
        "sheetId": 0,
        "title": "Sheet1",
        "gridProperties": { "rowCount": 1000, "columnCount": 26 }
      },
      "data": [
        {
          "startRow": 0,
          "startColumn": 0,
          "rowData": [ ...rows... ]
        }
      ]
    }
  ]
}
```

## Reading data

1. Read the first ~100 lines to see `sheets[].properties` — gives you sheet names and grid dimensions
2. Each sheet's cell data lives at `sheets[N].data[0].rowData` — an array of row objects
3. Each row contains `values[]` — an array of **CellData** objects

## CellData fields

| Field | What it contains |
|-------|-----------------|
| `effectiveValue` | The computed value: `{ "stringValue": "..." }` or `{ "numberValue": 42 }` or `{ "boolValue": true }` |
| `formattedValue` | The display string (e.g., "$1,234.56", "Jan 15, 2026") — usually the most useful field |
| `userEnteredValue` | What the user typed — includes formulas as `{ "formulaValue": "=SUM(A1:A10)" }` |
| `effectiveFormat` | Number format, colors, fonts, borders — **skip this unless you need styling, it's the bulk of the JSON** |
| `note` | Cell comment/note text |

## Efficient reading

- For just the values, extract `rowData[row].values[col].formattedValue`
- To find formulas, check `userEnteredValue.formulaValue`
- Skip `effectiveFormat` on every cell — it accounts for most of the file size
- Read `sheets[].properties.gridProperties` first to know dimensions before diving into `rowData`

## Multi-sheet spreadsheets

Each sheet is a separate entry in the `sheets[]` array. Check `sheets[N].properties.title` to find the sheet you need by name.

## Python examples

List all sheets and dimensions:
```bash
python3 -c "
import json, sys
wb = json.load(open(sys.argv[1]))
for s in wb['sheets']:
    p = s['properties']
    g = p.get('gridProperties', {})
    print(f'{p[\"title\"]}: {g.get(\"rowCount\",\"?\")} rows × {g.get(\"columnCount\",\"?\")} cols')
" FILE.json
```

Print a sheet as CSV:
```bash
python3 -c "
import json, sys, csv, io
wb = json.load(open(sys.argv[1]))
sheet = wb['sheets'][0]  # first sheet
out = io.StringIO()
w = csv.writer(out)
for row in sheet.get('data', [{}])[0].get('rowData', []):
    w.writerow([c.get('formattedValue', '') for c in row.get('values', [])])
print(out.getvalue())
" FILE.json
```

Extract formulas only:
```bash
python3 -c "
import json, sys
wb = json.load(open(sys.argv[1]))
for s in wb['sheets']:
    for ri, row in enumerate(s.get('data', [{}])[0].get('rowData', [])):
        for ci, cell in enumerate(row.get('values', [])):
            f = cell.get('userEnteredValue', {}).get('formulaValue')
            if f: print(f'{s[\"properties\"][\"title\"]}!R{ri+1}C{ci+1}: {f}')
" FILE.json
```
