import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useComposerRuntime } from '@assistant-ui/react';
import { MSymbol } from '../command-desk/MSymbol';
import { KnowledgeRow, type RowAction, type RowChip } from './KnowledgeRow';
import { KnowledgeDetail, type DetailTarget } from './KnowledgeDetail';
import { ImportSkillPanel } from './ImportSkillPanel';
import { validateSkillId, type SkillDescriptor } from '../../../shared/skills';
// Rows, buttons and the editor are borrowed wholesale from Settings, so their
// stylesheets are a real dependency of this page rather than an ambient one.
// Webpack dedupes; importing them here means the page cannot silently lose its
// styling if Settings is ever code-split or unmounted.
import '../ConnectorsSettings.css';
import '../DirectoryPermissions.css';
import '../shared-forms.css';
import './knowledge.css';

/**
 * Knowledge — what Claude can do here, and what it has learned.
 *
 * One page, sections by lifecycle, matching ToolsPage: skills and memories are
 * two containers for the same noun, and a section with nothing in it is not
 * rendered at all. Connectors deliberately stay in Settings next to the API
 * key — they are credentials — with one link at the foot.
 *
 * Two things the design asks for are NOT here, and their absence is the point:
 *
 *   - The roster budget meter. The only honest figure is
 *     `query.getContextUsage().skills`, which is a live control request through
 *     the agent server and is not plumbed. Computing the same arithmetic
 *     locally would be wrong, not merely approximate: the CLI also discovers
 *     the user's own `~/.claude/skills` (measured: 30 discovered against a
 *     23-entry allowlist), which spends the same budget and which this process
 *     cannot see. A bar reading "31%" that omits a third of the load is worse
 *     than no bar.
 *   - Any "recalled from memory" chip. Zero `memory_recall` events across all
 *     ten real production transcripts; automatic recall is gated off. It would
 *     be a story about how the system works that is not true here.
 */

function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const kb = bytes / 1000;
  if (kb < 1000) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return `${(kb / 1000).toFixed(1)} MB`;
}

/** "3h ago" / "yesterday" — prose, matching ActivityPanel rather than the chips. */
function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 9) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function originChip(origin: SkillDescriptor['origin']): RowChip {
  if (origin === 'builtin') return { label: 'BUILT IN', title: 'Ships with Acabox.' };
  if (origin === 'imported') return { label: 'IMPORTED', title: 'Fetched from a repository.' };
  return { label: 'MINE', title: 'You or Claude created this one here.' };
}

function skillChips(s: SkillDescriptor): RowChip[] {
  const chips: RowChip[] = [originChip(s.origin)];
  if (!s.enabled) {
    chips.push({
      label: 'OFF',
      tone: 'off',
      title: 'Not in the roster, so Claude will not see it listed. The files are still on disk.',
    });
  }
  if (!s.frontmatterOk) {
    chips.push({
      label: 'BROKEN',
      tone: 'warn',
      title: 'The CLI drops a skill whose frontmatter will not parse, silently.',
    });
  }
  // UNDEFINED for a custom skill — there is no shipped copy to compare against,
  // so neither MODIFIED nor its absence would be a claim we can support.
  if (s.modified === true) {
    chips.push({ label: 'MODIFIED', tone: 'warn', title: 'Differs from the version Acabox ships.' });
  }
  if (s.license) {
    // Displayed verbatim as metadata, but a licence field is a free-text string
    // and some are whole sentences ("Proprietary. LICENSE.txt has complete
    // terms"). Uppercased into a 9px chip that is unreadable, so the chip is
    // clipped and the real value is on the hover title.
    const label = s.license.length > 22 ? `${s.license.slice(0, 21)}…` : s.license;
    chips.push({ label: label.toUpperCase(), title: s.license });
  }
  if (s.findingsCount !== undefined) {
    chips.push({
      label: `${s.findingsCount} FINDING${s.findingsCount === 1 ? '' : 'S'}`,
      tone: 'good',
      title: 'Things Claude discovered while working and wrote back into this skill.',
    });
  }
  if (s.execCount > 0) {
    chips.push({
      label: `${s.execCount} SCRIPT${s.execCount === 1 ? '' : 'S'}`,
      title: 'Runnable files. They run with your privileges the moment Claude invokes one.',
    });
  }
  return chips;
}

