# Acabox sharing — Cloudflare setup

This directory holds the two Cloudflare Workers that back Acabox's sharing
feature (Settings → Sharing): publishing a mini-app or a file from your
laptop to a login-gated link anyone with an `@academia.edu` Google account can
open. Nothing here is authored on the server — your laptop stays the source
of truth, and this is a one-time, ~1 hour setup per Cloudflare account.

This guide assumes you have never used Cloudflare Zero Trust (or Cloudflare
Access) before, and walks through every screen. If you get stuck, the design
doc at `docs/design/sharing.md` explains the *why* behind each piece.

> **Where things stand (2026-09-16):** the Workers are **finished** — every
> "W" and "V" ticket in `docs/design/sharing-tickets.md` has landed and the
> routes are implemented and unit-tested, not the `501` scaffold this note
> used to describe. What has **not** happened is the setup below: nothing has
> ever been deployed to Cloudflare, and no app or file has been published end
> to end (ticket X1). Following this guide is now the next step, and the app
> side shipped in v0.1.14 is waiting for it — Settings → Sharing stays inert
> until you paste in the two URLs and a publish token.
>
> **This guide now targets the custom domain `acabox.us`**, which is live in
> Cloudflare. Both `wrangler.toml` files already carry their hostname, so
> `wrangler deploy` creates the DNS record for you. If you are setting this up
> on a different account or domain, change the `pattern` in both files (or
> delete both `[[routes]]` blocks to fall back to `workers.dev`) — everything
> else below is the same.

## What gets deployed

Two Workers, one shared R2 bucket:

- **`acabox-share-api`** — the *publish* side. Acabox's main process talks to
  it directly over `PUT`/`DELETE` with a bearer token (`PUBLISH_TOKEN`). It is
  **not** behind Cloudflare Access — nothing about publishing goes through a
  browser login, and splitting the two Workers this way means there is no path
  on the protected site that has to be carved out as a login exception.
- **`acabox-share`** — the *public* side anyone with an allowed Google account
  opens in a browser. It reads the same R2 bucket, serves a listing page and
  the individual shared apps/files, and refuses every request with no valid
  Cloudflare Access login (fail closed: if Access is ever misconfigured or
  turned off, the site goes dark, not public).

The two run on **two different hostnames**, and that is forced rather than
cosmetic. A Cloudflare Access application covers a whole hostname, so the
publish Worker cannot share one with the gated viewer without being dragged
behind the login it must never be behind:

| Worker | Hostname | Gate |
| --- | --- | --- |
| `acabox-share` (viewer) | `share.acabox.us` | Cloudflare Access — Google, `@academia.edu` |
| `acabox-share-api` (publish) | `share-api.acabox.us` | Bearer `PUBLISH_TOKEN` only |

Share links look like `https://share.acabox.us/a/<id>/`.

> **Never create an Access application for `acabox.us` or `*.acabox.us`.**
> A wildcard is the obvious move once you own the whole zone, and it would
> also cover `share-api.acabox.us` — so every publish would be redirected to a
> Google sign-in page that Acabox's main process has no browser to complete.
> Publishing would fail with an HTML login page where a JSON response was
> expected. Scope the application to `share.acabox.us` exactly.

**Free at this scale.** Workers: 100k requests/day free. R2: 10 GB storage,
1M writes/month, 10M reads/month free. Zero Trust (the login gate): free for
the first 50 seats — see the callout in the Zero Trust section below, that is
the one limit worth knowing about up front.

## Prerequisites

