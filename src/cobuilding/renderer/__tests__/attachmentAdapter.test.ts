/**
 * Regression cover for "Prompt is too long": a multi-MB CSV dropped into the
 * composer used to be base64'd and inlined verbatim into the prompt, because
 * CompositeAttachmentAdapter dispatches to the FIRST adapter whose `accept`
 * matches and `text/csv` hits the document adapter before the wildcard
 * file-reference one.
 *
 * The composite dispatch is the thing under test, so it is NOT stubbed — the
 * mock below re-exports the real class straight from @assistant-ui/core's
 * standalone attachment module. Only the rest of the (ESM, React-heavy)
 * @assistant-ui/react barrel is mocked away so the import resolves in jsdom.
 */
jest.mock('@assistant-ui/react', () => ({
  __esModule: true,
  CompositeAttachmentAdapter:
    // Deep path, not the package name: @assistant-ui/core's exports map hides
    // dist/, and the package root barrel drags in the whole ESM tree.
    require('../../../../node_modules/@assistant-ui/core/dist/adapters/attachment.js')
      .CompositeAttachmentAdapter,
}));

import { createAttachmentAdapter } from '../attachmentAdapter';

const WORKSPACE = '/Users/test/Library/Application Support/acabox/development/cobuilding-workspace';

const copyToWorkspace = jest.fn().mockResolvedValue({ copied: 1 });
const getPathForFile = jest.fn();
const getMaxAttachmentSizeMB = jest.fn().mockResolvedValue(30);

beforeAll(() => {
  (globalThis as any).window.filesAPI = { copyToWorkspace, getPathForFile };
  (globalThis as any).window.settingsAPI = { getMaxAttachmentSizeMB };
});

beforeEach(() => {
  copyToWorkspace.mockClear();
  getPathForFile.mockReset();
});

/** jsdom's File reads its own size from the blob parts, so a multi-MB fixture
 *  would mean actually allocating multi-MB of string. Stub `size` instead —
 *  it's the only property the routing decision looks at. */
function makeFile(name: string, type: string, size: number, body = 'a,b,c\n1,2,3\n'): File {
  const file = new File([body], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('document attachments', () => {
  it('inlines a small CSV as base64 document content', async () => {
    const adapter = createAttachmentAdapter(WORKSPACE);
    const file = makeFile('small.csv', 'text/csv', 12);

    const pending = (await adapter.add({ file })) as any;
    expect(pending.type).toBe('document');

    const complete = await adapter.send(pending as any);
    expect(complete.content).toEqual([
      expect.objectContaining({ type: 'file', mimeType: 'text/csv', filename: 'small.csv' }),
    ]);
    expect(copyToWorkspace).not.toHaveBeenCalled();
  });

  it('routes an oversized CSV to a workspace file reference instead of the prompt', async () => {
    const adapter = createAttachmentAdapter(WORKSPACE);
    // The real report: a 5.2 MB export, inlined verbatim, blew the context window.
    const file = makeFile('co_scientist_sent_email_export2.csv', 'text/csv', 5_453_743);
    getPathForFile.mockReturnValue('/Users/test/Downloads/co_scientist_sent_email_export2.csv');

    const pending = (await adapter.add({ file })) as any;
    expect(pending.type).toBe('file_reference');

    const complete = await adapter.send(pending as any);
    expect(copyToWorkspace).toHaveBeenCalledWith(
      ['/Users/test/Downloads/co_scientist_sent_email_export2.csv'],
      WORKSPACE,
    );
    // A path, not 5.2 MB of CSV.
    expect(complete.content).toEqual([
      { type: 'text', text: 'co_scientist_sent_email_export2.csv' },
    ]);
  });

  it('does not re-copy an oversized file that already lives in the workspace', async () => {
    const adapter = createAttachmentAdapter(WORKSPACE);
    const file = makeFile('big.csv', 'text/csv', 5_000_000);
    getPathForFile.mockReturnValue(`${WORKSPACE}/MyResearch/big.csv`);

    const complete = await adapter.send((await adapter.add({ file })) as any);
    expect(copyToWorkspace).not.toHaveBeenCalled();
    expect(complete.content).toEqual([{ type: 'text', text: 'MyResearch/big.csv' }]);
  });

  it('still inlines a PDF under the looser PDF ceiling', async () => {
    const adapter = createAttachmentAdapter(WORKSPACE);
    const file = makeFile('paper.pdf', 'application/pdf', 1_500_000, '%PDF-1.4');

    const pending = (await adapter.add({ file })) as any;
    expect(pending.type).toBe('document');
  });

  it('routes a PDF past the PDF ceiling to a file reference', async () => {
    const adapter = createAttachmentAdapter(WORKSPACE);
    const file = makeFile('scans.pdf', 'application/pdf', 9_000_000, '%PDF-1.4');

    const pending = (await adapter.add({ file })) as any;
    expect(pending.type).toBe('file_reference');
  });

  it('applies the user max-size guard to oversized documents', async () => {
    getMaxAttachmentSizeMB.mockResolvedValueOnce(30);
    const adapter = createAttachmentAdapter(WORKSPACE);
    const file = makeFile('huge.csv', 'text/csv', 40 * 1024 * 1024);

    await expect(adapter.add({ file })).rejects.toThrow(/too large/i);
  });
});
