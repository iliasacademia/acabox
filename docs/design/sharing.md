# Sharing: publish a mini-app or a file as a login-gated link

> **Status: proposal, nothing built.** Written 2026-09-10 from a clarifying
> round with the user. Every row in "Decisions from the user" is theirs, not
> inferred. Every Cloudflare limit quoted here was looked up on 2026-09-10, not
> recalled, and should be re-checked at build time.
>
> | Increment | State |
> |---|---|
> | 0 Cloudflare setup (manual, documented) | Not started |
> | 1 Two Workers + R2 (`cloudflare/share/`) | Not started |
> | 2 Snapshot + publisher in main (`main/share/`) | Not started |
> | 3 Viewer shim (read-only stand-in for the host) | Not started |
> | 4 UI: Publish / Refresh / Unpublish, Settings → Sharing, Files → Share | Not started |
> | 5 End-to-end verification in a real browser | Not started |
>
> Rough size: about five developer-days in total. No Mac mini, no domain,
> no server code beyond two small Workers, and $0/month at this scale.
>
> **Tickets:** `docs/design/sharing-tickets.md` — 25 Sonnet-sized tickets with
> shared contracts (types, R2 layout, HTTP API, bridge protocol). Fable
> orchestrates and reviews; Sonnet 5 implements one ticket at a time.

## What this is

The claude.ai artifact model applied to Acabox: a mini-app the user has built
gets a URL. Anyone with an `@academia.edu` Google account can open it, sees the
latest published version on refresh, and cannot run anything. The user's laptop
stays the source of truth; publishing pushes a read-only **snapshot** of the
built app and its output data to Cloudflare.

A mini-app is two separable things, and the plan follows the seam:

- **The bundle.** `.applications/<dir>/src/index.html` loading
  `../dist/bundle.js` and `../../_vendor/{acabox.css,tailwind.js}`. Static.
- **The host bridge.** Twenty-odd postMessage calls answered by
  `MiniAppViewer.tsx`: file I/O, shell, kernel, Claude, registered APIs,
  pickers, MCP. Every one needs a running Acabox main process.

A shared page hosts the bundle unchanged and replaces the bridge's host with a
shim that answers the read-only calls from the snapshot and refuses the rest.

## Decisions from the user (2026-09-10)

| Question | Answer |
|---|---|
| What a viewer gets | Read-only snapshot: bundle + output data at publish time. No Run, no Claude. |
| Source of truth | The user's laptop. Nothing is authored on the server. |
| "Live" | Latest version on page refresh. Explicit **Publish** / **Unpublish**, plus **Refresh** when the shared version is behind the local one, with the app telling the user so. |
| Hosting | Easiest, ideally free. The Mac mini was a suggestion, not a requirement. |
| Login | Google SSO, Academia's. |
| Audience | Every `@academia.edu` account sees everything published. No per-artifact lists. |
| Scope | Mini-apps first; plain files too if it is nearly free (it is, for raw files — see below). |

## Architecture

```
laptop (Acabox main)                    Cloudflare (free tier)
────────────────────                    ──────────────────────────────────────
main/share/publisher.ts  ── PUT/DELETE ──▶  acabox-share-api  (Worker, bearer token)
  snapshot → hash → upload                     │ writes
                                               ▼
                                            R2 bucket  acabox-share
                                               ▲ reads
                                               │
viewer's browser  ── GET ──▶ Cloudflare Access (Google IdP, @academia.edu) ──▶  acabox-share  (Worker)
                                                                                 serves viewer shim + snapshot files
```

- **Two Workers, one bucket.** `acabox-share` is behind Access and only ever
  GETs. `acabox-share-api` is *not* behind Access and authenticates with a
  bearer secret. Splitting them sidesteps path-scoped Access exceptions
  entirely: there is no path on the protected host that must bypass login.
- **No custom domain needed.** Access can protect a Worker's `workers.dev`
  hostname directly. URLs look like
  `https://acabox-share.<account>.workers.dev/a/<id>/`. A custom domain later is
  configuration, not code.
- **Free at this scale.** Workers free: 100k requests/day. R2 free: 10 GB,
  1M writes/month, 10M reads/month. Zero Trust free: **50 users** — see Open
  decisions, this is the one limit that can bite.
- **Why not Pages.** Pages direct-upload deploys the whole site per publish and
  the API is only really usable through `wrangler`, which would become a runtime
  dependency of the Electron app. Per-object R2 writes over plain `fetch` are
  smaller and need nothing installed.
- **Why not the Mac mini.** It only earns its place for live execution, which
  was declined. It would add uptime, a tunnel, and a machine to keep awake, for
  nothing the snapshot model uses.

## The snapshot

Built in main by `main/share/snapshot.ts`, into a temp dir, mirroring the
workspace layout under one prefix so every path the app already uses maps 1:1:

