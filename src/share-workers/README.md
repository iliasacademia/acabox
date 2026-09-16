# Acabox sharing — Cloudflare setup

This directory holds the two Cloudflare Workers that back Acabox's sharing
feature (Settings → Sharing): publishing a mini-app or a file from your
laptop to a login-gated link anyone with an `@academia.edu` Google account can
open. Nothing here is authored on the server — your laptop stays the source
of truth, and this is a one-time, ~1 hour setup per Cloudflare account.

This guide assumes you have never used Cloudflare Zero Trust (or Cloudflare
Access) before, and walks through every screen. If you get stuck, the design
doc at `docs/design/sharing.md` explains the *why* behind each piece.

> **Where things stand:** this README describes the finished setup, once all
> of the `docs/design/sharing-tickets.md` "W" tickets have landed. Today the
> two Workers are a scaffold — routes return `501` — so the deploy and Zero
> Trust steps below are safe to do at any time (nothing breaks), but the app
> itself won't do anything useful until the routes ship.

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

Both live behind their Worker's own `workers.dev` subdomain — no custom
domain is required. URLs look like
`https://acabox-share.<your-account>.workers.dev/a/<id>/`.

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

This prints the Worker's URL — that's your **API URL**,
`https://acabox-share-api.<your-account>.workers.dev`.

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

This prints the Worker's URL — that's your **site URL**,
`https://acabox-share.<your-account>.workers.dev`. At this point the site is
live but wide open (Access isn't configured yet) — the next three sections
close that gap before anyone should be told the link exists.

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
   your `acabox-share` Worker's hostname from the deploy step above —
   `acabox-share.<your-account>.workers.dev` — with no path.
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

- **Site URL** — `https://acabox-share.<your-account>.workers.dev` (no
  trailing slash)
- **API URL** — `https://acabox-share-api.<your-account>.workers.dev` (no
  trailing slash)
- **Token** — the exact value you generated for `PUBLISH_TOKEN` above

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
