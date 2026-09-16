/**
 * `main/share/rewriteLocalFileUrls.ts` — the publish-time rewrite that turns
 * the `local-file://` scheme mini-apps embed for asset URLs into a real,
 * browser-servable prefix. Pure string module, no filesystem/Electron.
 */
import { REWRITABLE_EXTENSIONS, rewriteLocalFileUrls, shouldRewrite } from '../rewriteLocalFileUrls';

describe('rewriteLocalFileUrls', () => {
  const base = '/a/abc123/v/deadbeefcafebabedeadbeefcafebabedeadbeefcafebabedeadbeefcafebabe/w';

  it('rewrites a template-literal form (the idiom SKILL.md documents)', () => {
    const source =
      'const src = `local-file://${workspacePath}/.applications/${dirName}/output/plot.png`;';
    const { output, count } = rewriteLocalFileUrls(source, base);
    expect(count).toBe(1);
    expect(output).toBe(
      `const src = \`${base}\${workspacePath}/.applications/\${dirName}/output/plot.png\`;`
    );
    expect(output).not.toContain('local-file://');
  });

  it('rewrites a string-concatenation form', () => {
    const source = 'var src = "local-file://" + workspacePath + "/.applications/x/output/a.png";';
    const { output, count } = rewriteLocalFileUrls(source, base);
    expect(count).toBe(1);
    expect(output).toBe(`var src = "${base}" + workspacePath + "/.applications/x/output/a.png";`);
  });

  it('rewrites three occurrences and reports the exact count', () => {
    const source = [
      'local-file://a',
      'const x = "local-file://b";',
      '`local-file://c`',
    ].join('\n');
    const { output, count } = rewriteLocalFileUrls(source, base);
    expect(count).toBe(3);
    expect(output).toBe([`${base}a`, `const x = "${base}b";`, `\`${base}c\``].join('\n'));
    expect(output).not.toContain('local-file://');
  });

  it('returns the source unchanged with count 0 when there is no occurrence', () => {
    const source = 'const src = `/.applications/x/output/plot.png`;';
    const result = rewriteLocalFileUrls(source, base);
    expect(result.count).toBe(0);
    expect(result.output).toBe(source);
  });

  it('returns an empty source unchanged with count 0', () => {
    const result = rewriteLocalFileUrls('', base);
    expect(result).toEqual({ output: '', count: 0 });
  });

  it('does not use regex semantics — a base containing regex metacharacters is inserted literally', () => {
    const weirdBase = '/a/$&(.*)/v/hash/w';
    const source = 'local-file://x';
    const { output, count } = rewriteLocalFileUrls(source, weirdBase);
    expect(count).toBe(1);
    expect(output).toBe(`${weirdBase}x`);
  });
});

describe('REWRITABLE_EXTENSIONS', () => {
  it('contains exactly js, mjs, html, css', () => {
    expect(new Set(REWRITABLE_EXTENSIONS)).toEqual(new Set(['js', 'mjs', 'html', 'css']));
  });
});

describe('shouldRewrite', () => {
  const dirName = 'myApp';

  it('is true for a built bundle under the app dist dir', () => {
    expect(shouldRewrite('w/.applications/myApp/dist/bundle.js', dirName)).toBe(true);
  });

  it('is true for the app entry html', () => {
    expect(shouldRewrite('w/.applications/myApp/src/index.html', dirName)).toBe(true);
  });

  it('is false for a json file in output/ (json is not rewritable)', () => {
    expect(shouldRewrite('w/.applications/myApp/output/data.json', dirName)).toBe(false);
  });

  it('is false for _vendor even with a rewritable extension', () => {
    expect(shouldRewrite('w/.applications/_vendor/tailwind.js', dirName)).toBe(false);
  });

  it('is false for another app dir, even with the same relative path', () => {
    expect(shouldRewrite('w/.applications/otherApp/dist/bundle.js', dirName)).toBe(false);
  });

  it('is false for a css file belonging to another app', () => {
    expect(shouldRewrite('w/.applications/otherApp/src/styles.css', dirName)).toBe(false);
  });

  it('is true for mjs and css within the right app dir', () => {
    expect(shouldRewrite('w/.applications/myApp/src/module.mjs', dirName)).toBe(true);
    expect(shouldRewrite('w/.applications/myApp/src/styles.css', dirName)).toBe(true);
  });

  it('is false for a file with no extension', () => {
    expect(shouldRewrite('w/.applications/myApp/README', dirName)).toBe(false);
  });

  it('is false for a dotfile directory segment with no real extension', () => {
    expect(shouldRewrite('w/.applications/myApp/.config/settings', dirName)).toBe(false);
  });

  it('is false for a path that is not under any .applications/<dirName>/ prefix', () => {
    expect(shouldRewrite('w/tool-data/myApp/output/plot.png', dirName)).toBe(false);
  });

  it('is false for the app dir path itself with no file (no trailing slash match)', () => {
    expect(shouldRewrite('w/.applications/myApp', dirName)).toBe(false);
  });

  it('is case-sensitive on extension only via lowercasing — uppercase extension still matches', () => {
    expect(shouldRewrite('w/.applications/myApp/src/index.HTML', dirName)).toBe(true);
  });
});
