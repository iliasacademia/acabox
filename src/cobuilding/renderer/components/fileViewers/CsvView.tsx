import React, { useMemo, useRef, type FC } from 'react';
import Papa from 'papaparse';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';

interface CsvViewProps {
  content: string;
  delimiter: string;
}

type Row = Record<string, string>;

const ROW_HEIGHT = 28;

export const CsvView: FC<CsvViewProps> = ({ content, delimiter }) => {
  const { columns, rows, error } = useMemo(() => parseCsv(content, delimiter), [content, delimiter]);
  const [sorting, setSorting] = React.useState<SortingState>([]);

  const table = useReactTable({
    data: rows,
    columns,
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

  if (error) {
    return <p className="fileViewerMessage">Failed to parse CSV: {error}</p>;
  }

  if (rows.length === 0) {
    return <p className="fileViewerMessage">CSV is empty.</p>;
  }

  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom =
    virtualRows.length > 0 ? totalSize - virtualRows[virtualRows.length - 1].end : 0;

  return (
    <div className="csvView">
      <div className="csvViewMeta">
        {rows.length.toLocaleString()} rows · {columns.length} columns
      </div>
      <div ref={scrollRef} className="csvViewScroll">
        <table className="csvViewTable">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      onClick={header.column.getToggleSortingHandler()}
                      className="csvViewHeader"
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
                <td colSpan={columns.length} style={{ height: paddingTop, padding: 0, border: 0 }} />
              </tr>
            )}
            {virtualRows.map((virtualRow) => {
              const row = tableRows[virtualRow.index];
              return (
                <tr key={row.id} style={{ height: ROW_HEIGHT }}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="csvViewCell">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
            {paddingBottom > 0 && (
              <tr>
                <td
                  colSpan={columns.length}
                  style={{ height: paddingBottom, padding: 0, border: 0 }}
                />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

function parseCsv(
  content: string,
  delimiter: string,
): { columns: ColumnDef<Row>[]; rows: Row[]; error: string | null } {
  const parsed = Papa.parse<Row>(content, {
    delimiter,
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors.length > 0 && parsed.data.length === 0) {
    return { columns: [], rows: [], error: parsed.errors[0].message };
  }

  const fields = parsed.meta.fields ?? [];
  const columns: ColumnDef<Row>[] = fields.map((field) => ({
    accessorKey: field,
    header: field,
    cell: (info) => info.getValue() as string,
  }));

  return { columns, rows: parsed.data, error: null };
}
