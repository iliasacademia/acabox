import React, { useCallback, useEffect, useRef, useState } from 'react';
import { validateHostedServer } from '../../../shared/hostedMcp';

/**
 * Increment 6 (`docs/design/mcp-hosting.md`) — install a server from npm or
 * a GitHub repo.
 *
 * WHY A LOG AND NOT A PROGRESS BAR
 * --------------------------------
 * codeload sends no `content-length`, so a percentage would be invented —
 * the same rule `ImportSkillPanel` already follows. What the pane shows is
 * npm's and GitHub's own output, which is also what makes the failure case
 * useful: on failure it STAYS, with `Copy log` and `Ask Claude to fix this`,
 * and that button composes a real chat turn carrying the tail. The agent has
 * Bash in the workspace, so it can actually go and look.
 *
 * WHAT THE DISCLOSURE HAS TO SAY THAT THE AUTHORED PATH DOES NOT
 * -------------------------------------------------------------
 * An agent-authored server is code the user watched Claude write. This is a
 * stranger's. The copy therefore leads with whose code it is and that its
 * tools are auto-approved once enabled — and it says the install is PINNED
 * (exact version / 40-char commit), because "pinned" is the only honest
 * reassurance available here: it makes the thing reproducible and auditable,
 * which is not the same as safe.
 */

type SourceKind = 'npm' | 'github';

