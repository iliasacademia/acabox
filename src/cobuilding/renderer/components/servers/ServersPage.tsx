import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useComposerRuntime } from '@assistant-ui/react';
import { KnowledgeRow, type RowAction } from '../knowledge/KnowledgeRow';
import { ServerDetail } from './ServerDetail';
import { ServerConfigForm, type ServerFormInitial } from './ServerConfigForm';
import {
  builtinServerLabel,
  serverStateDotTone,
  serverStateLabel,
  type ServerRowModel,
} from '../../../shared/mcpServers';
import { useServerRows } from '../../mcpServerStore';
// Rows, buttons and fields are borrowed wholesale from Settings → Connectors
// (`.connectorRow`, `.connectorBtn`, `.connectorField`, …) — see
// `KnowledgePage.tsx:8-15` for why importing the stylesheet here, rather than
// relying on it being loaded by some other screen, is the right call: this
// page cannot silently lose its styling if Settings is ever code-split away.
import '../ConnectorsSettings.css';
import './servers.css';

/**
 * Servers — MCP servers Acabox runs on THIS machine (design:
 * `docs/design/mcp-hosting.md`, Increment 3, as narrowed by the
 * 2026-08-05 DECISION block and the two scope overrides that shipped ahead
 * of it):
 *
 *  - **Local only.** Servers = processes Acabox spawns and supervises here.
 *    Connectors = remote services Acabox connects to. So there are three
 *    sections below — hosted, mini-app-published, built-in — and no fourth
 *    "remote" one, even though the plumbing (`ServerRowModel`'s `'remote'`
 *    kind) still exists in the store for later use.
 *  - **No curated catalog.** R1's own six-candidate catalog didn't survive
 *    contact with the npm registry (three never existed there, one is
 *    npm-deprecated, the two survivors duplicate tools the agent already
 *    has via `Bash`/`Read`/`Write`). So the only way to ADD a server here is
 *    the Advanced command+argv form — and the empty state below points at
 *    the real acquisition path (ask Claude to write one, Increment 5) rather
 *    than at that form, which is why the form is reachable but never the
 *    loudest thing on the page.
 *
 * **Increment 5 — "Authored by Claude" is a review queue, not a duplicate
 * listing.** A server the agent wrote into `<workspace>/.mcp-servers/<id>/`
 * arrives `enabled: false` (`main/mcpHost/authored.ts`'s
 * `scanAndAdoptAuthoredServers`) and stays that way until the user approves
 * it — so it is excluded from "Running here" entirely (`isPendingAuthored`
 * below) rather than shown there dimmed with a generic Start button. That
 * exclusion is load-bearing, not cosmetic: `ServerDetail.tsx`'s "Turn on"
 * button calls the generic `mcpServers:start`, which enables and spawns
 * whatever `entry` the record currently has — for a not-yet-promoted
 * authored record that would run the WORKSPACE copy directly, defeating the
 * whole promote-on-enable security model. Once approved (promoted at least
 * once), a row graduates permanently into "Running here" — where `entry`
 * always points at the promoted copy, so the generic Start/Stop/Restart/Open
 * actions are safe — and this page adds only a drift note + a "Re-promote"
 * action to that row (`authoredInfoById`), never a second copy of it.
 */

/**
 * The structural rule that keeps the vocabulary honest: `.connectorRow__status`
 * (the `description` prop below) carries ONLY the shared word from
 * `serverStateLabel()` plus, for `failed`, the plain-language reason — never a
 * kind-specific fact. `pid`, uptime, and the command line all live in `meta`
 * (`.connectorRow__target`) instead, via `hostedTarget()` below. `pid 41823`
 * must never be able to land next to `Available`.
 */
function hostedStatusText(row: ServerRowModel): string {
  return serverStateLabel(row.state) + (row.error ? ` · ${row.error}` : '');
}

