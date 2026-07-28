import { isInternalUrl, isBrowserUrl } from '../urlTargets';

describe('isInternalUrl', () => {
  it('treats the app\'s own bundles as internal', () => {
    // Packaged renderer, and the webpack dev server in `npm start`.
    expect(isInternalUrl('file:///Applications/Acabox.app/Contents/Resources/app/index.html')).toBe(true);
    expect(isInternalUrl('http://localhost:3000/main_window')).toBe(true);
    expect(isInternalUrl('http://127.0.0.1:23200/health')).toBe(true);
    expect(isInternalUrl('http://[::1]:9000/')).toBe(true);
  });

  it('treats workspace and in-page schemes as internal', () => {
    expect(isInternalUrl('local-file:///Users/x/workspace/.applications/foo/index.html')).toBe(true);
    expect(isInternalUrl('about:blank')).toBe(true);
    expect(isInternalUrl('data:text/html,<p>hi</p>')).toBe(true);
    expect(isInternalUrl('blob:file:///abc-123')).toBe(true);
    expect(isInternalUrl('devtools://devtools/bundled/inspector.html')).toBe(true);
  });

  it('treats the open web as external', () => {
    expect(isInternalUrl('https://doi.org/10.1038/nature12373')).toBe(false);
    expect(isInternalUrl('http://arxiv.org/abs/1234.5678')).toBe(false);
    expect(isInternalUrl('https://localhost.evil.com/')).toBe(false);
  });

  it('is not fooled by a remote host that merely contains a loopback name', () => {
    // Substring matching here would hand the app's own guard to an attacker.
    expect(isInternalUrl('https://127.0.0.1.evil.com/')).toBe(false);
    expect(isInternalUrl('https://evil.com/?next=http://localhost')).toBe(false);
    expect(isInternalUrl('https://evil.com#localhost')).toBe(false);
  });

  it('falls back to internal for anything unparseable', () => {
    // Not something to hand to shell.openExternal.
    expect(isInternalUrl('')).toBe(true);
    expect(isInternalUrl('not a url')).toBe(true);
    expect(isInternalUrl('/relative/path')).toBe(true);
    expect(isInternalUrl(undefined as unknown as string)).toBe(true);
  });

  it('treats non-http schemes as neither internal nor browser-bound', () => {
    expect(isInternalUrl('mailto:someone@example.com')).toBe(false);
    expect(isInternalUrl('smb://fileserver/share')).toBe(false);
  });
});

describe('isBrowserUrl', () => {
  it('is true only for remote http(s)', () => {
    expect(isBrowserUrl('https://doi.org/10.1038/nature12373')).toBe(true);
    expect(isBrowserUrl('http://arxiv.org/abs/1234.5678')).toBe(true);
  });

  it('is false for everything Acabox renders itself', () => {
    expect(isBrowserUrl('local-file:///Users/x/workspace/out.csv')).toBe(false);
    expect(isBrowserUrl('http://localhost:3000/main_window')).toBe(false);
    expect(isBrowserUrl('file:///tmp/index.html')).toBe(false);
    expect(isBrowserUrl('about:blank')).toBe(false);
  });

  it('does not launch OS protocol handlers', () => {
    // Deep links stay reachable only through the explicit open-external-url IPC.
    expect(isBrowserUrl('mailto:someone@example.com')).toBe(false);
    expect(isBrowserUrl('zotero://select/items/0_ABC')).toBe(false);
    expect(isBrowserUrl('smb://fileserver/share')).toBe(false);
  });
});
