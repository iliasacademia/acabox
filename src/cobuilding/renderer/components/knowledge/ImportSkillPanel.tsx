import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { validateSkillId } from '../../../shared/skills';

/**
 * Import a skill from a pinned GitHub commit, or from a folder on disk.
 *
 * Three steps, and none of them is skippable, because each one is a thing the
 * user has to be able to refuse:
 *
 *   1. **URL.** Resolved to a 40-character commit SHA before anything is
 *      downloaded. A pin recorded as a branch name is not a pin.
 *   2. **Browse**, when the link names a repository root. `openai/plugins`
 *      holds 581 skills and the whole browsable list — descriptions included —
 *      comes out of the one tarball, so the filter runs against local data and
 *      picking a second skill costs no network at all.
 *   3. **Preview.** The `SKILL.md` body, the file count, the executable count,
 *      and the honest sentence about what importing means. The body is shown
 *      in full and unrendered: it is instructions the model will follow, and
 *      markdown formatting would make it read as documentation rather than as
 *      the payload it is.
 *
 * An import always lands OFF the roster. That is enforced in the main process
 * and merely reported here — the roster is a fixed character budget already
 * near its ceiling, and past ~20 characters per skill the CLI silently drops
 * every description, which breaks skills the user never touched.
 */

/** Ellipsised at the front: the tail of a repository path is the identifying part. */
function shortSubpath(subpath: string, max = 52): string {
  return subpath.length <= max ? subpath : `…${subpath.slice(-(max - 1))}`;
}

/**
 * A `license` is free text and some are whole sentences — every
 * `anthropics/skills` entry declares "Complete terms in LICENSE.txt", which at
 * full length in a 9px chip swamps the skill's own name. Clipped, with the real
 * value on the hover title, exactly as `KnowledgePage` clips it on a row.
 */
function licenseChip(license: string): string {
  const label = license.length > 22 ? `${license.slice(0, 21)}…` : license;
  return label.toUpperCase();
}

function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const kb = bytes / 1000;
  if (kb < 1000) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return `${(kb / 1000).toFixed(1)} MB`;
}

/**
 * Electron wraps a rejected `invoke` as `Error invoking remote method
 * 'skills:x': Error: <real message>`. The importer's messages are written for
 * a human ("GitHub's hourly request limit is used up…"); the IPC plumbing in
 * front of them is not.
 */
function importError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const stripped = raw.replace(/^Error invoking remote method '[^']*':\s*/, '');
  return stripped.replace(/^(Error|TypeError):\s*/, '');
}

type Step =
  | { kind: 'url' }
  | { kind: 'catalogue'; target: ParsedImportUrl; result: CatalogueResult }
  | { kind: 'preview'; request: ImportRequest; preview: SkillImportPreview };

