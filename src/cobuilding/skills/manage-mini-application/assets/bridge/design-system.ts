/**
 * Guarantees the Acabox design system is loaded, for every mini-app.
 *
 * Apps scaffolded from the current template already `<link>` `_vendor/acabox.css`
 * from their `index.html`, and for them this module does nothing. It exists for
 * the apps that do not: an `index.html` is written once at scaffold time and is
 * then the app's own file, which the host must never rewrite. Without this,
 * every app built before the design system landed would keep rendering in
 * system-ui with undefined `--cd-*` variables — and the shared `@reusable`
 * components, which resolve their colours from those variables, would come out
 * with no colour at all.
 *
 * The bridge is the one piece of code every app imports (`index.tsx` line 1)
 * *and* the one piece the host force-refreshes on every boot
 * (`syncMiniAppAssets()` → `.applications/_bridge`), so it is the only place an
 * app-wide fix can be applied retroactively. An app picks this up on its next
 * rebuild.
 *
 * ORDERING. The sheet is appended to the END of `<head>`, not the start. Legacy
 * scaffolds carry an inline `body { font-family: system-ui }`, and an element
 * selector beats nothing — only document order separates them, so a sheet
 * inserted before it would lose. Appending is safe for Tailwind: a utility is a
 * class (0,1,0) and the base rules here are element selectors (0,0,1), so
 * utilities still win regardless of order.
 */

const HREF = '../../_vendor/acabox.css';
const MARKER = 'data-acabox-design-system';

function alreadyLoaded(): boolean {
  // Our own marker, or a `<link>` the app's index.html declared itself. Match
  // on the tail of the href so a differently-written relative path still counts.
  if (document.querySelector(`[${MARKER}]`)) return true;
  const links = document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]');
  for (const link of Array.from(links)) {
    if (link.getAttribute('href')?.replace(/[?#].*$/, '').endsWith('_vendor/acabox.css')) {
      return true;
    }
  }
  return false;
}

function install(): void {
  if (alreadyLoaded()) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = HREF;
  link.setAttribute(MARKER, '');
  document.head.appendChild(link);
}

// `<head>` exists by the time any script in it runs, but the bundle is loaded
// from `<body>` and a defensive check costs nothing if that ever changes.
if (document.head) {
  install();
} else {
  document.addEventListener('DOMContentLoaded', install, { once: true });
}

export {};