```
w/.applications/<dir>/src/index.html       (unchanged)
w/.applications/<dir>/dist/bundle.js       (one rewrite, below)
w/.applications/<dir>/output/**            (dereferenced — same cp as miniApps:export)
w/.applications/<dir>/input/**             (dereferenced; user can untick at publish)
w/.applications/<dir>/manifest.json
w/.applications/_vendor/**                 (css, tailwind, fonts — index.html links ../../_vendor)
files.json                                 (path → size, sha256; feeds readDirectory)
```

Reuses the `cp(..., {dereference: true})` that `miniApps:export` already does
(`fileHandlers.ts:630`), minus the dialog and the zip.

**The one rewrite, and why it is unavoidable.** `SKILL.md:672-693` instructs
apps to build image URLs as `` `local-file://${workspacePath}/.applications/…` ``
and both shipped templates do exactly that. A browser has no `local-file:`
scheme and a service worker cannot intercept an unknown scheme. So at publish
time `bundle.js` gets the literal `local-file://` replaced with the versioned
base `/a/<id>/v/<hash>/w`, and the shim's `init` sends `workspacePath: ''`.
The template literal then resolves to `/a/<id>/v/<hash>/w/.applications/…`, a
root-relative URL the Worker serves. Old apps need no rebuild. Going forward,
the bridge should also grow `hostAPI.fileUrl(relPath)` and `SKILL.md` should
point at it, so new apps stop hardcoding the scheme; the rewrite stays for the
existing ones.

**Versioned, so a publish is atomic.** Objects live under
`a/<id>/v/<hash>/…`; `a/<id>/meta.json` names the current hash and is written
last. A viewer mid-load never mixes two versions. Versioned paths are served
`immutable`; `meta.json` and the shim are `no-store` (the local-file handler in
`main/index.ts` learned the same lesson about stale bundles). The previous
version's prefix is deleted after the new `meta.json` lands. A refresh
re-uploads the whole set rather than diffing — typical sets are 1–20 MB and
the simplicity is worth more than the bandwidth.

**`hash`** is sha256 over the sorted `(relPath, sha256(content))` list of the
snapshot. It is both the version id and the "is the shared copy behind"
signal. `id` is a random slug minted at first publish and stored in the
manifest, so the URL survives refreshes and does not leak directory names.

## The viewer shim

Ships **with the `acabox-share` Worker** as a static asset (`viewer.html`,
`viewer.js`), not inside each snapshot, so a shim fix never requires
republishing every app. Source lives in this repo and is tested in Jest against
the **real** `_bridge/bridge.ts` bundle in JSDOM, the pattern the bridge tests
already use.

It frames `/a/<id>/v/<hash>/w/.applications/<dir>/src/index.html` and answers
the same postMessage protocol `MiniAppViewer.tsx` does, with the `preBuilt`
read-only precedent taken to its conclusion:

| Bridge call | Shim behaviour |
|---|---|
| `init` | sent on iframe load with `workspacePath: ''` |
| `readFile`, `readDirectory` | served from the snapshot; `readDirectory` from `files.json`, same shapes as `files:readFile` / `files:readDirectory` |
| `downloadFile` | blob download in the browser |
| `openExternal` | `window.open` |
| `jobs:listForApp`, `mcp:listServers` | empty list |
| everything else (`executeCommand`, `executeCode`, `connectKernel`, `anthropic:*`, `api:request`, `writeFile`, `deleteFile`, `copyFile`, `requestFix`, `selectFile`, `selectDirectory`, `showInFinder`, `academia:fetch`, `mcp:callTool`, `setComposerText`, `quoteSelection`) | rejected with one message: *"This is a shared, read-only snapshot. Open the tool in Acabox to run it."* |

A slim banner above the frame: tool name · *Shared from Acabox · read-only
snapshot · published <date>*. The `/` route lists everything published
(title, description, date) from an `index.json` the api Worker maintains.

## Behind detection and Refresh

The laptop is the source of truth, so "behind" is a local comparison, no
server call: `snapshotHash(now) !== manifest.published.hash`. `share:status`
computes it on demand when the Tools page is visible; main also recomputes
after a successful `buildMiniApp` and when a job for the app ends (the two
moments the snapshot can change) and broadcasts `share:changed` — announce at
the write, the scheduler lesson. The UI shows `SHARED · BEHIND` and enables
**Refresh**, which is a publish under the existing id.

## Auth

