# Acabox

Acabox is a desktop research assistant: point it at local research folders and
use Claude to analyze your files and to build, host, and run small local apps
("mini-apps") that work with them. Mini-apps can publish MCP servers that the
agent and other mini-apps call.

It is a slimmed-down fork of `academia-edu/academia-electron` ("Academia
Coscientist") with the Podman/VM container removed — the agent server, Jupyter
kernel gateway, and mini-app tooling all run as host child processes instead.

## Prerequisites

- Node.js 18+ and npm
- Python 3.9+ on the system (used to bootstrap the per-app venv; a bundled
  Python is a future option)
- Rust (only to build the macOS file-monitor helper; `npm start` handles it)
- An Academia.edu account (used for sign-in and Claude credentials)

## Development

```bash
npm install
npm start
```

`npm start` builds the agent-server bundle and the Rust file monitor, then
launches the app via electron-forge with hot reloading.

To verify boot without the UI:

```bash
npm start -- -- --smoke-test
```

Type checking must stay clean before committing:

```bash
npx tsc --noEmit
```

Logs live at `~/Library/Application Support/acabox/development/cobuilding.log`
and in the in-app Debug tab.

## Packaging

```bash
npm run package        # unsigned production build (out/)
npm run make           # platform installers (zip/dmg, Squirrel, deb/rpm)
```

Signing/notarization uses `APPLE_IDENTITY` / `APPLE_ID` /
`APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` from `.env.local`
(see `scripts/build-signed.sh`).

## Repository notes

- Engineering context and current status live in [CLAUDE.md](CLAUDE.md).
- The workspace-agent instructions (read by the Claude that runs *inside* the
  app) are at `src/cobuilding/CLAUDE.md` — not the same document.
- Known-bug ledger: [BUGS.md](BUGS.md).

## License

UNLICENSED
