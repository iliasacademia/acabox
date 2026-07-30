import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { XIcon } from 'lucide-react';
import { MarkdownView } from '../fileViewers/MarkdownView';
import type { SkillDescriptor } from '../../../shared/skills';

/**
 * The detail modal for one skill or one memory.
 *
 * Shell is `.toolsConfirmOverlay` + `.savedFileViewer` — the same modal
 * ToolsPage already uses for saved tool data, so it is proven outside the Files
 * tab — widened for prose. Reading is `<MarkdownView>`, which already ships its
 * own Rendered/Source toggle.
 *
 * The save path carries a version check, and it is not decoration: the agent
 * has unrestricted `Write` into the store and the workspace render of it, so
 * "open the panel, ask Claude to fix the skill, then hit Save" silently
 * destroys the agent's edit. On a mismatch the save is refused and the user is
 * given the same three non-destructive choices the reconciler gives for an
 * upstream conflict — look at it, take theirs, or keep mine.
 */

export type DetailTarget =
  | { kind: 'skill'; skill: SkillDescriptor }
  | { kind: 'memory'; memory: MemoryFileInfo };

type Tab = 'read' | 'edit' | 'findings';

interface LedgerState {
  exists: boolean;
  bytes: number;
  lastReadNote: string;
  active: FindingRow[];
  archived: FindingRow[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const kb = bytes / 1000;
  if (kb < 1000) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return `${(kb / 1000).toFixed(1)} MB`;
}

/**
 * Split the YAML fence off the body for the Read pane.
 *
 * Presentational only — the authoritative verdict on whether the frontmatter
 * parses is `parseSkillFrontmatter`, and the row badge comes from there. This
 * exists because remark reads `---\nname: x\n---` as a setext heading and
 * renders the whole roster line as one enormous bold paragraph, which both
 * looks broken and misrepresents what the model is given.
 *
 * The regex is deliberately the same shape as the CLI's own
 * (`/^---\s*\n([\s\S]*?)---\s*\n?/`); a looser one here would show a fence the
 * CLI does not see.
 */
function splitFrontmatter(md: string): { fm: string | null; body: string } {
  const m = /^---\s*\n([\s\S]*?)---\s*\n?/.exec(md);
  if (!m) return { fm: null, body: md };
  return { fm: m[1]!.replace(/\s+$/, ''), body: md.slice(m[0].length) };
}

/**
 * Pull one entry's body out of a bucket file. Entries are `### <id> · <title>`
 * blocks, so the slice runs to the next heading at the same level.
 */
function sliceBlock(bucketText: string, findingId: string): string | null {
  const start = bucketText.search(new RegExp(`^###\\s+${findingId}(?![0-9A-Za-z-])`, 'm'));
  if (start < 0) return null;
  const rest = bucketText.slice(start + 3);
  const nextRel = rest.search(/^###\s/m);
  return (nextRel < 0 ? bucketText.slice(start) : bucketText.slice(start, start + 3 + nextRel)).trimEnd();
}

export function KnowledgeDetail({
  target,
  onClose,
  onChanged,
  onAskClaude,
  onOpenChat,
}: {
  target: DetailTarget;
  onClose: () => void;
  /** Something was written — the page reloads its lists. */
  onChanged: () => void;
  /** Compose a real chat turn and switch to it. */
  onAskClaude: (prompt: string) => void;
  onOpenChat?: (sessionId: string) => void;
}) {
  const isSkill = target.kind === 'skill';
  const title = isSkill ? `${target.skill.id}/SKILL.md` : target.memory.file;
  const storePath = isSkill ? target.skill.storePath : target.memory.academiaPath;
  const hasLedger = isSkill && target.skill.findingsCount !== undefined;

  const [tab, setTab] = useState<Tab>('read');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Bytes as they were when this modal opened — the version-check baseline. */
  const [baseline, setBaseline] = useState('');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ theirs: string } | null>(null);

  const [ledger, setLedger] = useState<LedgerState | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [bodies, setBodies] = useState<Record<string, string>>({});

  const readCurrent = useCallback(async (): Promise<{ ok: boolean; content: string; error?: string }> => {
    if (target.kind === 'skill') {
      const res = await window.skillsAPI.read(target.skill.id, 'SKILL.md');
      return { ok: res.ok, content: res.content ?? '', error: res.error };
    }
    // `academiaFile:read` collapses every failure to an empty string, so an
    // unreadable memory presents as an empty one. That is safe here (the worst
    // case is a spurious conflict on save, which refuses rather than writes)
    // but it is the reason this path cannot report a read error.
    const res = await window.academiaFileAPI.read(target.memory.academiaPath);
    return { ok: true, content: res.content };
  }, [target]);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadError(null);
    readCurrent().then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        setLoadError(res.error ?? 'Could not read the file.');
      } else {
        setBaseline(res.content);
        setDraft(res.content);
      }
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [readCurrent]);

  const loadLedger = useCallback(() => {
    if (!hasLedger || target.kind !== 'skill') return;
    window.knowledgeAPI.ledger(target.skill.id).then((snap) => {
      setLedger({
        exists: snap.exists,
        bytes: snap.bytes,
        lastReadNote: snap.lastReadNote,
        active: snap.active,
        archived: snap.archived,
      });
    });
  }, [hasLedger, target]);

  useEffect(() => {
    if (tab === 'findings') loadLedger();
  }, [tab, loadLedger]);

  const dirty = draft !== baseline;
  const { fm: frontmatter, body } = useMemo(() => splitFrontmatter(baseline), [baseline]);

  /** The write itself, with no version check. Only two callers, both below. */
  const writeDraft = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      if (target.kind === 'skill') {
        const res = await window.skillsAPI.write(target.skill.id, 'SKILL.md', draft);
        if (!res.ok) {
          setSaveError(res.error ?? 'Save failed.');
          return;
        }
      } else {
        await window.academiaFileAPI.write(target.memory.academiaPath, draft);
      }
      setBaseline(draft);
      onChanged();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }, [target, draft, onChanged]);

  const handleSave = useCallback(async () => {
    if (!dirty || saving) return;
    setSaveError(null);
    // Re-read and compare against the bytes this modal opened on. Hashing would
    // buy nothing here — the file is already in memory, so a byte comparison is
    // the same answer for less machinery.
    const current = await readCurrent();
    if (current.ok && current.content !== baseline) {
      setConflict({ theirs: current.content });
      return;
    }
    await writeDraft();
  }, [dirty, saving, readCurrent, baseline, writeDraft]);

  /** "Take the new version" — abandon the draft and adopt what is on disk. */
  const takeTheirs = useCallback(() => {
    if (!conflict) return;
    if (draft !== conflict.theirs && !window.confirm('Discard your edits and load the version on disk?')) {
      return;
    }
    setBaseline(conflict.theirs);
    setDraft(conflict.theirs);
    setConflict(null);
  }, [conflict, draft]);

  /** "Keep mine" — overwrite, having been told exactly what is being lost. */
  const keepMine = useCallback(async () => {
    if (!conflict) return;
    setBaseline(conflict.theirs);
    setConflict(null);
    await writeDraft();
  }, [conflict, writeDraft]);

  const toggleFinding = useCallback(async (row: FindingRow) => {
    if (target.kind !== 'skill') return;
    if (expanded === row.id) {
      setExpanded(null);
      return;
    }
    setExpanded(row.id);
    if (bodies[row.id] !== undefined) return;
    const res = await window.skillsAPI.read(target.skill.id, `references/findings/${row.file}`);
    const body = res.ok && res.content ? sliceBlock(res.content, row.id) : null;
    setBodies((prev) => ({
      ...prev,
      [row.id]: body ?? `Could not read ${row.file}.`,
    }));
  }, [target, expanded, bodies]);

  const supersede = useCallback(async (row: FindingRow) => {
    if (target.kind !== 'skill') return;
    const ok = window.confirm(
      `Mark ${row.id} superseded?\n\n"${row.title}"\n\n` +
      'Its body moves to the archive file and its index row moves with it. ' +
      'Nothing is deleted.',
    );
    if (!ok) return;
    await window.knowledgeAPI.supersede(target.skill.id, row.id);
    setExpanded(null);
    setBodies({});
    loadLedger();
    onChanged();
  }, [target, loadLedger, onChanged]);

  const askPrompt = useMemo(() => {
    if (target.kind === 'skill') {
      return (
        `Please improve the skill \`${target.skill.id}\`. Its files are at ` +
        `\`.claude/skills/${target.skill.id}/\` in the workspace.\n\n` +
        'Read SKILL.md first, then tell me what you would change before changing it. ' +
        'Keep the frontmatter `name` and `description` conformant, and remember the ' +
        'description costs roster characters on every turn.'
      );
    }
    return (
      `Please review the memory file \`${target.memory.academiaPath}\` (under ` +
      '`.academia/`). Read it, then tell me whether anything in it is now wrong or ' +
      'belongs in a skill instead of a memory.'
    );
  }, [target]);

  return (
    <div className="toolsConfirmOverlay" onClick={onClose}>
      <div className="savedFileViewer knowledgeDetail" onClick={(e) => e.stopPropagation()}>
        <div className="savedFileViewer__header">
          <span className="savedFileViewer__title">{title}</span>
          <button className="filePickerModal__close" onClick={onClose}>
            <XIcon style={{ width: 16, height: 16 }} />
          </button>
        </div>

        <div className="knowledgeDetail__tabs">
          <button
            type="button"
            className={`knowledgeDetail__tab${tab === 'read' ? ' knowledgeDetail__tab--active' : ''}`}
            onClick={() => setTab('read')}
          >
            Read
          </button>
          <button
            type="button"
            className={`knowledgeDetail__tab${tab === 'edit' ? ' knowledgeDetail__tab--active' : ''}`}
            onClick={() => setTab('edit')}
          >
            Edit{dirty ? ' •' : ''}
          </button>
          {hasLedger && (
            <button
              type="button"
              className={`knowledgeDetail__tab${tab === 'findings' ? ' knowledgeDetail__tab--active' : ''}`}
              onClick={() => setTab('findings')}
            >
              Findings
            </button>
          )}
        </div>

        <div className="savedFileViewer__body knowledgeDetail__body">
          {!loaded && <p className="knowledgeDetail__note">Loading…</p>}
          {loaded && loadError && <p className="gsStep__error">{loadError}</p>}

          {loaded && !loadError && tab === 'read' && (
            baseline.trim()
              ? (
                <>
                  {frontmatter && (
                    <div className="knowledgeFm">
                      <div className="knowledgeFm__label">Frontmatter</div>
                      <pre className="knowledgeFm__body">{frontmatter}</pre>
                    </div>
                  )}
                  <MarkdownView content={body} />
                </>
              )
              : <p className="knowledgeDetail__note">This file is empty.</p>
          )}

          {loaded && !loadError && tab === 'edit' && (
            <div className="knowledgeDetail__editWrap">
              <textarea
                className="wsSettings__textarea knowledgeDetail__editor"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
              />
              {conflict && (
                <div className="knowledgeConflict">
                  <div className="knowledgeConflict__title">
                    This file changed on disk while you had it open.
                  </div>
                  <div className="knowledgeConflict__body">
                    The copy on disk is now {formatBytes(new Blob([conflict.theirs]).size)} and it is
                    not what you opened. Claude can write here directly, so this is most likely its
                    work. Nothing has been saved.
                  </div>
                  <div className="knowledgeConflict__actions">
                    <button type="button" className="connectorBtn" onClick={takeTheirs}>
                      Take the new version
                    </button>
                    <button type="button" className="connectorBtn" onClick={() => void keepMine()}>
                      Keep mine
                    </button>
                  </div>
                </div>
              )}
              {saveError && <p className="gsStep__error">{saveError}</p>}
            </div>
          )}

          {loaded && tab === 'findings' && ledger && (
            <div className="knowledgeFindings">
              {ledger.active.length === 0 && ledger.archived.length === 0 && (
                <p className="knowledgeDetail__note">
                  This skill has a findings ledger, but nothing has been recorded in it yet.
                </p>
              )}
              {ledger.active.length > 0 && (
                <table className="knowledgeFindings__table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Finding</th>
                      <th>Scope</th>
                      <th>Recorded</th>
                      <th>Last read</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.active.map((row) => (
                      <React.Fragment key={row.id}>
                        <tr
                          className="knowledgeFindings__row"
                          onClick={() => void toggleFinding(row)}
                        >
                          <td className="knowledgeFindings__id">{row.id}</td>
                          <td>
                            <div className="knowledgeFindings__title">{row.title}</div>
                            <div className="knowledgeFindings__rule">{row.rule}</div>
                          </td>
                          <td className="knowledgeFindings__scope">{(row.scope ?? []).join(', ')}</td>
                          <td className="knowledgeFindings__when">{row.recorded}</td>
                          <td className="knowledgeFindings__when">{row.last_read ?? '—'}</td>
                          <td>
                            <button
                              type="button"
                              className="connectorBtn"
                              onClick={(e) => { e.stopPropagation(); void supersede(row); }}
                            >
                              Supersede
                            </button>
                          </td>
                        </tr>
                        {expanded === row.id && (
                          <tr>
                            <td colSpan={6} className="knowledgeFindings__bodyCell">
                              <pre className="knowledgeFindings__body">
                                {bodies[row.id] ?? 'Reading…'}
                              </pre>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="knowledgeDetail__note">
                {ledger.lastReadNote}
                {ledger.archived.length > 0 &&
                  ` ${ledger.archived.length} superseded finding${ledger.archived.length === 1 ? '' : 's'} ` +
                  'kept in the archive file.'}
              </p>
            </div>
          )}
        </div>

        <div className="knowledgeDetail__footer">
          <span className="knowledgeDetail__path" title={storePath}>{storePath}</span>
          <span className="knowledgeDetail__spacer" />
          {target.kind === 'memory' && target.memory.originChat && onOpenChat && (
            <button
              type="button"
              className="connectorBtn"
              onClick={() => onOpenChat(target.memory.originChat!.id)}
            >
              Open the chat that wrote this
            </button>
          )}
          {target.kind === 'skill' && (
            <button
              type="button"
              className="connectorBtn"
              onClick={() => void window.skillsAPI.reveal(target.skill.id)}
            >
              Reveal in Finder
            </button>
          )}
          <button type="button" className="connectorBtn" onClick={() => onAskClaude(askPrompt)}>
            Ask Claude to improve this
          </button>
          <button
            type="button"
            className="gsStep__btn gsStep__btn--secondary"
            onClick={() => setDraft(baseline)}
            disabled={!dirty || saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="gsStep__btn gsStep__btn--primary"
            onClick={() => void handleSave()}
            disabled={!dirty || saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