/**
 * The provenance prefix of an imported skill's meta line, with the short SHA
 * hyperlinked to the exact tree on GitHub.
 *
 * A plain `<a href>` is correct here and is not an oversight: `externalLinks`
 * installs a `will-frame-navigate` guard on every WebContents that cancels
 * remote navigation and hands the URL to `shell.openExternal`, so the click
 * opens the default browser and the app never navigates away.
 */
function provenancePrefix(s: SkillDescriptor): React.ReactNode {
  const p = s.provenance;
  if (!p) return null;
  if (p.kind === 'local-folder') {
    return <>{p.localPath} &middot;{' '}</>;
  }
  if (!p.owner || !p.repo) return null;
  const short = p.sha ? p.sha.slice(0, 7) : null;
  return (
    <>
      {p.owner}/{p.repo}
      {short && (
        <>
          {' @ '}
          {p.url ? (
            <a className="knowledgeRow__shaLink" href={p.url} title={`${p.sha} — open this exact tree on GitHub`}>
              {short}
            </a>
          ) : short}
        </>
      )}
      {p.subpath && <> &middot; {p.subpath}</>}
      {' · '}
    </>
  );
}

function skillMeta(s: SkillDescriptor): string {
  const parts: string[] = [];
  parts.push(`SKILL.md ${formatBytes(s.skillMdBytes)}`);
  if (s.fileCount > 1) parts.push(`${s.fileCount} files`);
  // The one roster number that IS measurable here. The total is not — the CLI
  // also budgets the user's own ~/.claude/skills, which this process cannot
  // see — but a single skill's description length is exactly its own share of
  // the cost, and it is the number to look at before writing a longer one.
  if (s.description) parts.push(`desc ${s.description.length} chars`);
  if (s.importedAt) {
    const t = Date.parse(s.importedAt);
    if (!Number.isNaN(t)) parts.push(`imported ${timeAgo(t)}`);
  } else if (s.changedAt) {
    parts.push(`changed ${timeAgo(s.changedAt)}`);
  }
  return parts.join(' · ');
}

