/**
 * Rewrites the `local-file://` scheme mini-apps embed for `<img>` (and other
 * asset) URLs into a browser-servable prefix, at publish time.
 *
 * A mini-app running inside Acabox builds asset URLs like
 * (`skills/manage-mini-application/SKILL.md` ~line 672-693):
 *
 *   const workspacePath = window.getWorkspacePath();
 *   const src = `local-file://${workspacePath}/.applications/${dirName}/output/plot.png`;
 *
 * `local-file://` is an Electron custom scheme (see `main/protocol.ts`); no
 * browser can serve it. Once esbuild bundles that template literal, the
 * literal substring `local-file://` sits in the built JS/HTML/CSS source
 * exactly as written, immediately before the `${workspacePath}` interpolation
 * — so a plain literal-string replace of `local-file://` with the artifact's
 * versioned base (e.g. `/a/abc/v/<hash>/w`, see `versionedBase` in
 * `shared/share.ts`) is enough; nothing needs to parse the URL.
 *
 * That leaves `${workspacePath}` itself. In the real app it is filled by the
 * host with the absolute filesystem workspace path. The published viewer has
 * no such path — everything a snapshot needs already lives under the base
 * prefix — so the viewer shim's `init` message (C6) always sends
 * `workspacePath: ''`. With the scheme rewritten and workspacePath empty, the
 * app's own concatenation collapses to exactly what R2 holds:
 *
 *   `${base}` + `` + `/.applications/${dirName}/output/plot.png`
 *   = `/a/abc/v/<hash>/w/.applications/<dirName>/output/plot.png`
 *
 * — no second source of truth for the workspace path is ever introduced.
 *
 * PURE MODULE — electron-free. No imports; string operations only.
 */

/** Extensions that can plausibly contain a `local-file://` literal. */
export const REWRITABLE_EXTENSIONS: ReadonlySet<string> = new Set(['js', 'mjs', 'html', 'css']);

const LOCAL_FILE_SCHEME = 'local-file://';

/**
 * Replaces every occurrence of the exact literal `local-file://` in `source`
 * with `base`. A global literal replace via split/join — no regex, so `base`
 * can contain characters that would otherwise need escaping and the scheme
 * itself needs none.
 */
export function rewriteLocalFileUrls(source: string, base: string): { output: string; count: number } {
  if (source.length === 0 || !source.includes(LOCAL_FILE_SCHEME)) {
    return { output: source, count: 0 };
  }
  const parts = source.split(LOCAL_FILE_SCHEME);
  const count = parts.length - 1;
  return { output: parts.join(base), count };
}

/**
 * True only for a file that (a) belongs to the app currently being published
 * — under `w/.applications/<dirName>/`, never `_vendor` and never another
 * app's directory — and (b) has a rewritable extension. `output/**` files are
 * data, not code, and are deliberately excluded even inside the right app dir
 * (e.g. `output/data.json` is not rewritten).
 */
export function shouldRewrite(snapshotPath: string, dirName: string): boolean {
  const prefix = `w/.applications/${dirName}/`;
  if (!snapshotPath.startsWith(prefix)) {
    return false;
  }
  const lastSlash = snapshotPath.lastIndexOf('/');
  const lastDot = snapshotPath.lastIndexOf('.');
  if (lastDot <= lastSlash) {
    // No extension, or the last '.' belongs to a directory segment.
    return false;
  }
  const ext = snapshotPath.slice(lastDot + 1).toLowerCase();
  return REWRITABLE_EXTENSIONS.has(ext);
}
