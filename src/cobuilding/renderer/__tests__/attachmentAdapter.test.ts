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
const convertImageToPng = jest.fn();
const getMaxAttachmentSizeMB = jest.fn().mockResolvedValue(30);

beforeAll(() => {
  (globalThis as any).window.filesAPI = { copyToWorkspace, getPathForFile, convertImageToPng };
  (globalThis as any).window.settingsAPI = { getMaxAttachmentSizeMB };
  // jsdom has no FileReader.readAsDataURL for real blobs backed by a stubbed
  // `size`, and the routing decision never inspects the bytes anyway.
  (globalThis as any).FileReader = class {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    readAsDataURL() {
      this.result = 'data:image/png;base64,QUJD';
      this.onload?.();
    }
  };
});

beforeEach(() => {
  copyToWorkspace.mockClear();
  getPathForFile.mockReset();
  convertImageToPng.mockReset();
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

/**
 * Images were the last hole of the same class the oversized-CSV fix closed:
 * the image adapter is FIRST in the composite and accepts `image/*`, so it saw
 * every image before the wildcard file-reference adapter — and it had no
 * ceiling at all, not even the user's max-attachment-size guard.
 */
describe('image attachments', () => {
  it('inlines a screenshot-sized PNG', async () => {
    const adapter = createAttachmentAdapter(WORKSPACE);
    const file = makeFile('screenshot.png', 'image/png', 2 * 1024 * 1024);

    const pending = (await adapter.add({ file })) as any;
    expect(pending.type).toBe('image');

    const complete = await adapter.send(pending as any);
    expect(complete.content).toEqual([
      { type: 'image', image: expect.stringContaining('data:image/png;base64,') },
    ]);
    expect(copyToWorkspace).not.toHaveBeenCalled();
  });

  it('routes an image past the API per-image limit to a workspace file reference', async () => {
    const adapter = createAttachmentAdapter(WORKSPACE);
    // 9 MB raw base64-encodes to 12 MB — over the API's 10 MB per-image cap,
    // so inlining this is a guaranteed rejection, not a degraded answer.
    const file = makeFile('microscopy.png', 'image/png', 9 * 1024 * 1024);
    getPathForFile.mockReturnValue('/Users/test/Pictures/microscopy.png');

    const pending = (await adapter.add({ file })) as any;
    expect(pending.type).toBe('file_reference');

    const complete = await adapter.send(pending as any);
    expect(copyToWorkspace).toHaveBeenCalledWith(
      ['/Users/test/Pictures/microscopy.png'],
      WORKSPACE,
    );
    expect(complete.content).toEqual([{ type: 'text', text: 'microscopy.png' }]);
  });

  /** The API reads only JPEG/PNG/GIF/WebP. Everything else was inlined with a
   *  media_type the API rejects — only TIFF was ever special-cased. */
  it.each([
    ['photo.heic', 'image/heic'],
    ['diagram.bmp', 'image/bmp'],
    ['shot.avif', 'image/avif'],
    ['scan.tif', 'image/tiff'],
  ])('converts %s before inlining it', async (name, type) => {
    const adapter = createAttachmentAdapter(WORKSPACE);
    convertImageToPng.mockResolvedValue('UE5H');

    const pending = (await adapter.add({ file: makeFile(name, type, 500 * 1024) })) as any;
    expect(convertImageToPng).toHaveBeenCalled();
    expect(pending.type).toBe('image');
    expect(pending.contentType).toBe('image/png');
    expect(pending.content[0].image).toBe('data:image/png;base64,UE5H');
  });

  it.each([
    ['photo.jpg', 'image/jpeg'],
    ['shot.png', 'image/png'],
    ['anim.gif', 'image/gif'],
    ['pic.webp', 'image/webp'],
  ])('does not re-encode %s, which the API reads natively', async (name, type) => {
    const adapter = createAttachmentAdapter(WORKSPACE);
    const pending = (await adapter.add({ file: makeFile(name, type, 500 * 1024) })) as any;
    expect(convertImageToPng).not.toHaveBeenCalled();
    expect(pending.type).toBe('image');
    expect(pending.contentType).toBe(type);
  });

  /** A pasted screenshot can arrive with no usable extension. Keying the
   *  decision on the extension as well as the MIME would send this through
   *  sips for nothing. */
  it('does not re-encode a correctly-typed PNG whose name has no extension', async () => {
    const adapter = createAttachmentAdapter(WORKSPACE);
    const pending = (await adapter.add({ file: makeFile('pasted-image', 'image/png', 8192) })) as any;
    expect(convertImageToPng).not.toHaveBeenCalled();
    expect(pending.type).toBe('image');
  });

  /** A file Chromium cannot type at all never reaches this adapter — `image/*`
   *  does not match an empty MIME — so it falls through to the wildcard and the
   *  agent gets a path. Recorded because it is load-bearing for the rule above:
   *  `needsConversion` can assume a non-empty image MIME. */
  it('lets an untyped file fall through to the wildcard adapter entirely', async () => {
    const adapter = createAttachmentAdapter(WORKSPACE);
    getPathForFile.mockReturnValue('/Users/test/Downloads/mystery');

    const pending = (await adapter.add({ file: makeFile('mystery', '', 8192) })) as any;
    expect(convertImageToPng).not.toHaveBeenCalled();
    expect(pending.type).toBe('file_reference');
  });

  /** sips cannot rasterize vector art, so the conversion throws. A workspace
   *  path beats an error here — an SVG is text the agent can just read. */
  it('routes an SVG to a workspace file reference when conversion fails', async () => {
    const adapter = createAttachmentAdapter(WORKSPACE);
    convertImageToPng.mockRejectedValue(new Error('sips: no image format found'));
    getPathForFile.mockReturnValue('/Users/test/Desktop/logo.svg');

    const pending = (await adapter.add({ file: makeFile('logo.svg', 'image/svg+xml', 4096) })) as any;
    expect(pending.type).toBe('file_reference');

    const complete = await adapter.send(pending as any);
    expect(complete.content).toEqual([{ type: 'text', text: 'logo.svg' }]);
  });

  it('measures the converted PNG for a TIFF, not the source file', async () => {
    const adapter = createAttachmentAdapter(WORKSPACE);
    // A 3 MB compressed TIFF is under the source ceiling, but expands past the
    // encoded ceiling once re-encoded as PNG. Judging it by source size alone
    // would inline 14 MB of base64 and get the request rejected.
    const file = makeFile('scan.tif', 'image/tiff', 3 * 1024 * 1024);
    convertImageToPng.mockResolvedValue('A'.repeat(14 * 1024 * 1024));
    getPathForFile.mockReturnValue('/Users/test/Pictures/scan.tif');

    const pending = (await adapter.add({ file })) as any;
    expect(convertImageToPng).toHaveBeenCalled();
    expect(pending.type).toBe('file_reference');

    // send() re-dispatches by file, so it lands back on the image adapter and
    // must honour the decision add() already made rather than re-deciding on
    // the (small) source size.
    const complete = await adapter.send(pending as any);
    expect(complete.content).toEqual([{ type: 'text', text: 'scan.tif' }]);
  });

  it('still inlines a TIFF whose converted PNG fits', async () => {
    const adapter = createAttachmentAdapter(WORKSPACE);
    const file = makeFile('small-scan.tif', 'image/tiff', 400 * 1024);
    convertImageToPng.mockResolvedValue('A'.repeat(600 * 1024));

    const pending = (await adapter.add({ file })) as any;
    expect(pending.type).toBe('image');
    expect(pending.contentType).toBe('image/png');

    const complete = await adapter.send(pending as any);
    expect(complete.content).toEqual([
      { type: 'image', image: expect.stringContaining('data:image/png;base64,AAA') },
    ]);
    expect(copyToWorkspace).not.toHaveBeenCalled();
  });

  it('applies the user max-size guard to oversized images', async () => {
    getMaxAttachmentSizeMB.mockResolvedValueOnce(30);
    const adapter = createAttachmentAdapter(WORKSPACE);
    const file = makeFile('enormous.png', 'image/png', 40 * 1024 * 1024);

    await expect(adapter.add({ file })).rejects.toThrow(/too large/i);
  });
});