export function ImportSkillPanel({
  onImported,
  onCancel,
}: {
  onImported: (id: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: 'url' });
  /**
   * The catalogue the current preview was picked out of, so Back returns to
   * the list rather than to an empty URL field. Kept beside `step` because the
   * list is 581 rows the user has already filtered; sending them back to the
   * start to look at a second skill would make comparing two impossible.
   */
  const [lastCatalogue, setLastCatalogue] = useState<{ target: ParsedImportUrl; result: CatalogueResult } | null>(null);
  const [url, setUrl] = useState('');
  const [filter, setFilter] = useState('');
  const [asId, setAsId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  // Bytes received, never a percentage: codeload's response is chunked with no
  // `content-length`, so there is no denominator and inventing one would be a
  // fabricated progress bar.
  useEffect(() => {
    const onProgress = (_e: unknown, p: ImportProgress) => setProgress(p);
    window.electronAPI.on('skills:importProgress', onProgress);
    return () => window.electronAPI.removeListener('skills:importProgress', onProgress);
  }, []);

  const run = useCallback(async <T,>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy(label);
    setError(null);
    setProgress(null);
    try {
      return await fn();
    } catch (err) {
      setError(importError(err));
      return null;
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }, []);

  const openPreview = useCallback(async (request: ImportRequest) => {
    const preview = await run('Reading the skill…', () => window.skillsAPI.previewImport(request));
    if (!preview) return;
    // Prefilled with the free alternative when the source name is taken, so
    // the collision is one keystroke-free click to resolve — but it is still
    // shown in an editable field, because renaming a skill silently would give
    // the user a skill whose own prose refers to a name that does not exist.
    setAsId(preview.collides ? (preview.suggestedId ?? '') : preview.id);
    setStep({ kind: 'preview', request, preview });
  }, [run]);

  const handleLookup = useCallback(async () => {
    const target = await run('Resolving the commit…', () => window.skillsAPI.parseImportUrl(url));
    if (!target) return;
    if (target.kind === 'skill') {
      await openPreview({
        kind: 'github-subdir',
        owner: target.owner,
        repo: target.repo,
        sha: target.sha,
        ref: target.ref,
        subpath: target.subpath,
      });
      return;
    }
    const result = await run('Downloading the repository…', () =>
      window.skillsAPI.fetchCatalogue({
        owner: target.owner,
        repo: target.repo,
        ref: target.ref,
        sha: target.sha,
        subpath: target.subpath,
      }),
    );
    if (!result) return;
    setFilter('');
    setLastCatalogue({ target, result });
    setStep({ kind: 'catalogue', target, result });
    // The list is the only thing on screen and it is long; land the caret in
    // the filter rather than making the user click into it.
    window.setTimeout(() => filterRef.current?.focus(), 0);
  }, [openPreview, run, url]);

  const handlePickFolder = useCallback(async () => {
    const localPath = await window.skillsAPI.pickImportFolder();
    if (!localPath) return;
    await openPreview({ kind: 'local-folder', localPath });
  }, [openPreview]);

  const handleImport = useCallback(async () => {
    if (step.kind !== 'preview') return;
    const result = await run('Importing…', () => window.skillsAPI.importSkill(step.request, asId));
    if (!result) return;
    if (!result.ok || !result.id) {
      setError(result.error ?? 'Could not import that skill.');
      return;
    }
    await onImported(result.id);
  }, [asId, onImported, run, step]);

  return (
    <>
      {step.kind === 'url' && (
        <UrlStep
          url={url}
          onUrl={setUrl}
          busy={busy}
          onLookup={() => void handleLookup()}
          onPickFolder={() => void handlePickFolder()}
        />
      )}

      {step.kind === 'catalogue' && (
        <CatalogueStep
          target={step.target}
          result={step.result}
          filter={filter}
          onFilter={setFilter}
          filterRef={filterRef}
          busy={busy}
          onPick={(skill) => void openPreview({
            kind: 'github-subdir',
            owner: step.result.owner,
            repo: step.result.repo,
            sha: step.result.sha,
            ref: step.result.ref,
            subpath: skill.subpath,
          })}
        />
      )}

      {step.kind === 'preview' && (
        <PreviewStep preview={step.preview} asId={asId} onAsId={setAsId} />
      )}

      {busy && (
        <p className="knowledgeImport__busy">
          {busy}
          {progress?.phase === 'downloading' && ` ${formatBytes(progress.receivedBytes)}`}
          {progress?.phase === 'extracting' && ' unpacking'}
        </p>
      )}
      {error && <p className="gsStep__error">{error}</p>}

      <div className="connectorForm__actions">
        <button type="button" className="gsStep__btn gsStep__btn--secondary" onClick={onCancel}>
          Cancel
        </button>
        {step.kind !== 'url' && (
          <button
            type="button"
            className="gsStep__btn gsStep__btn--secondary"
            disabled={!!busy}
            onClick={() => {
              setError(null);
              setStep(backFrom(step, lastCatalogue));
            }}
          >
            Back
          </button>
        )}
        {step.kind === 'preview' && (
          <button
            type="button"
            className="gsStep__btn gsStep__btn--primary"
            disabled={!!busy || !!idProblemFor(asId, step.preview)}
            onClick={() => void handleImport()}
          >
            {busy === 'Importing…' ? 'Importing…' : 'Import, off the roster'}
          </button>
        )}
      </div>
    </>
  );
}

/**
 * Where Back goes: to the catalogue the preview came out of, when there is one
 * and it is the same repository at the same commit. The catalogue is still
 * cached in the main process, so this costs nothing.
 */
function backFrom(
  step: Step,
  lastCatalogue: { target: ParsedImportUrl; result: CatalogueResult } | null,
): Step {
  if (
    step.kind === 'preview' &&
    step.request.kind === 'github-subdir' &&
    lastCatalogue &&
    lastCatalogue.result.owner === step.request.owner &&
    lastCatalogue.result.repo === step.request.repo &&
    lastCatalogue.result.sha === step.request.sha
  ) {
    return { kind: 'catalogue', target: lastCatalogue.target, result: lastCatalogue.result };
  }
  return { kind: 'url' };
}

/** Why the chosen store id cannot be used, or null. */
function idProblemFor(asId: string, preview: SkillImportPreview): string | null {
  const trimmed = asId.trim();
  if (!trimmed) return 'A name is required.';
  const v = validateSkillId(trimmed);
  if (!v.ok) return v.error;
  if (preview.collides && trimmed === preview.id) {
    return `There is already a skill called "${preview.id}". Pick another name.`;
  }
  return null;
}

// ---------------------------------------------------------------------------

function UrlStep({
  url,
  onUrl,
  busy,
  onLookup,
  onPickFolder,
}: {
  url: string;
  onUrl: (v: string) => void;
  busy: string | null;
  onLookup: () => void;
  onPickFolder: () => void;
}) {
  return (
    <>
      <div className="connectorField">
        <label className="connectorField__label" htmlFor="knowledge-import-url">
          GitHub link
        </label>
        <div className="knowledgeImport__urlRow">
          <input
            id="knowledge-import-url"
            className="connectorField__input connectorField__input--mono"
            value={url}
            onChange={(e) => onUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && url.trim() && !busy) onLookup(); }}
            placeholder="https://github.com/anthropics/skills"
            spellCheck={false}
            autoFocus
          />
          <button
            type="button"
            className="connectorBtn"
            onClick={onLookup}
            disabled={!url.trim() || !!busy}
          >
            Look up
          </button>
        </div>
        <span className="connectorField__help">
          A repository root lists everything inside it to pick from; a link to one folder
          imports that folder. Whatever you paste, the branch is resolved to a commit and it is
          the commit that gets recorded &mdash; so the import is reproducible even after the
          branch moves.
        </span>
      </div>

      <div className="knowledgeImport__localRow">
        <button type="button" className="connectorBtn" onClick={onPickFolder} disabled={!!busy}>
          Choose a folder&hellip;
        </button>
        <span className="knowledgeImport__localHelp">
          Or import a skill folder already on this machine. It is copied into the store, not
          linked, and goes through the same checks.
        </span>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function CatalogueStep({
  target,
  result,
  filter,
  onFilter,
  filterRef,
  busy,
  onPick,
}: {
  target: ParsedImportUrl;
  result: CatalogueResult;
  filter: string;
  onFilter: (v: string) => void;
  filterRef: React.RefObject<HTMLInputElement | null>;
  busy: string | null;
  onPick: (skill: CatalogueSkill) => void;
}) {
  /**
   * Every match is rendered — no windowing, no cap.
   *
   * Measured against the real `openai/plugins` at 581 entries in the running
   * app: 62–70 ms from keystroke to painted frame for the worst case (clearing
   * the filter back to all 581), and 9–17 ms for the ordinary case of narrowing
   * it. Virtualising that would be a dependency and a scroll-restoration bug
   * traded for nothing. Re-measure before adding one.
   */
  const matches = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return result.skills;
    return result.skills.filter((s) =>
      s.id.toLowerCase().includes(needle) ||
      s.subpath.toLowerCase().includes(needle) ||
      (s.declaredName?.toLowerCase().includes(needle) ?? false) ||
      (s.description?.toLowerCase().includes(needle) ?? false) ||
      (s.plugin?.toLowerCase().includes(needle) ?? false) ||
      (s.category?.toLowerCase().includes(needle) ?? false),
    );
  }, [filter, result.skills]);

  return (
    <>
      <div className="knowledgeImport__source">
        <span className="knowledgeImport__repo">{result.owner}/{result.repo}</span>
        <span className="knowledgeImport__sha" title={target.sha}>@ {target.sha.slice(0, 7)}</span>
        {result.marketplaceName && (
          <span className="connectorRow__chip">{result.marketplaceName.toUpperCase()}</span>
        )}
        <span className="knowledgeImport__cost">
          {result.skills.length} skills &middot; {formatBytes(result.archiveBytes)} downloaded once
        </span>
      </div>

      <div className="connectorField">
        <input
          ref={filterRef}
          className="connectorField__input"
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          placeholder="Search names and descriptions"
          spellCheck={false}
        />
      </div>

      <div className="knowledgeImport__list">
        {matches.length === 0 && (
          <div className="knowledgeEmpty">
            {result.skills.length === 0
              ? 'No SKILL.md anywhere in this repository, so there is nothing to import.'
              : `Nothing matches "${filter}".`}
          </div>
        )}
        {matches.map((s) => (
          <button
            key={s.subpath}
            type="button"
            className="knowledgeImport__item"
            disabled={!!busy}
            onClick={() => onPick(s)}
          >
            <div className="knowledgeImport__itemHead">
              <span className="knowledgeImport__itemName">{s.id}</span>
              {s.declaredName && <span className="knowledgeRow__alias">{s.declaredName}</span>}
              {!s.frontmatterOk && (
                <span
                  className="connectorRow__chip knowledgeChip--warn"
                  title={s.frontmatterError}
                >
                  BROKEN
                </span>
              )}
              {s.execCount > 0 && (
                <span className="connectorRow__chip">
                  {s.execCount} {s.execCount === 1 ? 'SCRIPT' : 'SCRIPTS'}
                </span>
              )}
              {s.license && (
                <span className="connectorRow__chip" title={s.license}>{licenseChip(s.license)}</span>
              )}
            </div>
            {s.description && (
              <div className="knowledgeImport__itemDesc" title={s.description}>{s.description}</div>
            )}
            <div className="knowledgeImport__itemPath" title={s.subpath}>{shortSubpath(s.subpath)}</div>
          </button>
        ))}
      </div>

      <p className="knowledgeImport__count">
        {filter.trim()
          ? `${matches.length} of ${result.skills.length} skills`
          : `${result.skills.length} skills`}
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------

function PreviewStep({
  preview,
  asId,
  onAsId,
}: {
  preview: SkillImportPreview;
  asId: string;
  onAsId: (v: string) => void;
}) {
  const idProblem = idProblemFor(asId, preview);
  const src = preview.source;

  return (
    <>
      <div className="knowledgeImport__source">
        {src.kind === 'github-subdir' ? (
          <>
            <span className="knowledgeImport__repo">{src.owner}/{src.repo}</span>
            <span className="knowledgeImport__sha" title={src.sha}>@ {(src.sha ?? '').slice(0, 7)}</span>
            {src.subpath && (
              <span className="knowledgeImport__cost" title={src.subpath}>{shortSubpath(src.subpath)}</span>
            )}
          </>
        ) : (
          <span className="knowledgeImport__repo" title={src.localPath}>{src.localPath}</span>
        )}
      </div>

      <div className="connectorField">
        <label className="connectorField__label" htmlFor="knowledge-import-id">Store as</label>
        <input
          id="knowledge-import-id"
          className="connectorField__input connectorField__input--mono"
          value={asId}
          onChange={(e) => onAsId(e.target.value)}
          spellCheck={false}
        />
        <span className="connectorField__help">
          {preview.collides
            ? `A skill called "${preview.id}" already exists, so this one needs another name. `
            : ''}
          The directory name is what Claude types to load the skill.
          {preview.declaredName && (
            <> This one&rsquo;s frontmatter declares <code>{preview.declaredName}</code> instead;
            that stays exactly as written, because rewriting it would mark a pristine import as
            edited on day one.</>
          )}
        </span>
        {idProblem && <p className="gsStep__error">{idProblem}</p>}
      </div>

      {preview.description && (
        <div className="knowledgeImport__desc">{preview.description}</div>
      )}

      <div className="knowledgeImport__facts">
        <span>{preview.fileCount} {preview.fileCount === 1 ? 'file' : 'files'}</span>
        <span>{formatBytes(preview.totalBytes)}</span>
        <span>SKILL.md {formatBytes(preview.skillMdBytes)}</span>
        {preview.description && <span>desc {preview.description.length} chars</span>}
        <span className={preview.execCount > 0 ? 'knowledgeImport__factWarn' : undefined}>
          {preview.execCount} executable{preview.execCount === 1 ? '' : 's'}
        </span>
      </div>

      {preview.execPaths.length > 0 && (
        <div className="knowledgeImport__execList">
          {preview.execPaths.map((p) => <code key={p}>{p}</code>)}
        </div>
      )}

      {preview.strippedSymlinks.length > 0 && (
        <p className="knowledgeImport__stripped">
          {preview.strippedSymlinks.length} symlink
          {preview.strippedSymlinks.length === 1 ? ' was' : 's were'} removed from this skill
          before anything was written:{' '}
          {preview.strippedSymlinks.map((l) => `${l.path} → ${l.target}`).join(', ')}. A skill has
          no legitimate reason to link out of its own folder.
        </p>
      )}

      {preview.problems.map((p) => (
        <p key={p.message} className={p.level === 'error' ? 'gsStep__error' : 'knowledgeImport__warn'}>
          {p.message}
        </p>
      ))}

      {/* The design's words, unsoftened. Everything in it is literally true of
          this app: `allowedTools` is auto-approve, there is no `canUseTool`
          handler anywhere, and Bash is on the list. */}
      <p className="knowledgeImport__disclosure">
        Bash is auto-approved in Acabox with no permission handler. An imported skill can
        instruct Claude to do anything you could do at a terminal, and a bundled script runs
        with your full privileges the moment Claude invokes it. Importing is a trust decision
        equivalent to <code>curl … | sh</code> from that repository. The pinned commit makes it
        reproducible and auditable. It does not make it safe.
      </p>

      <div className="connectorField">
        <label className="connectorField__label">SKILL.md</label>
        {/* Unrendered on purpose: this is the instruction text the model will
            follow, and markdown formatting would present it as documentation. */}
        <pre className="knowledgeImport__body">{preview.skillMd}</pre>
      </div>
    </>
  );
}
