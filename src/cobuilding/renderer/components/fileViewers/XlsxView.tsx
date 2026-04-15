import React, { useEffect, useRef, useState, type CSSProperties, type FC } from 'react';
import ExcelJS from 'exceljs';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';

interface XlsxViewProps {
  base64: string;
}

const ROW_HEIGHT = 28;

interface ParsedCell {
  text: string;
  /** Inline style derived from the cell's fill / font / alignment. */
  style?: CSSProperties;
  hyperlink?: string;
}

type Row = Record<string, ParsedCell>;

interface ParsedSheet {
  name: string;
  columns: ColumnDef<Row>[];
  rows: Row[];
  /** Header row also gets parsed cell styling so the toolbar/header renders Excel-true. */
  headerStyles: Record<string, CSSProperties | undefined>;
}

interface ParsedWorkbook {
  ok: true;
  sheets: ParsedSheet[];
}

interface ParseFailure {
  ok: false;
  error: string;
}

export const XlsxView: FC<XlsxViewProps> = ({ base64 }) => {
  const [parsed, setParsed] = useState<ParsedWorkbook | ParseFailure | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setParsed(null);
    parseWorkbook(base64).then((result) => {
      if (cancelled) return;
      setParsed(result);
      setActiveSheet(0);
    });
    return () => { cancelled = true; };
  }, [base64]);

  if (parsed === null) {
    return <p className="fileViewerMessage">Parsing spreadsheet…</p>;
  }
  if (!parsed.ok) {
    return <p className="fileViewerMessage">Failed to parse spreadsheet: {parsed.error}</p>;
  }
  if (parsed.sheets.length === 0) {
    return <p className="fileViewerMessage">Workbook contains no visible sheets.</p>;
  }

  const safeIndex = Math.min(activeSheet, parsed.sheets.length - 1);
  const sheet = parsed.sheets[safeIndex];

  return (
    <div className="xlsxView">
      <SheetTable key={sheet.name} sheet={sheet} />
      <div className="xlsxViewTabs" role="tablist">
        {parsed.sheets.map((s, i) => (
          <button
            key={s.name}
            type="button"
            role="tab"
            aria-selected={i === safeIndex}
            className={`xlsxViewTab${i === safeIndex ? ' xlsxViewTab--active' : ''}`}
            onClick={() => setActiveSheet(i)}
          >
            {s.name}
          </button>
        ))}
      </div>
    </div>
  );
};

