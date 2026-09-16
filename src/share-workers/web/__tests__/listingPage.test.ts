/** @jest-environment node */
import { renderListing } from '../src/listingPage';
import type { ShareIndex, ShareIndexEntry } from '../../../cobuilding/shared/share';

function entry(overrides: Partial<ShareIndexEntry> = {}): ShareIndexEntry {
  return {
    id: 'appid1234567890a',
    kind: 'app',
    title: 'DNA Toolkit',
    description: 'Reverse-complement a sequence',
    publishedAt: '2026-09-01T00:00:00.000Z',
    hash: 'a'.repeat(64),
    ...overrides,
  };
}

describe('renderListing', () => {
  it('titles the page "Shared from Acabox"', () => {
    const html = renderListing({ updatedAt: '2026-09-01T00:00:00.000Z', artifacts: [] });
    expect(html).toContain('<title>Shared from Acabox</title>');
    expect(html).toContain('Shared from Acabox');
  });

  it('shows the empty state when there are no artifacts', () => {
    const html = renderListing({ updatedAt: '2026-09-01T00:00:00.000Z', artifacts: [] });
    expect(html).toContain('Nothing published yet.');
  });

  it('renders an app row with a kind badge, title, description, date and a link to /a/<id>/', () => {
    const index: ShareIndex = {
      updatedAt: '2026-09-01T00:00:00.000Z',
      artifacts: [entry()],
    };
    const html = renderListing(index);
    expect(html).toContain('>App<');
    expect(html).toContain('DNA Toolkit');
    expect(html).toContain('Reverse-complement a sequence');
    expect(html).toContain('href="/a/appid1234567890a/"');
    expect(html).toContain('2026-09-01');
  });

  it('renders a file row with a File badge and a link to /f/<id>/', () => {
    const index: ShareIndex = {
      updatedAt: '2026-09-05T00:00:00.000Z',
      artifacts: [entry({ id: 'fileid1234567890', kind: 'file', title: 'results.csv', description: null })],
    };
    const html = renderListing(index);
    expect(html).toContain('>File<');
    expect(html).toContain('href="/f/fileid1234567890/"');
    expect(html).toContain('results.csv');
  });

  it('omits the description block when description is null', () => {
    const index: ShareIndex = {
      updatedAt: '2026-09-01T00:00:00.000Z',
      artifacts: [entry({ description: null })],
    };
    const html = renderListing(index);
    expect(html).not.toContain('class="description"');
  });

  it('sorts newest first', () => {
    const index: ShareIndex = {
      updatedAt: '2026-09-05T00:00:00.000Z',
      artifacts: [
        entry({ id: 'olderid1234567890', title: 'Older Tool', publishedAt: '2026-09-01T00:00:00.000Z' }),
        entry({ id: 'newerid1234567890', title: 'Newer Tool', publishedAt: '2026-09-05T00:00:00.000Z' }),
      ],
    };
    const html = renderListing(index);
    expect(html.indexOf('Newer Tool')).toBeLessThan(html.indexOf('Older Tool'));
  });

  it('escapes a <script> tag in a title rather than emitting it literally', () => {
    const index: ShareIndex = {
      updatedAt: '2026-09-01T00:00:00.000Z',
      artifacts: [entry({ title: '<script>alert(1)</script>' })],
    };
    const html = renderListing(index);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes HTML in the description too', () => {
    const index: ShareIndex = {
      updatedAt: '2026-09-01T00:00:00.000Z',
      artifacts: [entry({ description: '<img src=x onerror=alert(1)>' })],
    };
    const html = renderListing(index);
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('uses only DM Sans / IBM Plex Mono with system fallbacks and no external assets', () => {
    const html = renderListing({ updatedAt: '2026-09-01T00:00:00.000Z', artifacts: [] });
    expect(html).toContain('"DM Sans", system-ui, sans-serif');
    expect(html).toContain('"IBM Plex Mono", ui-monospace, monospace');
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/https?:\/\//);
  });
});
