import React, { useCallback, useEffect, useState } from 'react';
import { MSymbol } from '../command-desk/MSymbol';
import { serverStateDotClass, serverStateLabel, type ServerRowModel } from '../../../shared/mcpServers';

/**
 * Right-docked detail panel for a hosted server (design:
 * `docs/design/mcp-hosting.md`, Increment 3). A panel, not a modal — the log
 * tail and live state transitions are a stream, and a modal would have to
 * either poll or be torn down and rebuilt on every push. Not a sub-route
 * either — the shell has no router. `ServersPage` positions this absolutely
 * over its own scroll area (`servers.css`'s `.serversDetail`) so the list
 * stays visible and scrollable behind it.
 *
 * Only ever opened for a `kind: 'hosted'` row — mini-app and built-in rows
 * have no supervisor-side lifecycle to manage, so there is nothing here for
 * them to show beyond what the row itself already displays.
 */
export function ServerDetail({
  row,
  onClose,
  onEdit,
  onOpenSchedule,
}: {
  row: ServerRowModel;
  onClose: () => void;
  onEdit: () => void;
  /**
   * Jump to Activity, where schedules live. A scheduled task runs through the
   * same `createAgentSession` path as a chat turn, so it sees this server's
   * tools exactly as a chat would — which is the entire feature, and is not
   * discoverable from here without saying so.
   */
  onOpenSchedule: () => void;
}) {
  const meta = row.meta.kind === 'hosted' ? row.meta : null;

  const [tools, setTools] = useState<McpHostToolDescriptorT[] | undefined>(undefined);
  const [stderrTail, setStderrTail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<McpHostProbeResultT | null>(null);
  // Increment 7's write gate (docs/design/mcp-hosting.md, DECISION 2026-08-13).
  // Not carried on `row.meta` (`shared/mcpServers.ts`'s `HostedRowMeta`) —
  // fetched the same way `tools`/`stderrTail` already are, straight off
  // `window.mcpServersAPI` in `reload()`, rather than widening that shared
  // row shape for one field only this panel reads. `undefined` here means
  // "every tool" (the default); `[]` means none — see `allSelected` below for
  // why this must never be read with a truthiness shortcut.
  const [enabledTools, setEnabledToolsState] = useState<string[] | undefined>(undefined);
  const [toolsBusy, setToolsBusy] = useState(false);

  const reload = useCallback(async () => {
    const [t, s, all] = await Promise.all([
      window.mcpServersAPI.inventory(row.id),
      window.mcpServersAPI.stderrTail(row.id),
      window.mcpServersAPI.list(),
    ]);
    setTools(t);
    setStderrTail(s);
    setEnabledToolsState(all.find((e) => e.id === row.id)?.enabledTools);
  }, [row.id]);

  useEffect(() => { void reload(); }, [reload]);

  if (!meta) return null;

  const isOff = row.state === 'off';
  // `toolCount` is `undefined` exactly when the supervisor has never reached
  // `ready` for this server THIS session — "never read" is a real, distinct
  // state from "read, and empty" (`shared/mcpServers.ts`'s own contract).
  const neverRead = meta.toolCount === undefined;

  const run = async (fn: () => Promise<McpHostActionResultT>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) setError(res.error ?? 'That did not work.');
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    if (!window.confirm(`Remove "${row.label}"? This stops it and deletes its saved configuration.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.mcpServersAPI.remove(row.id);
      if (!res.ok) { setError(res.error ?? 'Could not remove it.'); return; }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  // Increment 7's write gate. `allSelected` is the single source both the
  // top toggle and every per-tool checkbox's checked/disabled state derive
  // from — computed with `isToolSelected`'s own rule (`undefined` => every
  // tool), never a truthiness check on `enabledTools` directly, so an empty
  // array (a real, deliberate "none") can never be misread as "all".
  const allSelected = enabledTools === undefined;

  const persistEnabledTools = async (next: string[] | undefined) => {
    setToolsBusy(true);
    try {
      const res = await window.mcpServersAPI.setEnabledTools(row.id, next);
      if (!res.ok) { setError(res.error ?? 'Could not update the tool selection.'); return; }
      await reload();
    } finally {
      setToolsBusy(false);
    }
  };

  // Turning "All tools" OFF seeds an explicit array from the CURRENTLY known
  // tool set — nothing becomes uncallable at the instant of the toggle, only
  // once the user then unchecks an individual tool. Turning it back ON clears
  // to `undefined` rather than to "every currently-listed tool", which matters
  // if the server's own inventory ever changes: `undefined` tracks whatever
  // the server offers, an explicit full list would not.
  const handleAllToolsToggle = (checked: boolean) => {
    void persistEnabledTools(checked ? undefined : (tools ?? []).map((t) => t.name));
  };

  const handleToolToggle = (toolName: string, checked: boolean) => {
    const base = new Set(enabledTools ?? (tools ?? []).map((t) => t.name));
    if (checked) base.add(toolName); else base.delete(toolName);
    void persistEnabledTools([...base]);
  };

  const handleTest = async () => {
    setTestBusy(true);
    setTestResult(null);
    try {
      const result = await window.mcpServersAPI.test({
        id: row.id,
        command: meta.command,
        args: meta.args,
        envUpdates: {},
        envDeletes: [],
      });
      setTestResult(result);
      await reload();
    } finally {
      setTestBusy(false);
    }
  };

  return (
    <div className="serversDetail">
      <div className="serversDetail__header">
        <span className={`connectorDot ${serverStateDotClass(row.state)}`} aria-hidden="true" />
        <div className="serversDetail__title">{row.label}</div>
        <button type="button" className="cdIconBtn" onClick={onClose} title="Close">
          <MSymbol name="close" size={16} />
        </button>
      </div>

      <div className="serversDetail__body">
        <div className="serversDetail__status">
          {serverStateLabel(row.state)}{row.error ? ` · ${row.error}` : ''}
        </div>

        <div className="serversDetail__section">
          <div className="serversDetail__label">Command</div>
          <div className="serversDetail__mono">
            as typed: {meta.command} {meta.args.join(' ')}
          </div>
          <div className="serversDetail__mono">
            argv: {JSON.stringify([meta.command, ...meta.args])}
          </div>
        </div>

        <div className="serversDetail__section">
          <div className="serversDetail__label">Working directory</div>
          <div className="serversDetail__mono">
            {meta.cwd ?? "Acabox's own directory for this server (no cwd set)"}
          </div>
        </div>

        <div className="serversDetail__section">
          <div className="serversDetail__label">Environment</div>
          {meta.envKeys.length === 0 ? (
            <div className="serversDetail__muted">No environment variables.</div>
          ) : (
            <div>
              {meta.envKeys.map((k) => (
                <div key={k} className="serversDetail__mono">{k} = &bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</div>
              ))}
            </div>
          )}
        </div>

        <div className="serversDetail__section">
          <div className="serversDetail__label">Tools</div>
          {neverRead ? (
            <div className="serversDetail__muted">Never read — the server has not started.</div>
          ) : (
            <>
              <div className="serversDetail__muted">
                Read from the server
                {meta.startedAt ? ` at ${new Date(meta.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}.
              </div>
              {tools === undefined ? (
                <div className="serversDetail__muted">Loading&hellip;</div>
              ) : tools.length === 0 ? (
                <div className="serversDetail__muted">No tools.</div>
              ) : (
                <>
                  {/* Increment 7's write gate (docs/design/mcp-hosting.md,
                      DECISION 2026-08-13). The default reads as ONE plain
                      statement ("All tools enabled") rather than as a list of
                      individually-ticked boxes the user might believe they
                      set by hand — the per-tool checkboxes below are
                      disabled/greyed while this is on, so their checked state
                      visibly follows the default rather than looking like a
                      deliberate choice. Unchecking this is what makes them
                      interactive. */}
                  <label className="serversToolToggle">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      disabled={toolsBusy}
                      onChange={(e) => handleAllToolsToggle(e.target.checked)}
                    />
                    All tools enabled
                  </label>
                  <ul className="serversDetail__toolList serversDetail__toolList--selectable">
                    {tools.map((t) => {
                      const checked = allSelected || (enabledTools ?? []).includes(t.name);
                      return (
                        <li key={t.name} className="serversToolRow">
                          <label className={`serversToolRow__label${allSelected ? ' serversToolRow__label--implied' : ''}`}>
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={toolsBusy || allSelected}
                              onChange={(e) => handleToolToggle(t.name, e.target.checked)}
                            />
                            <span>
                              <code>{t.name}</code>
                              {t.description ? ` — ${t.description}` : ''}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </>
          )}
        </div>

        <div className="serversDetail__section">
          <div className="serversDetail__label">Log</div>
          <pre className="serversLog">{stderrTail || '(nothing written yet)'}</pre>
        </div>

        {meta && (
          <button type="button" className="connectorLink" onClick={onOpenSchedule}>
            Run something on a schedule with this server →
          </button>
        )}

        {error && <p className="gsStep__error">{error}</p>}

        <div className="serversDetail__actions">
          <button
            type="button"
            className="connectorBtn"
            disabled={busy || isOff}
            title={isOff ? 'Off — turn it on first' : undefined}
            onClick={() => void run(() => window.mcpServersAPI.restart(row.id))}
          >
            Restart
          </button>
          <button
            type="button"
            className="connectorBtn"
            disabled={busy}
            onClick={() => void run(() => (isOff
              ? window.mcpServersAPI.start(row.id)
              : window.mcpServersAPI.stop(row.id, { disable: true })))}
          >
            {isOff ? 'Turn on' : 'Turn off'}
          </button>
          <button type="button" className="connectorBtn" disabled={busy} onClick={onEdit}>Edit</button>
          <button type="button" className="connectorBtn" disabled={testBusy} onClick={() => void handleTest()}>
            {testBusy ? 'Testing…' : 'Test now'}
          </button>
          <button type="button" className="connectorBtn connectorBtn--danger" disabled={busy} onClick={() => void handleRemove()}>
            Remove
          </button>
        </div>

        {testResult && (
          <div className={`serversTestResult${testResult.ok ? ' serversTestResult--ok' : ' serversTestResult--error'}`}>
            {testResult.ok ? (
              <>
                <div className="serversTestResult__row">Resolved to <code>{testResult.resolvedCommand}</code></div>
                {!testResult.pathResolved && (
                  <div className="serversTestResult__row">
                    Acabox could not read your login shell&rsquo;s PATH — this used a fallback.
                  </div>
                )}
                <div className="serversTestResult__row">
                  {testResult.toolNames.length === 0
                    ? 'It answered, but offered no tools.'
                    : `${testResult.toolNames.length} tool${testResult.toolNames.length === 1 ? '' : 's'}: ${testResult.toolNames.join(', ')}`}
                </div>
              </>
            ) : (
              <>
                <div className="serversTestResult__row">{testResult.error ?? 'Could not start.'}</div>
                {testResult.stderrTail && (
                  <pre className="serversLog serversLog--compact">{testResult.stderrTail}</pre>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default ServerDetail;
