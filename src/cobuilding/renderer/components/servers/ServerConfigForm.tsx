import React, { useCallback, useMemo, useState } from 'react';
import { CONNECTOR_ID_RULE, CONNECTOR_ID_PATTERN } from '../../../shared/connectors';

/**
 * The Advanced command+argv form (design: `docs/design/mcp-hosting.md`,
 * Increment 3 — the DECISION block cut the curated catalog, so this
 * command-typed form is the ONLY way to add a hosted server in this pass;
 * Increment 5's agent-authored path is the intended everyday route, and
 * `ServersPage`'s empty state points at chat first, this form second).
 *
 * Two properties this file exists to hold, both load-bearing:
 *
 *  - **Arguments are a rows editor, never a parsed string.** The historical
 *    bug this replaces (`ConnectorsSettings.tsx`'s old
 *    `d.args.trim().split(/\s+/)`) cannot represent a path containing a
 *    space under `shell:false` — there is no way to type quoting that a
 *    plain whitespace split would honour. One row = one argv element, passed
 *    exactly as typed; the shell-quoted preview beside it is READ-ONLY and
 *    explicitly labelled as not the thing that runs.
 *  - **The disclosure is verbatim and non-dismissible.** Every word of it
 *    (`docs/design/mcp-hosting.md`'s "Required disclosure copy" section) is
 *    reproduced exactly, always rendered — never behind a click-to-expand,
 *    never gated on the form otherwise being valid.
 */

export interface ServerFormInitial {
  id: string;
  label: string;
  command: string;
  args: string[];
  autostart: boolean;
  /** Keys only — values are never sent to the renderer. Seeds masked rows on edit. */
  envKeys: string[];
}

/** One argv element, unquoted and unescaped — the property that makes a
 *  path with a space representable at all. */
function shellQuote(value: string): string {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_.\-/:=@%]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellPreview(command: string, args: readonly string[]): string {
  return [command, ...args].filter((a) => a !== '').map(shellQuote).join(' ');
}