export function KnowledgePage({
  onSwitchToChat,
  onOpenChat,
  onOpenSettings,
}: {
  /** Switch the shell to the chat view; the prompt is composed here. */
  onSwitchToChat: () => void;
  onOpenChat: (sessionId: string) => void;
  onOpenSettings: () => void;
}) {
  const composerRuntime = useComposerRuntime();

  const [skills, setSkills] = useState<SkillDescriptor[]>([]);
  const [memories, setMemories] = useState<MemoryFileInfo[]>([]);
  const [reviews, setReviews] = useState<KnowledgeReviewItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const reload = useCallback(async () => {
    const [s, m, r] = await Promise.all([
      window.skillsAPI.list(),
      window.knowledgeAPI.memories(),
      window.knowledgeAPI.listReviews(),
    ]);
    setSkills(s);
    setMemories(m.files);
    setReviews(r);
    setLoaded(true);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  // A removed built-in still has a state entry so a later release does not
  // re-seed it; it is not a thing the user has, so it is not listed.
  const liveSkills = useMemo(() => skills.filter((s) => !s.removed), [skills]);
  const enabledCount = liveSkills.filter((s) => s.enabled).length;
  const restorable = useMemo(
    () => skills.some((s) => s.origin === 'builtin' && (s.removed || s.modified === true)),
    [skills],
  );
  // MEMORY.md is the index the CLI loads every turn, not a memory in its own
  // right; counting it would overstate what Claude has actually learned.
  const memoryCount = memories.filter((m) => !m.isIndex).length;

  const askClaude = useCallback((prompt: string, sessionId?: string) => {
    if (sessionId) onOpenChat(sessionId); else onSwitchToChat();
    composerRuntime.setText(prompt);
    composerRuntime.send();
  }, [composerRuntime, onOpenChat, onSwitchToChat]);

  const runMutation = useCallback(async (id: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusyId(id);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) setError(res.error ?? 'That did not work.');
      await reload();
    } finally {
      setBusyId(null);
    }
  }, [reload]);

  const handleRestoreAll = useCallback(async () => {
    const summary = await window.skillsAPI.summarizeRestore();
    const lines: string[] = [];
    if (summary.modified.length) {
      lines.push(`${summary.modified.length} edited: ${summary.modified.join(', ')}`);
    }
    if (summary.removed.length) {
      lines.push(`${summary.removed.length} removed: ${summary.removed.join(', ')}`);
    }
    if (lines.length === 0) return;
    const ok = window.confirm(
      `Restore the built-in skills Acabox ships?\n\n${lines.join('\n')}\n\n` +
      `${summary.unaffected.length} untouched built-in skill${summary.unaffected.length === 1 ? '' : 's'} ` +
      'are left alone, and so is every skill you or Claude made. Your versions go to the ' +
      'skills trash, not the bin.',
    );
    if (!ok) return;
    setBusyId('__restore__');
    try {
      await window.skillsAPI.restoreAll();
      await reload();
    } finally {
      setBusyId(null);
    }
  }, [reload]);

  const skillActions = useCallback((s: SkillDescriptor): RowAction[] => {
    const busy = busyId === s.id;
    const actions: RowAction[] = [
      { label: 'Open', onClick: () => setDetail({ kind: 'skill', skill: s }), disabled: busy },
      {
        label: s.enabled ? 'Disable' : 'Enable',
        disabled: busy,
        title: s.enabled
          ? 'Take it off the roster. The files stay; Claude stops seeing it listed.'
          : 'Put it back on the roster.',
        onClick: () => void runMutation(s.id, () => window.skillsAPI.setEnabled(s.id, !s.enabled)),
      },
    ];
    if (s.modified === true) {
      actions.push({
        label: 'Revert',
        disabled: busy,
        onClick: () => {
          const ok = window.confirm(
            `Restore the version of "${s.id}" that Acabox ships?\n\n` +
            'Your copy moves to the skills trash, where it stays for 30 days.',
          );
          if (ok) void runMutation(s.id, () => window.skillsAPI.revert(s.id));
        },
      });
    }
    if (s.origin !== 'builtin') {
      actions.push({
        label: 'Delete',
        danger: true,
        disabled: busy,
        onClick: () => {
          const ok = window.confirm(
            `Delete the skill "${s.id}"?\n\n` +
            'It moves to the skills trash, where it stays for 30 days.',
          );
          if (ok) void runMutation(s.id, () => window.skillsAPI.remove(s.id));
        },
      });
    }
    return actions;
  }, [busyId, runMutation]);

  return (
    <div className="pageShell">
      <div className="pageShell__inner">
        <div className="pageShell__headerBlock">
          <div className="pageShell__stats">
            {liveSkills.length} {liveSkills.length === 1 ? 'SKILL' : 'SKILLS'} ·{' '}
            {memoryCount} {memoryCount === 1 ? 'MEMORY' : 'MEMORIES'}
          </div>
          <h1 className="pageShell__title">Knowledge</h1>
          <p className="pageShell__subtitle">
            What Claude can do here, and what it has learned. All of it is markdown you can
            read and correct.
          </p>
        </div>

        {error && <p className="gsStep__error">{error}</p>}

        {reviews.length > 0 && (
          <section className="toolsSection">
            <h2 className="toolsSection__heading">
              Needs attention
              <span className="toolsSection__count">{reviews.length}</span>
            </h2>
            <div className="knowledgeAttention">
              {reviews.map((r) => (
                <ReviewRow
                  key={r.id}
                  review={r}
                  timeLabel={timeAgo(r.at)}
                  onAct={askClaude}
                  onReviewSkill={(skillId) => {
                    const s = liveSkills.find((x) => x.id === skillId);
                    if (s) setDetail({ kind: 'skill', skill: s });
                  }}
                  onDismiss={() => {
                    void window.knowledgeAPI.dismissReview(r.id).then(reload);
                  }}
                />
              ))}
            </div>
          </section>
        )}

        <button className="toolsAskCard" onClick={() => setShowAdd(true)}>
          <div className="toolsAskCard__icon">
            <MSymbol name="book_2" size={20} />
          </div>
          <div className="toolsAskCard__text">
            <div className="toolsAskCard__title">Add a skill</div>
            <div className="toolsAskCard__description">
              A skill is a folder of instructions Claude loads when it decides the job needs
              them &mdash; a warehouse&rsquo;s traps, a house query form, a procedure worth
              getting right twice.
            </div>
          </div>
          <MSymbol name="arrow_forward" size={18} />
        </button>

        <section className="toolsSection">
          <h2 className="toolsSection__heading">
            Skills
            <span className="toolsSection__count">{liveSkills.length}</span>
          </h2>
          <div className="connectorList">
            {!loaded && <div className="knowledgeEmpty">Loading&hellip;</div>}
            {loaded && liveSkills.length === 0 && (
              <div className="knowledgeEmpty">No skills in the store.</div>
            )}
            {liveSkills.map((s) => (
              <KnowledgeRow
                key={s.id}
                name={s.id}
                alias={s.declaredName}
                chips={skillChips(s)}
                description={
                  s.frontmatterOk
                    ? s.description
                    // js-yaml's message carries a multi-line snippet of the
                    // offending source. The first line names the fault; the
                    // rest belongs in the editor, which is one click away.
                    : `Frontmatter did not parse${s.frontmatterError ? `: ${s.frontmatterError.split('\n')[0]!.trim()}` : ''}. Claude will not see this skill at all.`
                }
                meta={<>{provenancePrefix(s)}{skillMeta(s)}</>}
                actions={skillActions(s)}
                dimmed={!s.enabled}
                onOpen={() => setDetail({ kind: 'skill', skill: s })}
              />
            ))}
          </div>
          <div className="knowledgeSectionFoot">
            <span className="knowledgeSectionFoot__note">
              {enabledCount} of {liveSkills.length} on the roster. A skill that is off keeps its
              files and stays readable; Claude just stops seeing it listed.
            </span>
            {restorable && (
              <button
                type="button"
                className="connectorLink"
                onClick={() => void handleRestoreAll()}
                disabled={busyId === '__restore__'}
              >
                Restore built-in skills&hellip;
              </button>
            )}
          </div>
        </section>

        {memories.length > 0 && (
          <section className="toolsSection">
            <h2 className="toolsSection__heading">
              What Claude has learned
              <span className="toolsSection__count">{memoryCount}</span>
            </h2>
            <div className="connectorList">
              {memories.map((m) => (
                <KnowledgeRow
                  key={m.file}
                  name={m.declaredName ?? m.file}
                  chips={memoryChips(m)}
                  description={m.description}
                  meta={
                    <>
                      {formatBytes(m.bytes)}
                      {m.changedAt > 0 && ` · changed ${timeAgo(m.changedAt)}`}
                      {!m.isIndex && !m.indexed && ' · not indexed in MEMORY.md'}
                      {m.originChat && (
                        <>
                          {' · from '}
                          <button
                            type="button"
                            className="knowledgeRow__chatLink"
                            onClick={() => onOpenChat(m.originChat!.id)}
                          >
                            &ldquo;{m.originChat.title}&rdquo;
                          </button>
                        </>
                      )}
                    </>
                  }
                  actions={[{ label: 'Open', onClick: () => setDetail({ kind: 'memory', memory: m }) }]}
                  onOpen={() => setDetail({ kind: 'memory', memory: m })}
                />
              ))}
            </div>
          </section>
        )}

        <button type="button" className="connectorLink knowledgeConnectorLink" onClick={onOpenSettings}>
          Claude reaches Hex and other services through Connectors &rarr;
        </button>
      </div>

      {showAdd && (
        <AddSkillModal
          existingIds={skills.map((s) => s.id)}
          onClose={() => setShowAdd(false)}
          onAsk={(prompt) => { setShowAdd(false); askClaude(prompt); }}
          onCreated={async (id) => {
            setShowAdd(false);
            const list = await window.skillsAPI.list();
            setSkills(list);
            const created = list.find((s) => s.id === id);
            if (created) setDetail({ kind: 'skill', skill: created });
          }}
        />
      )}

      {detail && (
        <KnowledgeDetail
          target={detail}
          onClose={() => setDetail(null)}
          onChanged={() => void reload()}
          onAskClaude={(prompt) => { setDetail(null); askClaude(prompt); }}
          onOpenChat={onOpenChat}
        />
      )}
    </div>
  );
}