const SheetTable: FC<{ sheet: ParsedSheet }> = ({ sheet }) => {
  const [sorting, setSorting] = useState<SortingState>([]);

  const table = useReactTable({
    data: sheet.rows,
    columns: sheet.columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRows = table.getRowModel().rows;

  const rowVirtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  if (sheet.rows.length === 0) {
    return <p className="fileViewerMessage">Sheet is empty.</p>;
  }

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom =
    virtualRows.length > 0 ? totalSize - virtualRows[virtualRows.length - 1].end : 0;

  return (
    <>
      <div className="csvViewMeta">
        {sheet.rows.length.toLocaleString()} rows · {sheet.columns.length} columns
      </div>
      <div ref={scrollRef} className="csvViewScroll">
        <table className="csvViewTable">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  const headerStyle = sheet.headerStyles[header.column.id];
                  return (
                    <th
                      key={header.id}
                      onClick={header.column.getToggleSortingHandler()}
                      className="csvViewHeader"
                      style={headerStyle}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {sorted === 'asc' ? ' ▲' : sorted === 'desc' ? ' ▼' : ''}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {paddingTop > 0 && (
              <tr>
                <td colSpan={sheet.columns.length} style={{ height: paddingTop, padding: 0, border: 0 }} />
              </tr>
            )}
            {virtualRows.map((virtualRow) => {
              const row = tableRows[virtualRow.index];
              return (
                <tr key={row.id} style={{ height: ROW_HEIGHT }}>
                  {row.getVisibleCells().map((cell) => {
                    const cellValue = cell.getValue() as ParsedCell | undefined;
                    return (
                      <td
                        key={cell.id}
                        className="csvViewCell"
                        style={cellValue?.style}
                      >
                        {cellValue?.hyperlink ? (
                          <a
                            href={cellValue.hyperlink}
                            target="_blank"
                            rel="noreferrer"
                            className="xlsxViewHyperlink"
                          >
                            {cellValue.text}
                          </a>
                        ) : (
                          cellValue?.text ?? ''
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {paddingBottom > 0 && (
              <tr>
                <td colSpan={sheet.columns.length} style={{ height: paddingBottom, padding: 0, border: 0 }} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
};

async function parseWorkbook(base64: string): Promise<ParsedWorkbook | ParseFailure> {
  try {
    const buffer = base64ToArrayBuffer(base64);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);

    const sheets: ParsedSheet[] = [];
    for (const ws of wb.worksheets) {
      // Skip hidden/very-hidden sheets — Excel honors these and the user
      // probably doesn't want to scroll past internal lookup tables.
      if (ws.state === 'hidden' || ws.state === 'veryHidden') continue;

      const colCount = ws.actualColumnCount > 0 ? ws.actualColumnCount : ws.columnCount;
      if (colCount === 0) {
        sheets.push({ name: ws.name, columns: [], rows: [], headerStyles: {} });
        continue;
      }

      // Read header row (row 1). Empty header cells get column letters.
      const headerExcelRow = ws.getRow(1);
      const fieldNames: string[] = [];
      const headerStylesByKey: Record<string, CSSProperties | undefined> = {};
      const accessorKeys: string[] = [];
      const seenKeys = new Map<string, number>();

      for (let c = 1; c <= colCount; c++) {
        const cell = headerExcelRow.getCell(c);
        const text = cellDisplayText(cell);
        const label = text === '' ? excelColumnLetter(c - 1) : text;
        fieldNames.push(label);

        // Disambiguate duplicate headers so accessor keys don't collide.
        const seen = seenKeys.get(label) ?? 0;
        seenKeys.set(label, seen + 1);
        const key = seen === 0 ? label : `${label}__${seen + 1}`;
        accessorKeys.push(key);
        headerStylesByKey[key] = cellStyle(cell);
      }

      const columns: ColumnDef<Row>[] = accessorKeys.map((key, i) => ({
        accessorKey: key,
        header: fieldNames[i],
        // The accessor returns the full ParsedCell so the cell renderer can
        // read text + style + hyperlink. Sort comparisons need the underlying
        // text, which TanStack would otherwise stringify as "[object Object]".
        sortingFn: (a, b, columnId) => {
          const av = (a.getValue(columnId) as ParsedCell | undefined)?.text ?? '';
          const bv = (b.getValue(columnId) as ParsedCell | undefined)?.text ?? '';
          return av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
        },
      }));

      const rows: Row[] = [];
      const rowCount = ws.actualRowCount > 0 ? ws.actualRowCount : ws.rowCount;
      // Walk data rows starting at row 2.
      for (let r = 2; r <= rowCount; r++) {
        const excelRow = ws.getRow(r);
        // Skip entirely blank rows so they don't pad the bottom of the view.
        if (!excelRow.hasValues) continue;
        const obj: Row = {};
        for (let c = 1; c <= colCount; c++) {
          const cell = excelRow.getCell(c);
          obj[accessorKeys[c - 1]] = {
            text: cellDisplayText(cell),
            style: cellStyle(cell),
            hyperlink: cellHyperlink(cell),
          };
        }
        rows.push(obj);
      }

      sheets.push({ name: ws.name, columns, rows, headerStyles: headerStylesByKey });
    }

    return { ok: true, sheets };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function cellDisplayText(cell: ExcelJS.Cell): string {
  // ExcelJS computes `cell.text` from the cell's value + numFmt — same string
  // Excel itself would display. This is what users expect to see.
  if (cell.text !== undefined && cell.text !== null) {
    const t = String(cell.text);
    return t === 'undefined' ? '' : t;
  }
  return '';
}

function cellHyperlink(cell: ExcelJS.Cell): string | undefined {
  const v = cell.value as { hyperlink?: string } | null;
  if (v && typeof v === 'object' && typeof v.hyperlink === 'string') {
    return v.hyperlink;
  }
  return undefined;
}

/**
 * Translate ExcelJS style fields (fill / font / alignment) into a CSS object.
 * Returns `undefined` when the cell has no styling worth applying.
 */
function cellStyle(cell: ExcelJS.Cell): CSSProperties | undefined {
  const out: CSSProperties = {};

  // Background: Excel fills are usually `pattern: 'solid'` with `fgColor`
  // holding the visible color. Skip pattern and gradient fills for now.
  const fill = cell.fill;
  if (fill && fill.type === 'pattern' && fill.pattern === 'solid') {
    const color = argbToCss(fill.fgColor) ?? argbToCss(fill.bgColor);
    if (color) out.background = color;
  }

  const font = cell.font;
  if (font) {
    const fontColor = argbToCss(font.color);
    if (fontColor) out.color = fontColor;
    if (font.bold) out.fontWeight = 600;
    if (font.italic) out.fontStyle = 'italic';
    if (font.underline) out.textDecoration = 'underline';
  }

  const alignment = cell.alignment;
  if (alignment?.horizontal) {
    if (alignment.horizontal === 'right' || alignment.horizontal === 'center') {
      out.textAlign = alignment.horizontal;
    } else if (alignment.horizontal === 'left') {
      out.textAlign = 'left';
    }
  } else if (typeof cell.value === 'number') {
    // Excel convention: numbers right-align by default.
    out.textAlign = 'right';
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

interface ColorLike {
  argb?: string;
  theme?: number;
  tint?: number;
}

/**
 * Convert ExcelJS's color shape ({ argb: 'FFRRGGBB' }) to a CSS color.
 * Theme-based colors aren't resolved here — ExcelJS doesn't expand the theme
 * palette without extra work, so we'd need a theme map per workbook. For now
 * we silently skip them; the cell renders with no fill/color override.
 */
function argbToCss(color: ColorLike | undefined): string | undefined {
  if (!color) return undefined;
  if (typeof color.argb === 'string' && /^[0-9A-Fa-f]{8}$/.test(color.argb)) {
    // ExcelJS argb is alpha-first ("AARRGGBB"). Convert to "#RRGGBBAA" for CSS.
    const a = color.argb.slice(0, 2);
    const rgb = color.argb.slice(2);
    // Drop alpha when fully opaque to keep DOM diffing tidy.
    return a.toUpperCase() === 'FF' ? `#${rgb}` : `#${rgb}${a}`;
  }
  return undefined;
}

/** A1-style column letters (A, B, …, Z, AA, AB, …) for unnamed columns. */
function excelColumnLetter(index: number): string {
  let s = '';
  let n = index;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
