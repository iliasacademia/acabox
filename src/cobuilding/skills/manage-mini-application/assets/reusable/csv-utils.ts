export const parseCsvLine = (line: string): string[] => {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      let end = i + 1;
      while (end < line.length) {
        if (line[end] === '"') {
          if (line[end + 1] === '"') {
            end += 2;
          } else {
            break;
          }
        } else {
          end++;
        }
      }
      fields.push(line.slice(i + 1, end));
      i = end + 2;
    } else {
      const comma = line.indexOf(",", i);
      if (comma === -1) {
        fields.push(line.slice(i));
        break;
      }
      fields.push(line.slice(i, comma));
      i = comma + 1;
    }
  }
  return fields;
};

export interface CSVPreview {
  path: string;
  fileName: string;
  rowCount: number;
  columnCount: number;
  headers: string[];
  previewRows: string[][];
}

export const parseCSVPreview = (
  path: string,
  csvText: string,
): CSVPreview => {
  const lines = csvText.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return {
      path,
      fileName: path.split("/").pop() || path,
      rowCount: 0,
      columnCount: 0,
      headers: [],
      previewRows: [],
    };
  }

  const headers = parseCsvLine(lines[0]);
  const dataLines = lines.slice(1);
  const previewRows = dataLines.slice(0, 3).map(parseCsvLine);

  return {
    path,
    fileName: path.split("/").pop() || path,
    rowCount: dataLines.length,
    columnCount: headers.length,
    headers,
    previewRows,
  };
};