/**
 * `driftCount` is present only for an agent-authored, already-approved row —
 * see `authoredInfoById` below for why it is fetched separately from
 * everything else in `meta` (it needs a directory hash, which does not belong
 * on the hot `list()`/`onChanged()` path). Appended to the mono meta line,
 * never to the shared status word above it — same "kind-specific facts live
 * in `meta`, never in the status line" rule this file's own header comment
 * states for `pid`/command.
 */
function hostedTarget(meta: Extract<ServerRowModel['meta'], { kind: 'hosted' }>, driftCount?: number): string {
  const parts: string[] = [];
  if (meta.pid != null) parts.push(`pid ${meta.pid}`);
  if (meta.toolCount !== undefined) parts.push(`${meta.toolCount} tool${meta.toolCount === 1 ? '' : 's'}`);
  parts.push([meta.command, ...meta.args].join(' ') || '(no command)');
  if (meta.install.kind === 'authored' && driftCount !== undefined && driftCount > 0) {
    parts.push(`${driftCount} change${driftCount === 1 ? '' : 's'} in the workspace since you approved`);
  }
  return parts.join(' · ');
}

export function ServersPage({
  onSwitchToChat,
  onOpenSettings,
  onOpenSchedule,
}: {
  /** Switch the shell to the chat view — the empty state's real acquisition path. */
  onSwitchToChat: () => void;
  onOpenSettings: () => void;
  /** Jump to Activity, where scheduled tasks live. */
  onOpenSchedule: () => void;
}) {
  const composerRuntime = useComposerRuntime();
  const rows = useServerRows();

  const allHostedRows = useMemo(() => rows.filter((r) => r.kind === 'hosted'), [rows]);
  // `enabled === false` (`serverStateToRunState` maps that to `'off'` before
  // anything else) is a reliable proxy for "never promoted" here because
  // nothing in this app's UI can flip an authored record back to `enabled:
  // false` once `approveAuthoredServer` has set it true — there is no
  // generic "disable" affordance wired up on this page today (only Start/
  // Stop/Restart/Remove), so nothing races this assumption.
  const isPendingAuthored = useCallback(
    (r: ServerRowModel) => r.meta.kind === 'hosted' && r.meta.install.kind === 'authored' && r.state === 'off',
    [],
  );
  const hostedRows = useMemo(() => allHostedRows.filter((r) => !isPendingAuthored(r)), [allHostedRows, isPendingAuthored]);
  const pendingAuthoredRows = useMemo(() => allHostedRows.filter(isPendingAuthored), [allHostedRows, isPendingAuthored]);
  const miniAppRows = useMemo(() => rows.filter((r) => r.kind === 'miniapp'), [rows]);
  const builtinRows = useMemo(() => rows.filter((r) => r.kind === 'builtin'), [rows]);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<'add' | 'edit' | null>(null);
  const [formInitial, setFormInitial] = useState<ServerFormInitial | undefined>(undefined);
  const [showBuiltins, setShowBuiltins] = useState(false);

  // Increment 5: the manifest description + drift count for every authored
  // server, fetched separately from `rows` above — see `hostedTarget`'s own
  // comment for why (it would otherwise re-hash a directory on every status
  // broadcast). Refetched on mount, after any row mutation on this page, and
  // on demand via "Check for new servers".
  const [authoredInfo, setAuthoredInfo] = useState<AuthoredListResultT>({ servers: [], rejected: [] });
  const [rescanBusy, setRescanBusy] = useState(false);
  const authoredInfoById = useMemo(
    () => new Map(authoredInfo.servers.map((s) => [s.id, s] as const)),
    [authoredInfo.servers],
  );
  const refreshAuthoredInfo = useCallback(async () => {
    setAuthoredInfo(await window.mcpServersAPI.listAuthored());
  }, []);
  useEffect(() => { void refreshAuthoredInfo(); }, [refreshAuthoredInfo]);
  const handleRescanAuthored = useCallback(async () => {
    setRescanBusy(true);
    try {
      await window.mcpServersAPI.rescanAuthored();
    } finally {
      setRescanBusy(false);
      await refreshAuthoredInfo();
    }
  }, [refreshAuthoredInfo]);

  const detailRow = detailId ? hostedRows.find((r) => r.id === detailId) ?? null : null;

  const askClaude = useCallback(() => {
    onSwitchToChat();
    // A starter, not a spec — "describe what you need" is the user's job,
    // this just gets a dialogue going rather than dropping them on a blank
    // composer with no sense of what a local server even is.
    composerRuntime.setText(
      "I'd like a small local MCP server for something I do here. Ask me what I need before writing anything.",
    );
    composerRuntime.send();
  }, [composerRuntime, onSwitchToChat]);

  const openAddForm = useCallback(() => {
    setFormInitial(undefined);
    setFormMode('add');
  }, []);

  const openEditForm = useCallback((row: ServerRowModel) => {
    if (row.meta.kind !== 'hosted') return;
    setFormInitial({
      id: row.id,
      label: row.label,
      command: row.meta.command,
      args: row.meta.args,
      autostart: row.meta.autostart,
      envKeys: row.meta.envKeys,
    });
    setFormMode('edit');
    setDetailId(null);
  }, []);

  const runMutation = useCallback(async (id: string, fn: () => Promise<McpHostActionResultT>) => {
    setBusyId(id);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) setError(res.error ?? 'That did not work.');
    } finally {
      setBusyId(null);
      // Cheap (a store read + a per-server directory hash, not a re-scan)
      // and covers every mutation this page can make that would change an
      // authored row's description/drift/pending status: approve, re-
      // promote, and remove all land here through the same helper.
      void refreshAuthoredInfo();
    }
  }, [refreshAuthoredInfo]);

  const hostedActions = useCallback((row: ServerRowModel): RowAction[] => {
    const busy = busyId === row.id;
    const actions: RowAction[] = [
      { label: 'Open', onClick: () => setDetailId(row.id), disabled: busy },
    ];
    if (row.state === 'off' || row.state === 'stopped') {
      actions.push({
        label: 'Start', disabled: busy,
        onClick: () => void runMutation(row.id, () => window.mcpServersAPI.start(row.id)),
      });
    } else if (row.state === 'failed') {
      actions.push({
        label: 'Restart', disabled: busy,
        onClick: () => void runMutation(row.id, () => window.mcpServersAPI.restart(row.id)),
      });
    } else {
      actions.push({
        label: 'Stop', disabled: busy,
        onClick: () => void runMutation(row.id, () => window.mcpServersAPI.stop(row.id)),
      });
    }
    // Increment 5: an approved authored row that has drifted from what was
    // last promoted gets one extra action — re-copy the workspace files and
    // restart with them. Gated on `driftCount > 0` rather than always shown:
    // re-promoting identical bytes is harmless but pointless, and a button
    // that's always there teaches the user to ignore it.
    if (row.meta.kind === 'hosted' && row.meta.install.kind === 'authored') {
      const drift = authoredInfoById.get(row.id)?.driftCount;
      if (drift !== undefined && drift > 0) {
        actions.push({
          label: 'Re-promote', disabled: busy,
          title: 'Copy the changed files from the workspace and restart with them.',
          onClick: () => void runMutation(row.id, () => window.mcpServersAPI.approveAuthored(row.id)),
        });
      }
    }
    actions.push({
      label: 'Remove', danger: true, disabled: busy,
      onClick: () => {
        if (window.confirm(`Remove "${row.label}"? This stops it and deletes its saved configuration.`)) {
          void runMutation(row.id, () => window.mcpServersAPI.remove(row.id));
        }
      },
    });
    return actions;
  }, [busyId, runMutation, authoredInfoById]);

  return (
    <div className="serversPage">
      <div className="pageShell">
        <div className="pageShell__inner">
          <div className="pageShell__headerBlock">
            <div className="pageShell__stats">
              {hostedRows.length} {hostedRows.length === 1 ? 'SERVER' : 'SERVERS'} RUNNING HERE
            </div>
            <h1 className="pageShell__title">Servers</h1>
            <p className="pageShell__subtitle">
              Local MCP servers Acabox runs on this machine — separate from Connectors, which
              are remote services Acabox connects to.
            </p>
          </div>

          {error && <p className="gsStep__error">{error}</p>}

          {/* ── Running here — always rendered ───────────────────────── */}
          <section className="toolsSection">
            <div className="toolsSection__headingRow">
              <h2 className="toolsSection__heading">
                Running here
                <span className="toolsSection__count">{hostedRows.length}</span>
              </h2>
              {hostedRows.length > 0 && (
                <button type="button" className="connectorLink" onClick={openAddForm}>+ Add a server</button>
              )}
            </div>

            {hostedRows.length === 0 ? (
              // Genuinely nothing at all — not even something pending Claude
              // wrote is waiting for review — is what "No servers yet" is for.
              // With a pending-authored row and nothing else running, that
              // sentence would read as false right above the section that
              // contradicts it, so it renders only when both are empty.
              pendingAuthoredRows.length === 0 && (
                <div className="serversEmpty">
                  <p className="serversEmpty__lead">
                    No servers yet. Ask Claude to build one for you — describe what you need in a
                    chat and it can write and run a small server.
                  </p>
                  <div className="serversEmpty__links">
                    <button type="button" className="connectorLink" onClick={askClaude}>Open chat</button>
                    <button type="button" className="connectorLink" onClick={openAddForm}>
                      Advanced: add a server yourself
                    </button>
                  </div>
                </div>
              )
            ) : (
              <div className="connectorList">
                {hostedRows.map((row) => {
                  const meta = row.meta.kind === 'hosted' ? row.meta : null;
                  if (!meta) return null;
                  const drift = meta.install.kind === 'authored' ? authoredInfoById.get(row.id)?.driftCount : undefined;
                  return (
                    <KnowledgeRow
                      key={row.id}
                      name={row.label}
                      dot={{ tone: serverStateDotTone(row.state), title: serverStateLabel(row.state) }}
                      description={hostedStatusText(row)}
                      meta={hostedTarget(meta, drift)}
                      actions={hostedActions(row)}
                      dimmed={row.state === 'off'}
                      onOpen={() => setDetailId(row.id)}
                    />
                  );
                })}
              </div>
            )}
          </section>

          {/* ── Authored by Claude — a review queue, only while non-empty ──
              (design: docs/design/mcp-hosting.md, Increment 5). Rows here
              are always `enabled: false`; once approved a server graduates
              into "Running here" above and disappears from this list, so
              nothing is ever shown in both sections at once. */}
          {(pendingAuthoredRows.length > 0 || authoredInfo.rejected.length > 0) && (
            <section className="toolsSection">
              <div className="toolsSection__headingRow">
                <h2 className="toolsSection__heading">
                  Authored by Claude
                  <span className="toolsSection__count">{pendingAuthoredRows.length}</span>
                </h2>
                <button
                  type="button"
                  className="connectorLink"
                  disabled={rescanBusy}
                  onClick={() => void handleRescanAuthored()}
                >
                  {rescanBusy ? 'Checking…' : 'Check for new servers'}
                </button>
              </div>
              {pendingAuthoredRows.length > 0 && (
                <>
                  <p className="serversAuthoredNote">
                    Small local servers Claude has written into your workspace, waiting for you to
                    review. Nothing here runs until you enable it — Acabox then copies the files
                    out and runs that copy, so editing them afterwards changes nothing until you
                    approve again.
                  </p>
                  <div className="connectorList">
                    {pendingAuthoredRows.map((row) => {
                      const info = authoredInfoById.get(row.id);
                      const busy = busyId === row.id;
                      return (
                        <KnowledgeRow
                          key={row.id}
                          name={row.label}
                          chips={[{ label: 'Awaiting review' }]}
                          description={info?.description || 'No description given.'}
                          meta={`.mcp-servers/${row.id}`}
                          actions={[
                            {
                              label: 'Review & enable',
                              disabled: busy,
                              onClick: () => void runMutation(row.id, () => window.mcpServersAPI.approveAuthored(row.id)),
                            },
                            {
                              label: 'Remove',
                              danger: true,
                              disabled: busy,
                              onClick: () => {
                                if (window.confirm(`Remove "${row.label}"? Acabox won't offer to adopt this workspace directory again.`)) {
                                  void runMutation(row.id, () => window.mcpServersAPI.remove(row.id));
                                }
                              },
                            },
                          ]}
                        />
                      );
                    })}
                  </div>
                </>
              )}
              {authoredInfo.rejected.length > 0 && (
                <div className="knowledgeSectionFoot">
                  <span className="knowledgeSectionFoot__note">
                    {authoredInfo.rejected.length} item{authoredInfo.rejected.length === 1 ? '' : 's'} in
                    {' '}.mcp-servers could not be adopted:{' '}
                    {authoredInfo.rejected.map((r) => `"${r.dir}" — ${r.reason}`).join('; ')}
                  </span>
                </div>
              )}
            </section>
          )}

          {/* ── Published by your tools — only when non-empty ───────── */}
          {miniAppRows.length > 0 && (
            <section className="toolsSection">
              <h2 className="toolsSection__heading">
                Published by your tools
                <span className="toolsSection__count">{miniAppRows.length}</span>
              </h2>
              <div className="connectorList">
                {miniAppRows.map((row) => {
                  const meta = row.meta.kind === 'miniapp' ? row.meta : null;
                  if (!meta) return null;
                  return (
                    <KnowledgeRow
                      key={row.id}
                      name={row.label}
                      description={serverStateLabel(row.state)}
                      meta={`published by ${meta.dirName} · ${meta.toolCount} tool${meta.toolCount === 1 ? '' : 's'}`}
                    />
                  );
                })}
              </div>
              <div className="knowledgeSectionFoot">
                <span className="knowledgeSectionFoot__note">
                  A tool publishes its server while it is open and withdraws it when you close
                  it. Claude can only call these while the tool is on screen — there is nothing
                  to configure and nothing to start.
                </span>
              </div>
            </section>
          )}

          {/* ── Built into Acabox — collapsed, read-only ────────────── */}
          <section className="toolsSection">
            <button
              type="button"
              className="connectorLink"
              onClick={() => setShowBuiltins((v) => !v)}
            >
              {showBuiltins ? 'Hide' : 'Show'} built into Acabox ({builtinRows.length})
            </button>
            {showBuiltins && (
              <div className="connectorList serversBuiltin">
                {builtinRows.map((row) => {
                  const meta = row.meta.kind === 'builtin' ? row.meta : null;
                  if (!meta) return null;
                  return (
                    <KnowledgeRow
                      key={row.id}
                      name={builtinServerLabel(row.id)}
                      meta={`${meta.toolNames.length} tool${meta.toolNames.length === 1 ? '' : 's'}: ${meta.toolNames.join(', ')}`}
                    />
                  );
                })}
              </div>
            )}
          </section>

          <button type="button" className="connectorLink" onClick={onOpenSettings}>
            Remote services are configured in Settings &rarr; Connectors
          </button>
        </div>
      </div>

      {formMode && (
        <div className="serversFormOverlay">
          <ServerConfigForm
            mode={formMode}
            initial={formInitial}
            existingIds={hostedRows.filter((r) => r.id !== formInitial?.id).map((r) => r.id)}
            onSaved={() => setFormMode(null)}
            onCancel={() => setFormMode(null)}
          />
        </div>
      )}

      {detailRow && (
        <ServerDetail
          row={detailRow}
          onClose={() => setDetailId(null)}
          onEdit={() => openEditForm(detailRow)}
          onOpenSchedule={onOpenSchedule}
        />
      )}
    </div>
  );
}

export default ServersPage;