function memoryChips(m: MemoryFileInfo): RowChip[] {
  const chips: RowChip[] = [];
  if (m.isIndex) {
    chips.push({
      label: 'INDEX',
      title: 'Loaded on every turn. Every other memory is reached through a link in here.',
    });
    return chips;
  }
  // No chip at all when the file has no frontmatter — `about_you.md` and
  // `working_on.md` genuinely declare no type, and inventing one would be the
  // fabrication this page exists to avoid.
  if (m.type) chips.push({ label: m.type.toUpperCase() });
  if (!m.indexed) {
    chips.push({
      label: 'UNLINKED',
      tone: 'warn',
      title: 'MEMORY.md does not link to this file, so the model has no pointer to it.',
    });
  }
  return chips;
}

function ReviewRow({
  review,
  timeLabel,
  onAct,
  onReviewSkill,
  onDismiss,
}: {
  review: KnowledgeReviewItem;
  timeLabel: string;
  onAct: (prompt: string, sessionId?: string) => void;
  onReviewSkill: (skillId: string) => void;
  onDismiss: () => void;
}) {
  if (review.kind === 'possible-supersession') {
    const ids = (review.findingIds ?? []).join(' / ');
    return (
      <div className="cdActivityRow">
        <MSymbol name="compare_arrows" size={18} className="cdActivityRow__icon" />
        <div className="cdActivityRow__main">
          <div className="cdActivityRow__title">
            {ids || 'Two findings'} may say the same thing
            {review.skill ? ` in ${review.skill}` : ''}
          </div>
          <div className="cdActivityRow__sub">{timeLabel}</div>
        </div>
        {review.skill && (
          <button type="button" className="connectorBtn" onClick={() => onReviewSkill(review.skill!)}>
            Review
          </button>
        )}
        <button type="button" className="connectorBtn" onClick={onDismiss}>Dismiss</button>
      </div>
    );
  }

  const connectors = (review.connectors ?? []).join(', ');
  // Composed into the ORIGINAL chat, not a new one: the whole value of the
  // extraction is that the transcript is in context. A fresh chat would be
  // asking the model to remember a conversation it never had.
  const prompt =
    `Earlier in this chat you used ${connectors || 'a connector'} without reading anything under ` +
    '`references/findings/`. Look back over what you established about those systems — a table ' +
    'that returned zero rows, a join that worked, a query form that avoided a timeout, an API ' +
    'quirk — and record each one with `mcp__knowledge__record_finding`. If nothing in this ' +
    'conversation qualifies, say so plainly and record nothing.';

  return (
    <div className="cdActivityRow">
      <MSymbol name="database_off" size={18} className="cdActivityRow__icon" />
      <div className="cdActivityRow__main">
        <div className="cdActivityRow__title">
          This chat queried {connectors || 'a connector'} without consulting the ledger
        </div>
        <div className="cdActivityRow__sub">
          {review.chatTitle ? `"${review.chatTitle}" · ` : ''}{timeLabel}
        </div>
      </div>
      <button
        type="button"
        className="connectorBtn"
        disabled={!review.sessionId}
        title={review.sessionId ? undefined : 'That chat no longer exists.'}
        onClick={() => onAct(prompt, review.sessionId)}
      >
        Ask Claude to extract it
      </button>
      <button type="button" className="connectorBtn" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}

/**
 * Write a skill, hand the job to Claude, or import one from elsewhere.
 *
 * Two modes on one modal rather than two entry points: "I want Claude to know
 * how to do X" is one intention, and whether the answer already exists in a
 * repository is a detail of how it gets satisfied.
 */
function AddSkillModal({
  existingIds,
  onClose,
  onAsk,
  onCreated,
}: {
  existingIds: string[];
  onClose: () => void;
  onAsk: (prompt: string) => void;
  onCreated: (id: string) => void | Promise<void>;
}) {
  const [mode, setMode] = useState<'write' | 'import'>('write');
  const [id, setId] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The unpacked catalogue is tens of MB in a temp directory. Nothing else
  // frees it, so closing the modal has to.
  const close = useCallback(() => {
    void window.skillsAPI.cancelImport();
    onClose();
  }, [onClose]);

  const idProblem = useMemo(() => {
    if (!id) return null;
    const v = validateSkillId(id);
    if (!v.ok) return v.error;
    if (existingIds.includes(id)) return `There is already a skill called "${id}".`;
    return null;
  }, [id, existingIds]);

  const canCreate = id.length > 0 && !idProblem && !creating;

  const handleCreate = async () => {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    const res = await window.skillsAPI.create(id, description.trim() || undefined);
    setCreating(false);
    if (!res.ok) {
      setError(res.error ?? 'Could not create the skill.');
      return;
    }
    await onCreated(id);
  };

  return (
    <div className="toolsConfirmOverlay" onClick={close}>
      <div
        className={`knowledgeAddModal${mode === 'import' ? ' knowledgeAddModal--import' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="createToolModal__title">Add a skill</h2>
        <p className="createToolModal__subtitle">
          A folder of instructions Claude loads when it decides the job needs them. Only the
          one-line description is in context every turn; the body costs nothing until the skill
          is actually used.
        </p>

        <div className="knowledgeAddModal__modes">
          <button
            type="button"
            className={`knowledgeDetail__tab${mode === 'write' ? ' knowledgeDetail__tab--active' : ''}`}
            onClick={() => setMode('write')}
          >
            Write one
          </button>
          <button
            type="button"
            className={`knowledgeDetail__tab${mode === 'import' ? ' knowledgeDetail__tab--active' : ''}`}
            onClick={() => setMode('import')}
          >
            Import from GitHub
          </button>
        </div>

        {mode === 'import' && (
          <ImportSkillPanel
            onCancel={close}
            onImported={async (importedId) => {
              await window.skillsAPI.cancelImport();
              await onCreated(importedId);
            }}
          />
        )}

        {mode === 'write' && (
        <>
        <div className="connectorField">
          <label className="connectorField__label" htmlFor="knowledge-skill-id">Name</label>
          <input
            id="knowledge-skill-id"
            className="connectorField__input connectorField__input--mono"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="coscientist-analytics"
            autoFocus
          />
          <span className="connectorField__help">
            Lowercase letters, digits and single hyphens. This is the name Claude types to load
            it, and it is the directory name on disk.
          </span>
          {idProblem && <p className="gsStep__error">{idProblem}</p>}
        </div>

        <div className="connectorField">
          <label className="connectorField__label" htmlFor="knowledge-skill-desc">
            When should Claude use it?
          </label>
          <textarea
            id="knowledge-skill-desc"
            className="wsSettings__textarea"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="How to analyse Co-Scientist product data in Redshift through the Hex connector."
          />
          <span className="connectorField__help">
            Becomes the skill&rsquo;s <code>description</code>. It is the only part Claude reads
            before deciding whether to load the skill, so write it as the question it should catch.
          </span>
        </div>

        {error && <p className="gsStep__error">{error}</p>}

        <div className="connectorForm__actions">
          <button type="button" className="gsStep__btn gsStep__btn--secondary" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="gsStep__btn gsStep__btn--secondary"
            onClick={() => onAsk(
              'Please write me a new skill' + (id ? ` called \`${id}\`` : '') + '.' +
              (description.trim() ? `\n\nIt is for: ${description.trim()}` : '') +
              '\n\nUse the manage-mini-application skill’s conventions for the folder layout, ' +
              'create it under `.claude/skills/`, and ask me for whatever you need to know before ' +
              'you write the body. Keep the frontmatter `description` to one sentence — it costs ' +
              'roster characters on every turn.',
            )}
          >
            Ask Claude to write it
          </button>
          <button
            type="button"
            className="gsStep__btn gsStep__btn--primary"
            onClick={() => void handleCreate()}
            disabled={!canCreate}
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
        </>
        )}
      </div>
    </div>
  );
}
