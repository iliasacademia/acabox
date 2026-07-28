/**
 * Which URLs Acabox renders itself, and which belong to the user's browser.
 *
 * Acabox is not a browser. The only things it ever loads in-process are its
 * own webpack bundles (`file:` when packaged, `http://localhost:<port>` under
 * the dev server), workspace content served over the `local-file:` protocol,
 * and mini-app servers on loopback. Everything else — a Markdown link in a
 * chat reply, a hyperlink in an .xlsx cell, an `<a>` inside a mini-app — is
 * handed to the OS.
 *
 * Kept dependency-free (no `electron` import) so both the main process and the
 * renderer share one definition of "internal"; a split definition here would
 * mean links behave differently depending on which layer caught the click.
 */

/**
 * Loopback hosts. `[::1]` is how the URL parser reports the IPv6 literal.
 *
 * Exported as an array because the mini-app link shim (main/miniAppLinkShim.ts)
 * interpolates it into a script string injected into another origin, and must
 * not drift from this list.
 */
export const LOCAL_HOSTNAMES_LIST = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'] as const;

const LOCAL_HOSTNAMES: Set<string> = new Set(LOCAL_HOSTNAMES_LIST);

/**
 * Schemes that only ever address content Acabox itself produced or is already
 * displaying. `devtools:`/`chrome-extension:` are here so opening DevTools
 * isn't mistaken for the user clicking a link.
 */
const INTERNAL_PROTOCOLS = new Set([
  'file:',
  'local-file:',
  'about:',
  'data:',
  'blob:',
  'devtools:',
  'chrome-devtools:',
  'chrome-extension:',
]);

/**
 * True when `rawUrl` is Acabox's own content and should load in-process.
 *
 * Anything unparseable is treated as internal: an unrecognised string is not
 * something we want to hand to `shell.openExternal`, and letting it through
 * unchanged preserves whatever behaviour it had before.
 */
export function isInternalUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== 'string' || rawUrl === '') return true;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return true;
  }

  if (INTERNAL_PROTOCOLS.has(url.protocol)) return true;
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return LOCAL_HOSTNAMES.has(url.hostname);
  }

  // Some other scheme entirely (mailto:, smb:, an OS handler). Not ours to
  // render, but also not something we route to the browser — the explicit
  // `open-external-url` IPC stays the only way to reach a protocol handler.
  return false;
}

/**
 * True when a URL should be opened in the user's default browser: remote
 * http(s) only. Non-http schemes are neither rendered nor launched.
 */
export function isBrowserUrl(rawUrl: string): boolean {
  if (isInternalUrl(rawUrl)) return false;
  try {
    const { protocol } = new URL(rawUrl);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