export function ServerConfigForm({
  mode,
  initial,
  existingIds,
  onSaved,
  onCancel,
}: {
  mode: 'add' | 'edit';
  initial?: ServerFormInitial;
  /** Every OTHER hosted server's id, for add-mode uniqueness. */
  existingIds: string[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState(initial?.id ?? '');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [command, setCommand] = useState(initial?.command ?? '');
  const [argRows, setArgRows] = useState<string[]>(initial?.args.length ? [...initial.args] : ['']);
  const [autostart, setAutostart] = useState(initial?.autostart ?? false);
  // `existing: true` rows came from the record's own (masked) env keys — a
  // blank value there means "keep the stored one". `existing: false` rows
  // are new in this session, where a blank value just means no value.
  const [envRows, setEnvRows] = useState<Array<{ key: string; value: string; existing: boolean }>>(
    (initial?.envKeys ?? []).map((key) => ({ key, value: '', existing: true })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<McpHostProbeResultT | null>(null);

  const args = useMemo(() => argRows.filter((a) => a !== ''), [argRows]);

  const idProblem = useMemo(() => {
    if (mode === 'edit') return null; // immutable once created
    const trimmed = id.trim();
    if (!trimmed) return null; // "required" is enforced by disabling Save, not by an error string
    if (!CONNECTOR_ID_PATTERN.test(trimmed)) return `Invalid name "${trimmed}". ${CONNECTOR_ID_RULE}`;
    if (existingIds.includes(trimmed)) return `A server named "${trimmed}" already exists.`;
    return null;
  }, [mode, id, existingIds]);

  const canSave = id.trim().length > 0 && command.trim().length > 0 && !idProblem && !busy;

  const buildEnvPatch = useCallback(() => {
    const envUpdates: Record<string, string> = {};
    const seenKeys = new Set<string>();
    for (const row of envRows) {
      const key = row.key.trim();
      if (!key) continue;
      seenKeys.add(key);
      if (row.value !== '') envUpdates[key] = row.value;
    }
    const envDeletes = (initial?.envKeys ?? []).filter((k) => !seenKeys.has(k));
    return { envUpdates, envDeletes };
  }, [envRows, initial?.envKeys]);

  const handleTest = useCallback(async () => {
    setTestBusy(true);
    setTestResult(null);
    try {
      const { envUpdates, envDeletes } = buildEnvPatch();
      const result = await window.mcpServersAPI.test({
        id: mode === 'edit' ? id.trim() : undefined,
        command: command.trim(),
        args,
        envUpdates,
        envDeletes,
      });
      setTestResult(result);
    } finally {
      setTestBusy(false);
    }
  }, [mode, id, command, args, buildEnvPatch]);

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const { envUpdates, envDeletes } = buildEnvPatch();
      const result = await window.mcpServersAPI.save({
        id: id.trim(),
        label: label.trim(),
        command: command.trim(),
        args,
        envUpdates,
        envDeletes,
        autostart,
      });
      if (!result.ok) {
        setError(result.error ?? 'Could not save this server.');
        return;
      }
      onSaved();
    } finally {
      setBusy(false);
    }
  }, [canSave, id, label, command, args, autostart, buildEnvPatch, onSaved]);

  const setArgRow = (i: number, value: string) =>
    setArgRows((rows) => rows.map((r, j) => (j === i ? value : r)));
  const removeArgRow = (i: number) =>
    setArgRows((rows) => (rows.length > 1 ? rows.filter((_, j) => j !== i) : ['']));
  const addArgRow = () => setArgRows((rows) => [...rows, '']);

  const setEnvRow = (i: number, patch: Partial<{ key: string; value: string }>) =>
    setEnvRows((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const removeEnvRow = (i: number) => setEnvRows((rows) => rows.filter((_, j) => j !== i));
  const addEnvRow = () => setEnvRows((rows) => [...rows, { key: '', value: '', existing: false }]);

  const resolvedForDisclosure = testResult?.resolvedCommand || command.trim() || '(command)';

  return (
    <div className="connectorForm serversForm">
      <div className="connectorForm__title">
        {mode === 'edit' ? `Edit ${initial?.id}` : 'Add a server (advanced)'}
      </div>

      <p className="connectorForm__note">
        Most people never need this form — describe what you want in a chat and Claude can
        write and run a small server for you. This is the manual path: a command Acabox will
        run directly, with no shell in between.
      </p>

      <label className="connectorField">
        <span className="connectorField__label">Name</span>
        <input
          className="connectorField__input connectorField__input--mono"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="filesystem"
          disabled={mode === 'edit'}
          autoFocus={mode === 'add'}
        />
        <span className="connectorField__help">
          The agent calls its tools as <code>mcp__{id || 'name'}__…</code>. {CONNECTOR_ID_RULE}
        </span>
        {idProblem && <p className="gsStep__error">{idProblem}</p>}
      </label>

      <label className="connectorField">
        <span className="connectorField__label">Label</span>
        <input
          className="connectorField__input"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={id || 'Display name'}
        />
      </label>

      <label className="connectorField">
        <span className="connectorField__label">Command</span>
        <input
          className="connectorField__input connectorField__input--mono"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="npx"
        />
      </label>

      <div className="connectorField">
        <span className="connectorField__label">Arguments</span>
        {argRows.map((row, i) => (
          <div key={i} className="serversArgRow">
            <input
              className="connectorField__input connectorField__input--mono"
              value={row}
              onChange={(e) => setArgRow(i, e.target.value)}
              placeholder="-y"
            />
            <button type="button" className="connectorBtn" onClick={() => removeArgRow(i)}>−</button>
          </div>
        ))}
        <button type="button" className="connectorLink" onClick={addArgRow}>+ Add argument</button>
        <span className="connectorField__help">
          Each row is one argument, passed exactly as typed. Acabox does not run a shell, so
          quotes and $VARIABLES are not interpreted — a path with a space belongs in one row,
          unquoted.
        </span>
        <div className="serversArgvPreview">
          <span className="serversArgvPreview__label">How this would look in a shell (not what actually runs):</span>
          <code>{shellPreview(command.trim() || '(command)', args)}</code>
        </div>
      </div>

      <div className="connectorField">
        <span className="connectorField__label">Environment</span>
        {envRows.map((row, i) => (
          <div key={i} className="connectorHeaderRow">
            <input
              className="connectorField__input connectorField__input--mono"
              value={row.key}
              onChange={(e) => setEnvRow(i, { key: e.target.value })}
              placeholder="API_TOKEN"
            />
            <input
              className="connectorField__input connectorField__input--mono"
              type="password"
              value={row.value}
              onChange={(e) => setEnvRow(i, { value: e.target.value })}
              placeholder={row.existing ? 'saved — leave blank to keep' : 'value'}
            />
            <button type="button" className="connectorBtn" onClick={() => removeEnvRow(i)}>−</button>
          </div>
        ))}
        <button type="button" className="connectorLink" onClick={addEnvRow}>+ Add variable</button>
      </div>

      <label className="connectorCheck">
        <input type="checkbox" checked={autostart} onChange={(e) => setAutostart(e.target.checked)} />
        <span>
          Start automatically
          <span className="connectorField__help">
            Off by default: a newly added server stays off until you start it. Turn this on to
            have it start every time Acabox does.
          </span>
        </span>
      </label>

      <div className="serversDisclosure">
        Adding this server means Acabox will run <code>{resolvedForDisclosure}</code> on your
        machine, with your user account and your files, every time you start it. Every tool it
        offers is auto-approved: Acabox supplies no permission handler, so Claude calls them
        without asking you, and the server&rsquo;s own description of each tool is instruction
        text the model will follow. A pinned commit makes it reproducible and auditable.{' '}
        <strong>It does not make it safe.</strong>
      </div>

      <div className="connectorForm__actions" style={{ justifyContent: 'space-between' }}>
        <button type="button" className="connectorBtn" onClick={() => void handleTest()} disabled={testBusy || !command.trim()}>
          {testBusy ? 'Testing…' : 'Test'}
        </button>
        <div className="connectorForm__actions">
          <button type="button" className="gsStep__btn gsStep__btn--secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="gsStep__btn gsStep__btn--primary" onClick={() => void handleSave()} disabled={!canSave}>
            {busy ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Add server'}
          </button>
        </div>
      </div>

      {testResult && (
        <div className={`serversTestResult${testResult.ok ? ' serversTestResult--ok' : ' serversTestResult--error'}`}>
          {testResult.ok ? (
            <>
              <div>Started successfully.</div>
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
              <div>{testResult.error ?? 'Could not start.'}</div>
              {testResult.stderrTail && (
                <pre className="serversLog serversLog--compact">{testResult.stderrTail}</pre>
              )}
            </>
          )}
        </div>
      )}

      {error && <p className="gsStep__error">{error}</p>}
    </div>
  );
}

export default ServerConfigForm;