export function InstallServerPanel({
  existingIds,
  onInstalled,
  onCancel,
  onAskClaude,
}: {
  existingIds: string[];
  onInstalled: (id: string, toolCount: number) => void;
  onCancel: () => void;
  /** Compose a chat turn carrying the log tail. */
  onAskClaude: (prompt: string) => void;
}) {
  const [kind, setKind] = useState<SourceKind>('npm');
  const [pkg, setPkg] = useState('');
  const [version, setVersion] = useState('');
  const [url, setUrl] = useState('');
  const [subpath, setSubpath] = useState('');
  const [id, setId] = useState('');
  const [idTouched, setIdTouched] = useState(false);

  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ toolCount: number } | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

  // Subscribe for the whole life of the panel, not just while busy: the
  // first lines arrive before `install()` has even resolved its first await,
  // and a subscription opened alongside the call can miss them.
  useEffect(() => window.mcpServersAPI.onInstallLog((evt) => {
    setLines((prev) => [...prev, evt.line]);
  }), []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  /**
   * Suggest an id from what the user typed, until they edit it themselves.
   * The id is what the model types (`mcp__<id>__<tool>`) and what collides
   * with connectors, so it is a real field — but making someone invent one
   * before they have installed anything is friction for nothing.
   */
  const suggestedId = deriveId(kind === 'npm' ? pkg : (subpath || url));
  const effectiveId = idTouched ? id : suggestedId;

  const idProblem = effectiveId
    ? validateHostedServer({ id: effectiveId, entry: { command: 'x', args: [] } }, existingIds).error
    : undefined;

  const sourceReady = kind === 'npm' ? pkg.trim().length > 0 : url.trim().length > 0;
  const canInstall = sourceReady && !!effectiveId && !idProblem && !busy;

  const install = useCallback(async () => {
    if (!canInstall) return;
    setBusy(true);
    setError(null);
    setDone(null);
    setLines([]);
    try {
      const result = await window.mcpServersAPI.install({
        id: effectiveId,
        source: kind === 'npm'
          ? { kind: 'npm', pkg: pkg.trim(), version: version.trim() || undefined }
          : { kind: 'github', url: url.trim(), subpath: subpath.trim() || undefined },
      });
      if (result.ok) {
        setDone({ toolCount: result.toolCount });
        onInstalled(result.id, result.toolCount);
      } else {
        setError(result.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [canInstall, effectiveId, kind, pkg, version, url, subpath, onInstalled]);

  const askClaude = useCallback(() => {
    const tail = lines.slice(-60).join('\n');
    onAskClaude(
      `Installing an MCP server into Acabox failed. Source: ${kind === 'npm' ? `npm package "${pkg}"` : `GitHub ${url}`}.\n\n` +
      `The error was: ${error ?? 'unknown'}\n\n` +
      `Installer log (last ${Math.min(lines.length, 60)} lines):\n\`\`\`\n${tail}\n\`\`\`\n\n` +
      'Please work out what went wrong and tell me whether it is fixable.',
    );
  }, [lines, error, kind, pkg, url, onAskClaude]);

  return (
    <div className="connectorForm serversInstall">
      <div className="serversInstall__header">
        <h2 className="serversInstall__title">Install a server</h2>
      </div>

      <div className="serversInstall__body">
        <div className="connectorField">
          <span className="connectorField__label">Where from</span>
          <div className="serversInstall__kinds">
            <label className="serversInstall__kind">
              <input
                type="radio" name="install-kind" value="npm"
                checked={kind === 'npm'} disabled={busy}
                onChange={() => setKind('npm')}
              />
              <span>npm package</span>
            </label>
            <label className="serversInstall__kind">
              <input
                type="radio" name="install-kind" value="github"
                checked={kind === 'github'} disabled={busy}
                onChange={() => setKind('github')}
              />
              <span>GitHub repository</span>
            </label>
          </div>
        </div>

        {kind === 'npm' ? (
          <>
            <div className="connectorField">
              <label className="connectorField__label" htmlFor="inst-pkg">Package name</label>
              <input
                id="inst-pkg" className="connectorField__input" value={pkg} disabled={busy}
                placeholder="@scope/server-name"
                onChange={(e) => setPkg(e.target.value)}
              />
              <div className="connectorField__help">
                As written on npm. A README that says <code>npx -y some-package</code> means the
                package name is <code>some-package</code>.
              </div>
            </div>
            <div className="connectorField">
              <label className="connectorField__label" htmlFor="inst-ver">Version</label>
              <input
                id="inst-ver" className="connectorField__input" value={version} disabled={busy}
                placeholder="latest"
                onChange={(e) => setVersion(e.target.value)}
              />
              <div className="connectorField__help">
                Leave blank for the newest. Whatever you choose, Acabox records the exact version
                that landed — never a range — so this install can be reproduced.
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="connectorField">
              <label className="connectorField__label" htmlFor="inst-url">Repository URL</label>
              <input
                id="inst-url" className="connectorField__input" value={url} disabled={busy}
                placeholder="https://github.com/owner/repo"
                onChange={(e) => setUrl(e.target.value)}
              />
              <div className="connectorField__help">
                Acabox resolves the branch to an exact commit before downloading anything, and
                records that commit.
              </div>
            </div>
            <div className="connectorField">
              <label className="connectorField__label" htmlFor="inst-sub">Folder inside the repo</label>
              <input
                id="inst-sub" className="connectorField__input" value={subpath} disabled={busy}
                placeholder="optional — e.g. src/my-server"
                onChange={(e) => setSubpath(e.target.value)}
              />
            </div>
          </>
        )}

        <div className="connectorField">
          <label className="connectorField__label" htmlFor="inst-id">Name in Acabox</label>
          <input
            id="inst-id" className="connectorField__input" value={effectiveId} disabled={busy}
            onChange={(e) => { setIdTouched(true); setId(e.target.value); }}
          />
          {idProblem
            ? <div className="serversInstall__error">{idProblem}</div>
            : <div className="connectorField__help">What Claude will call it. Letters, numbers and hyphens.</div>}
        </div>

        {/* Non-dismissible, and it leads with whose code this is — unlike an
            agent-authored server, nobody here watched it being written. */}
        <div className="serversInstall__disclosure">
          This installs someone else’s program and runs it on your Mac, with the same access to
          your files and accounts that you have. Once you turn it on, Claude uses its tools
          <strong> without asking you first</strong>, and the program tells Claude what its tools
          do — so one that describes itself dishonestly can mislead Claude.
          {' '}A pinned version makes it reproducible and auditable. It does not make it safe.
          {' '}<strong>It stays off until you turn it on.</strong>
        </div>

        {(busy || lines.length > 0) && (
          <div className="connectorField">
            <span className="connectorField__label">Progress</span>
            <pre className="serversInstall__log" ref={logRef}>{lines.join('\n') || 'Starting…'}</pre>
          </div>
        )}

        {error && <div className="serversInstall__error">{error}</div>}
        {done && (
          <div className="serversInstall__ok">
            Installed — it offers {done.toolCount} tool{done.toolCount === 1 ? '' : 's'}.
            Turn it on from the list when you are ready.
          </div>
        )}
      </div>

      <div className="serversInstall__footer">
        {/* The log survives failure on purpose: it is the only evidence, and
            it is what "Ask Claude to fix this" carries. */}
        {error && lines.length > 0 && (
          <>
            <button type="button" className="connectorBtn" onClick={() => void navigator.clipboard.writeText(lines.join('\n'))}>
              Copy log
            </button>
            <button type="button" className="connectorBtn" onClick={askClaude}>Ask Claude to fix this</button>
          </>
        )}
        <div className="serversInstall__spacer" />
        <button type="button" className="connectorBtn" onClick={onCancel} disabled={busy}>
          {done ? 'Close' : 'Cancel'}
        </button>
        {!done && (
          <button type="button" className="cdBtnPrimary" onClick={() => void install()} disabled={!canInstall}>
            {busy ? 'Installing…' : 'Install'}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * A package name or repo path turned into a plausible id. Exported for its
 * test: the scoped-package case (`@modelcontextprotocol/server-filesystem` →
 * `server-filesystem`) is the one everybody meets first, and taking the scope
 * instead would produce an id that collides across every package a vendor
 * publishes.
 */
export function deriveId(raw: string): string {
  const last = raw.trim().replace(/\.git$/, '').replace(/\/+$/, '').split('/').pop() ?? '';
  return last
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
