/**
 * `shared/fileKinds.ts` — the single source of truth for how an extension
 * maps to a `files:readFile` result kind, shared by `main/fileHandlers.ts`
 * and the viewer shim (V1). Precedence must match the handler exactly:
 * image, then pdf, then spreadsheet, then markdown, then csv, else text.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  IMAGE_EXTENSIONS,
  PDF_EXTENSIONS,
  SPREADSHEET_EXTENSIONS,
  MARKDOWN_EXTENSIONS,
  CSV_EXTENSIONS,
  classifyForBridge,
  csvDelimiterFor,
} from '../fileKinds';

describe('classifyForBridge', () => {
  it('classifies an image extension', () => {
    expect(classifyForBridge('photo.png')).toBe('image');
    expect(classifyForBridge('scan.tiff')).toBe('image');
  });

  it('classifies a pdf extension', () => {
    expect(classifyForBridge('paper.pdf')).toBe('pdf');
  });

  it('classifies a spreadsheet extension', () => {
    expect(classifyForBridge('data.xlsx')).toBe('spreadsheet');
    expect(classifyForBridge('legacy.xlsm')).toBe('spreadsheet');
  });

  it('classifies a markdown extension', () => {
    expect(classifyForBridge('README.md')).toBe('markdown');
    expect(classifyForBridge('notes.markdown')).toBe('markdown');
  });

  it('classifies a csv extension', () => {
    expect(classifyForBridge('table.csv')).toBe('csv');
    expect(classifyForBridge('table.tsv')).toBe('csv');
  });

  it('falls back to text for anything else', () => {
    expect(classifyForBridge('main.py')).toBe('text');
    expect(classifyForBridge('notes.txt')).toBe('text');
  });

  it('is case-insensitive on the extension', () => {
    expect(classifyForBridge('PHOTO.PNG')).toBe('image');
    expect(classifyForBridge('Paper.PDF')).toBe('pdf');
    expect(classifyForBridge('Data.XLSX')).toBe('spreadsheet');
    expect(classifyForBridge('README.MD')).toBe('markdown');
    expect(classifyForBridge('Table.CSV')).toBe('csv');
  });

  it('classifies a file with no extension as text', () => {
    expect(classifyForBridge('Makefile')).toBe('text');
    expect(classifyForBridge('LICENSE')).toBe('text');
  });

  it('treats a dotfile with no other dot as having no extension', () => {
    // Mirrors path.extname('.gitignore') === '' — matches the handler's
    // `path.extname(resolved).slice(1)` exactly.
    expect(classifyForBridge('.gitignore')).toBe('text');
  });

  it('uses the last extension in a path with directory components', () => {
    expect(classifyForBridge('w/.applications/x/output/chart.png')).toBe('image');
    expect(classifyForBridge('a\\b\\report.pdf')).toBe('pdf');
  });

  it('applies handler precedence: image before pdf, spreadsheet, markdown and csv', () => {
    // No single extension is a member of two sets today, but the precedence
    // order itself is what this locks in — see the module doc comment.
    for (const ext of IMAGE_EXTENSIONS) {
      expect(PDF_EXTENSIONS.has(ext)).toBe(false);
      expect(SPREADSHEET_EXTENSIONS.has(ext)).toBe(false);
      expect(MARKDOWN_EXTENSIONS.has(ext)).toBe(false);
      expect(CSV_EXTENSIONS.has(ext)).toBe(false);
    }
  });
});

describe('csvDelimiterFor', () => {
  it('returns a tab for .tsv', () => {
    expect(csvDelimiterFor('table.tsv')).toBe('\t');
    expect(csvDelimiterFor('TABLE.TSV')).toBe('\t');
  });

  it('returns the empty string for .csv and anything else', () => {
    expect(csvDelimiterFor('table.csv')).toBe('');
    expect(csvDelimiterFor('notes.txt')).toBe('');
  });
});

describe('extension set contents', () => {
  it('matches the exact members fileHandlers.ts used to define inline', () => {
    expect([...IMAGE_EXTENSIONS].sort()).toEqual(
      ['bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp'].sort()
    );
    expect([...PDF_EXTENSIONS].sort()).toEqual(['pdf']);
    expect([...SPREADSHEET_EXTENSIONS].sort()).toEqual(['xlsm', 'xlsx']);
    expect([...MARKDOWN_EXTENSIONS].sort()).toEqual(['markdown', 'mdown', 'mkd', 'mkdn', 'md'].sort());
    expect([...CSV_EXTENSIONS].sort()).toEqual(['csv', 'tsv']);
  });
});

describe('fileHandlers.ts no longer defines the extension sets inline', () => {
  it('imports the sets from shared/fileKinds instead of redeclaring them', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'main', 'fileHandlers.ts'),
      'utf-8'
    );
    // None of the five sets this ticket moved should still be constructed
    // inline in fileHandlers.ts.
    expect(source).not.toMatch(/IMAGE_EXTENSIONS\s*=\s*new Set\(/);
    expect(source).not.toMatch(/PDF_EXTENSIONS\s*=\s*new Set\(/);
    expect(source).not.toMatch(/SPREADSHEET_EXTENSIONS\s*=\s*new Set\(/);
    expect(source).not.toMatch(/MARKDOWN_EXTENSIONS\s*=\s*new Set\(/);
    expect(source).not.toMatch(/CSV_EXTENSIONS\s*=\s*new Set\(/);
    expect(source).toMatch(/from ['"]\.\.\/shared\/fileKinds['"]/);
  });
});
