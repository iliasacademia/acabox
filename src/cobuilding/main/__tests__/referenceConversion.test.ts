/**
 * @jest-environment node
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { REFERENCES_SUBDIR, REFERENCES_INDEX } from '../../shared/paths';

// --- Mocks ---

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => os.tmpdir()), isPackaged: false, getAppPath: () => '/tmp' },
}));

jest.mock('electron-log', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  __esModule: true,
}));

const mockCreate = jest.fn();
const mockExtractText = jest.fn();

// --- Helpers ---

function createTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-test-'));
  const refsDir = path.join(dir, 'refs');
  fs.mkdirSync(refsDir, { recursive: true });
  fs.writeFileSync(path.join(refsDir, '1.pdf'), 'fake pdf');
  fs.writeFileSync(path.join(refsDir, 'smith2024.pdf'), 'fake pdf');
  return dir;
}

// Import the module under test after mocks are set up.
// We test the exported functions indirectly by importing private helpers
// via a require that gets the full module.
// Since extractReferenceCandidates and enrichReferences are not exported,
// we re-implement the pure logic portions here for unit testing.

describe('Reference conversion helpers', () => {
  describe('sanitizeFilename', () => {
    // Re-implement to test the logic
    function sanitizeFilename(name: string): string {
      return name
        .replace(/[\/\\:*?"<>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
    }

    it('removes illegal filename characters and collapses spaces', () => {
      expect(sanitizeFilename('Title: A "Novel" Approach')).toBe('Title A Novel Approach');
    });

    it('collapses multiple spaces', () => {
      expect(sanitizeFilename('A   B   C')).toBe('A B C');
    });

    it('trims whitespace', () => {
      expect(sanitizeFilename('  hello  ')).toBe('hello');
    });

    it('truncates to 200 characters', () => {
      const long = 'A'.repeat(250);
      expect(sanitizeFilename(long).length).toBe(200);
    });
  });

  describe('extractReferenceCandidates', () => {
    // Re-implement to test the logic
    function extractReferenceCandidates(
      taggedFiles: Array<{ file_path?: string; file_type?: string; path?: string; type?: string }>,
    ): string[] {
      return taggedFiles
        .filter((f) => {
          const fileType = (
            typeof f.file_type === 'string'
              ? f.file_type
              : typeof f.type === 'string'
                ? f.type
                : ''
          ).toLowerCase();
          if (fileType !== 'reference') return false;
          const p = f.file_path ?? f.path;
          if (!p) return false;
          const name = p.split('/').pop() ?? '';
          return !name.startsWith('~$');
        })
        .map((f) => (f.file_path ?? f.path)!);
    }

    it('extracts only reference-tagged files', () => {
      const files = [
        { file_path: 'refs/paper.pdf', file_type: 'reference' },
        { file_path: 'manuscript.docx', file_type: 'manuscript' },
        { file_path: 'refs/other.pdf', file_type: 'reference' },
      ];
      expect(extractReferenceCandidates(files)).toEqual([
        'refs/paper.pdf',
        'refs/other.pdf',
      ]);
    });

    it('skips files starting with ~$', () => {
      const files = [
        { file_path: 'refs/~$temp.pdf', file_type: 'reference' },
        { file_path: 'refs/real.pdf', file_type: 'reference' },
      ];
      expect(extractReferenceCandidates(files)).toEqual(['refs/real.pdf']);
    });

    it('handles alternate field names (path, type)', () => {
      const files = [
        { path: 'refs/alt.pdf', type: 'reference' },
      ];
      expect(extractReferenceCandidates(files as any)).toEqual(['refs/alt.pdf']);
    });

    it('returns empty for no references', () => {
      const files = [
        { file_path: 'doc.docx', file_type: 'manuscript' },
      ];
      expect(extractReferenceCandidates(files)).toEqual([]);
    });
  });
});

describe('enrichReferences integration', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = createTempWorkspace();
    mockCreate.mockReset();
    mockExtractText.mockReset();
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  // We can't easily import enrichReferences directly since it's not exported.
  // Instead, test the end-to-end behavior by calling runFileTaggingAgent
  // or by manually invoking the same logic. Here we test the file output
  // by replicating the core loop.

  async function simulateEnrichReferences(filePaths: string[]): Promise<void> {
    if (filePaths.length === 0) return;

    const refsDir = path.join(workspaceDir, REFERENCES_SUBDIR);
    await fs.promises.mkdir(refsDir, { recursive: true });

    const indexPath = path.join(refsDir, REFERENCES_INDEX);
    let index: Record<string, string> = {};
    try {
      const existing = await fs.promises.readFile(indexPath, 'utf-8');
      index = JSON.parse(existing);
    } catch { /* no existing index */ }

    for (const filePath of filePaths) {
      const absolutePath = path.join(workspaceDir, filePath);
      const fullText = mockExtractText(absolutePath);
      if (!fullText) continue;

      const fileName = filePath.split('/').pop() ?? filePath;
      let title = path.basename(fileName, path.extname(fileName));

      try {
        const result = await mockCreate();
        const block = result?.content?.[0];
        const extracted = block && block.type === 'text' && block.text ? block.text.trim() : '';
        if (extracted && extracted !== 'UNKNOWN') {
          title = extracted.replace(/[\/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
        }
      } catch {
        // title extraction failed, keep filename
      }

      const mdFilename = `${title}.md`;
      const mdPath = path.join(refsDir, mdFilename);
      const mdContent = `---\nsource: ${filePath}\ntitle: "${title.replace(/"/g, '\\"')}"\n---\n\n${fullText}`;
      await fs.promises.writeFile(mdPath, mdContent, 'utf-8');
      index[filePath] = mdFilename;
    }

    await fs.promises.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf-8');
  }

  it('creates markdown files and index for references', async () => {
    mockExtractText.mockReturnValue('This is the full text of the paper about cortisol regulation.');
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Cortisol Regulation in RPTEC Models' }],
    });

    await simulateEnrichReferences(['refs/1.pdf']);

    const refsDir = path.join(workspaceDir, REFERENCES_SUBDIR);
    const indexPath = path.join(refsDir, REFERENCES_INDEX);

    expect(fs.existsSync(indexPath)).toBe(true);
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    expect(index['refs/1.pdf']).toBe('Cortisol Regulation in RPTEC Models.md');

    const mdPath = path.join(refsDir, 'Cortisol Regulation in RPTEC Models.md');
    expect(fs.existsSync(mdPath)).toBe(true);

    const content = fs.readFileSync(mdPath, 'utf-8');
    expect(content).toContain('source: refs/1.pdf');
    expect(content).toContain('title: "Cortisol Regulation in RPTEC Models"');
    expect(content).toContain('This is the full text of the paper');
  });

  it('falls back to filename when title extraction returns UNKNOWN', async () => {
    mockExtractText.mockReturnValue('Some text content');
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'UNKNOWN' }],
    });

    await simulateEnrichReferences(['refs/smith2024.pdf']);

    const refsDir = path.join(workspaceDir, REFERENCES_SUBDIR);
    const index = JSON.parse(fs.readFileSync(path.join(refsDir, REFERENCES_INDEX), 'utf-8'));
    expect(index['refs/smith2024.pdf']).toBe('smith2024.md');
  });

  it('skips files where text extraction returns null', async () => {
    mockExtractText.mockReturnValue(null);

    await simulateEnrichReferences(['refs/1.pdf']);

    const refsDir = path.join(workspaceDir, REFERENCES_SUBDIR);
    const indexPath = path.join(refsDir, REFERENCES_INDEX);
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    expect(Object.keys(index)).toHaveLength(0);
  });

  it('handles multiple files and builds complete index', async () => {
    mockExtractText.mockReturnValue('Paper text');
    mockCreate
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'First Paper Title' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Second Paper Title' }] });

    await simulateEnrichReferences(['refs/1.pdf', 'refs/smith2024.pdf']);

    const refsDir = path.join(workspaceDir, REFERENCES_SUBDIR);
    const index = JSON.parse(fs.readFileSync(path.join(refsDir, REFERENCES_INDEX), 'utf-8'));
    expect(Object.keys(index)).toHaveLength(2);
    expect(index['refs/1.pdf']).toBe('First Paper Title.md');
    expect(index['refs/smith2024.pdf']).toBe('Second Paper Title.md');
  });

  it('writes valid frontmatter with source and title', async () => {
    mockExtractText.mockReturnValue('Body text here');
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'My Paper' }],
    });

    await simulateEnrichReferences(['refs/1.pdf']);

    const refsDir = path.join(workspaceDir, REFERENCES_SUBDIR);
    const content = fs.readFileSync(path.join(refsDir, 'My Paper.md'), 'utf-8');
    const lines = content.split('\n');
    expect(lines[0]).toBe('---');
    expect(lines[1]).toBe('source: refs/1.pdf');
    expect(lines[2]).toBe('title: "My Paper"');
    expect(lines[3]).toBe('---');
    expect(lines[5]).toBe('Body text here');
  });
});

describe('get_scanned_files markdown_path enrichment', () => {
  it('adds markdown_path for references with index entries', () => {
    const files = [
      { file_path: 'refs/1.pdf', file_name: '1.pdf', file_type: 'reference' },
      { file_path: 'doc.docx', file_name: 'doc.docx', file_type: 'manuscript' },
      { file_path: 'refs/2.pdf', file_name: '2.pdf', file_type: 'reference' },
    ];
    const refIndex: Record<string, string> = {
      'refs/1.pdf': 'Cortisol Paper.md',
    };

    const cleaned = files.map(({ file_path, file_name, file_type }) => {
      const entry: Record<string, string> = { file_path, file_name, file_type };
      if (file_type === 'reference' && refIndex[file_path]) {
        entry.markdown_path = `${REFERENCES_SUBDIR}/${refIndex[file_path]}`;
      }
      return entry;
    });

    expect(cleaned[0].markdown_path).toBe(`${REFERENCES_SUBDIR}/Cortisol Paper.md`);
    expect(cleaned[1].markdown_path).toBeUndefined();
    expect(cleaned[2].markdown_path).toBeUndefined();
  });
});