- A Cloudflare account. The free tier is enough (create one at
  [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) if you
  don't have one).
- Node and npm — already required by the rest of this repo.
- From this directory, install the one dependency (`wrangler`, Cloudflare's
  CLI — pinned here, never at the repo root):

  ```sh
  cd src/share-workers
  npm install
  ```

- Log `wrangler` into your Cloudflare account (opens a browser once; the
  login is cached after this):

  ```sh
  npx wrangler login
  ```

Run every command below from `src/share-workers` unless noted otherwise.

## Create the bucket

Both Workers read and write one R2 bucket, named `acabox-share` in both
`wrangler.toml` files. Create it once:

```sh
npx wrangler r2 bucket create acabox-share
```

If you want a different bucket name, edit `bucket_name` in both
`api/wrangler.toml` and `web/wrangler.toml` to match before deploying.

## Deploy `acabox-share-api` and set `PUBLISH_TOKEN`

```sh
npx wrangler deploy --config api/wrangler.toml
```

`wrangler` creates the `share-api.acabox.us` DNS record on first deploy (a
proxied record on the `acabox.us` zone). That hostname is your **API URL**:
`https://share-api.acabox.us`.

Generate a random token and store it as a Worker secret (this prompts you to
paste the value; it is never written to a file in this repo):

```sh
openssl rand -hex 32          # copy this value
npx wrangler secret put PUBLISH_TOKEN --config api/wrangler.toml
```

Keep that same token — you'll paste it into Acabox's Settings in a later
step, and nowhere else. It is never logged and never sent to the workspace or
the agent.

## Deploy `acabox-share`

```sh
npx wrangler deploy --config web/wrangler.toml
```

This creates the `share.acabox.us` record the same way. That hostname is your
**site URL**: `https://share.acabox.us`.

**The site is dark at this point, not open** — an earlier version of this
guide said the opposite and it was wrong. The Worker verifies a Cloudflare
Access JWT on *every* route itself, static viewer assets included
(`run_worker_first = true`), and answers `401 Sign in required` when there is
none. Measured against the real Worker with no Access configured: `/`,
`/a/<id>/`, `/viewer.js` and an unknown path all returned 401. So deploying
before the next three sections exposes nothing; it just means nobody can get
in yet, including you.

## Zero Trust: add Google as an identity provider

Cloudflare Access — the login gate — lives under **Zero Trust** in the
Cloudflare dashboard, which is a separate area from the Workers/R2 pages you
just used.

1. In the Cloudflare dashboard, open **Zero Trust** from the left sidebar.
2. The first time you open it, Cloudflare asks you to pick a **team name**
   (e.g. `academia-sharing`). This becomes your team domain,
   `<team-name>.cloudflareaccess.com` — write it down, it's needed twice more
   below. (The free Zero Trust plan is enough for this.)
3. Go to **Settings → Authentication → Login methods → Add new**.
4. Choose **Google** as the provider type.
5. Cloudflare shows you a redirect URI to register with Google:
   `https://<team-name>.cloudflareaccess.com/cdn-cgi/access/callback`.
   Keep this tab open — you need it in the next step.
6. In a separate tab, go to the
   [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   (any Google Cloud project works; using Academia's own project is tidier
   but not required). Create **OAuth client ID → Application type: Web
   application**, and paste the redirect URI from step 5 into **Authorized
   redirect URIs**. Save, then copy the generated **Client ID** and **Client
   secret**.
7. Back in the Cloudflare tab, paste the Client ID and Client secret into the
   Google login method form and save.

## Create the Access application

Still in Zero Trust:

1. Go to **Access → Applications → Add an application → Self-hosted**.
2. Give it a name (e.g. "Acabox Share") and set the **Application domain** to
   exactly `share.acabox.us`, with no path and no wildcard. (See the warning
   in *What gets deployed* — a wildcard over the zone would break publishing.)
3. Under **Identity providers**, select **Google** (and turn off "Accept all
   available identity providers" if that's shown, so only Google applies).
4. Add one policy: **Action: Allow**, rule **Include → Emails ending in**,
   value `@academia.edu`. This is the entire access rule — everyone with an
   `@academia.edu` Google account gets in, no per-artifact lists.
5. Save.

> **Free tier limit: 50 seats.** Zero Trust is free for the first 50 distinct
> people who ever log in through it; the 51st distinct viewer is blocked, not
> billed automatically — Cloudflare prompts you to add paid seats
> ($7/user/month) once you're over 50. If everyone at Academia might
> eventually open a share link, decide up front whether that's within budget;
> `docs/design/sharing.md` → *Open decisions* #1 has the alternative (rolling
> your own Google OAuth check inside the Worker, no seat limit).

## Copy the AUD tag and team domain into `[vars]`, then redeploy

1. Open the Access application you just created and go to its **Overview**
   tab. Copy the **Application Audience (AUD) Tag** shown there.
2. Edit `web/wrangler.toml` in this directory:

   ```toml
   [vars]
   ACCESS_TEAM_DOMAIN = "<team-name>.cloudflareaccess.com"
   ACCESS_AUD = "<the AUD tag you just copied>"
   ```

3. Redeploy so the Worker picks up the new values:

   ```sh
   npx wrangler deploy --config web/wrangler.toml
   ```

From this point, opening the site URL in a browser should prompt a Google
sign-in, and only an `@academia.edu` account gets past it.

## Wire it into Acabox: Settings → Sharing → Test

In Acabox, open **Settings → Sharing** and fill in:

- **Site URL** — `https://share.acabox.us` (no trailing slash)
- **API URL** — `https://share-api.acabox.us` (no trailing slash)
- **Token** — the exact value you generated for `PUBLISH_TOKEN` above

> **Settle the hostname before you publish anything.** A share's URL is built
> at publish time by `artifactUrl()` and then stored, absolute, in the share
> registry. Changing the Site URL later does not rewrite records that already
> exist, so previously published links keep pointing at the old host. Nothing
> has been published yet, which is why now is the moment this is free.

Click **Test**. It calls the api Worker's health check with your token; a
green result means Acabox can publish. The token is encrypted at rest and
never leaves the main process — Settings only ever shows whether one is set,
never its value.

## Local development

Run the two Workers locally against `wrangler dev` in two terminals, both
from `src/share-workers`:

```sh
npx wrangler dev --config api/wrangler.toml
npx wrangler dev --config web/wrangler.toml
```

`wrangler dev` simulates R2 locally, so nothing you do here touches the real
`acabox-share` bucket. The `web` Worker's Access check has nothing to talk to
outside of a real deploy, so local requests would otherwise always be
refused. Skip the check in dev by creating a `web/.dev.vars` file (wrangler
loads this automatically; do not commit it — it's a local-only override) containing:

```
ACCESS_DISABLED=true
```

With that in place, `acabox-share`'s routes behave as if every request is
already authenticated — useful for testing the site itself, but never set
this in a deployed Worker's `[vars]`.