- **Cloudflare Access on the `acabox-share` hostname**, IdP Google, one policy:
  Allow · *Emails ending in* `@academia.edu`. Needs a Google OAuth client
  (any Google Cloud project; Academia's is tidier) with the Access callback
  URL. Zero auth code for the login itself.
- **Fail closed.** `acabox-share` verifies the `Cf-Access-Jwt-Assertion` header
  against the team's certs endpoint and refuses without it. If someone flips
  the Access toggle off by mistake, the site goes dark rather than public.
  About 40 lines on Workers' WebCrypto.
- **Publish token.** One `SHARE_PUBLISH_TOKEN` Worker secret, held in Acabox via
  `secretStore` (`enc:v1:` in `cobuilding-settings.json`), blank-on-IPC like
  connector headers, never handed to the agent (the `agent.json` /
  `block-secret-reads` rules already cover this class).

## Files (the "share anything" half)

Raw files are the same pipeline with one object and no shim, roughly a tenth
more work: Files tab → context menu → **Share…** uploads
`f/<id>/v/<hash>/<name>` and the Worker serves it inline with the right
content-type. Browsers render PDF, PNG, JPG, SVG, HTML and text natively.
**Rendered viewers for CSV/XLSX are not in v1** — that is real UI work with no
shared code in the browser. Chats are not in v1.

## Hazards, stated up front

- **Data leaves the laptop.** `output/` and `input/` are uploaded. The publish
  dialog lists file counts and total size per folder and lets the user untick
  `input/`. Nothing is uploaded silently.
- **One origin for every artifact.** All published apps and files share the
  `workers.dev` origin, so one app's script could read another's snapshot. For
  a single publisher and a domain-wide audience this is accepted; per-artifact
  isolation would need a subdomain per artifact, which needs a custom domain.
- **The publish token writes everything.** Anyone holding it can replace or
  delete any artifact. It lives only in Acabox's encrypted settings.
- **50 Zero Trust seats free.** The 51st distinct viewer is blocked, not
  charged. See Open decisions.
- **Refresh is a full re-upload.** Fine at 20 MB; a tool holding hundreds of MB
  of output should be warned, not refused. Ceiling to decide at build time.

## Increments

0. **Cloudflare setup** (manual, ~1 hour, written up in
   `cloudflare/share/README.md`): account, R2 bucket, deploy both Workers, Zero
   Trust team, Google IdP, Access app on the web hostname, one email-domain
   policy, `wrangler secret put SHARE_PUBLISH_TOKEN`.
1. **Workers** (~1 day). `cloudflare/share/api`: `PUT /v1/artifacts/:id/v/:hash/*`,
   `PUT /v1/artifacts/:id` (commit), `DELETE /v1/artifacts/:id`,
   `GET /v1/artifacts` and `/v1/health`, bearer-checked, maintains `index.json`.
   `cloudflare/share/web`: `/`, `/a/:id/`, `/a/:id/v/:hash/w/*`, `/f/:id/`,
   JWT check, content-type map, cache headers, static viewer assets. Pure
   routing and JWT functions unit-tested under the existing Jest setup.
2. **Snapshot + publisher in main** (~1.5 days). `main/share/{snapshot,
   publisher,shareStore,shareHandlers}.ts`, `shared/share.ts`. Manifest gains
   `published: {id, url, hash, publishedAt}`. IPCs `share:publish`,
   `share:refresh`, `share:unpublish`, `share:status`, `share:settings`.
   Upload with bounded concurrency and retries; commit last. Tested against a
   real scaffolded app, including the `local-file://` rewrite and hash stability.
3. **Viewer shim** (~1 day). Executed in JSDOM against the real bridge: every
   call in the table above, both directions.
4. **UI** (~1 day). Tools page row Settings panel: Publish… / Copy link / Open /
   Refresh / Unpublish + `SHARED` / `SHARED · BEHIND` chip, also in the
   ToolWorkspace header. Settings → Sharing beside APIs and Connectors: site
   URL, API URL, token, **Test**. Files tab context menu: Share… / Copy link /
   Unpublish. Screenshot every new layout — shared input classes tie on
   specificity and lose by import order (the scheduler lesson).
5. **Verification** (~0.5 day). Real publish of a real tool → incognito browser
   → Google login as an `@academia.edu` account → app renders with images →
   rebuild locally → `BEHIND` chip → Refresh → browser refresh shows the change
   → Unpublish → 404 → a non-academia Google account is refused → the api
   Worker refuses a request without the token → viewer shim's refusals read
   correctly inside a real app.

## Open decisions (answer before Increment 0)

1. **How many distinct viewers?** Access is free to 50 seats, then $7/user/month.
   If the whole company may open links, the alternative is Google OAuth inside
   the web Worker itself (no seat limit, ~150 lines, same Google client, same
   `@academia.edu` check).
2. **Whose Cloudflare account and whose Google Cloud project?** A personal free
   Cloudflare account is sufficient. Academia's needs an admin for Zero Trust.
3. **`input/` included by default?** Proposed: shown and ticked, untickable.
4. **Is a `workers.dev` URL acceptable for v1?** Custom domain later is config.
5. **Files: raw-only in v1**, rendered CSV/XLSX viewers later. Confirm.
6. **Unpublish deletes immediately**, no trash. Confirm.
