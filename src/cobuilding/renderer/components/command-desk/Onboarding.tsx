import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MSymbol } from './MSymbol';
import { AcaboxMark } from './AcaboxMark';
import { MEMORY_PATH_ABOUT_YOU, MAX_WORKSPACE_DIRECTORIES } from '../../../shared/paths';
import type { FC } from 'react';

/**
 * First-run onboarding (Phase B): five steps swapping in place inside the
 * chrome-bar/status-bar frame — no rail. Voice: terse, playful-hacker.
 *
 * 1 Welcome · 2 API key · 3 Workspace directories · 4 Scanning · 5 Review
 */

type Step = 1 | 2 | 3 | 4 | 5;

interface OnboardingProps {
  /** 1 = fresh install (no key); 3 = key exists, workspace missing. */
  initialStep: 1 | 3;
  onFinished: () => void;
}

interface DirDraft {
  path: string;
  readOnly: boolean;
  /** DB row id when the directory already exists in the active workspace. */
  id?: string;
}

const HOME_RE = /^\/Users\/[^/]+/;
function displayPath(p: string): string {
  return p.replace(HOME_RE, '~');
}

/** Shared step scaffold: progress row (+ optional back), title, sub. */
const StepScaffold: FC<{
  step: Step;
  onBack?: () => void;
  title: React.ReactNode;
  titleHero?: boolean;
  sub: React.ReactNode;
  children?: React.ReactNode;
}> = ({ step, onBack, title, titleHero, sub, children }) => (
  <div className="cdOnb">
    <div className="cdOnb__col">
      <div className="cdOnb__progress">
        {onBack && (
          <button type="button" className="cdIconBtn cdOnb__back" title="Back" onClick={onBack}>
            <MSymbol name="arrow_back" size={18} />
          </button>
        )}
        <span className="cdOnb__progressLabel">SETUP</span>
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={`cdOnb__seg${i <= step ? ' cdOnb__seg--done' : ''}`} />
        ))}
        <span className="cdOnb__progressSpacer" />
        <span className="cdOnb__progressCount">{`0${step}/05`}</span>
      </div>
      {step === 1 && (
        <div className="cdOnb__logo">
          <AcaboxMark size={48} variant="master" />
        </div>
      )}
      <div className={`cdOnb__title${titleHero ? ' cdOnb__title--hero' : ''}`}>{title}</div>
      <div className={`cdOnb__sub${titleHero ? ' cdOnb__sub--hero' : ''}`}>{sub}</div>
      {children}
    </div>
  </div>
);

/** ⏎ triggers the step's primary action (when enabled). */
function useEnterKey(handler: (() => void) | null) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (ref.current) {
        e.preventDefault();
        ref.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export const Onboarding: FC<OnboardingProps> = ({ initialStep, onFinished }) => {
  const [step, setStep] = useState<Step>(initialStep);

  // ── Step 2 — API key ──
  const [apiKey, setApiKey] = useState('');
  const [keyStatus, setKeyStatus] = useState<'idle' | 'checking' | 'rejected'>('idle');
  const [keyError, setKeyError] = useState<string | null>(null);

  const connectKey = useCallback(async () => {
    const key = apiKey.trim();
    if (!key || keyStatus === 'checking') return;
    if (!key.startsWith('sk-ant-api')) {
      setKeyStatus('rejected');
      setKeyError(
        key.startsWith('sk-ant-sid')
          ? "REJECTED — THAT'S A SESSION ID, NOT AN API KEY. API KEYS START WITH SK-ANT-API."
          : 'REJECTED — API KEYS START WITH SK-ANT-API.',
      );
      return;
    }
    setKeyStatus('checking');
    setKeyError(null);
    try {
      const res = await window.authAPI.setApiKey(key);
      if (res.success) {
        setKeyStatus('idle');
        setStep(3);
      } else {
        setKeyStatus('rejected');
        setKeyError((res.error || 'Could not save the API key.').toUpperCase());
      }
    } catch (err) {
      setKeyStatus('rejected');
      setKeyError(String(err instanceof Error ? err.message : err).toUpperCase());
    }
  }, [apiKey, keyStatus]);

  // ── Step 3 — Workspace directories ──
  const [dirs, setDirs] = useState<DirDraft[]>([]);
  const [dirNote, setDirNote] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  // Prefill from the active workspace (restart-onboarding / "Edit folders").
  useEffect(() => {
    window.workspacesAPI
      .listDirectories()
      .then((rows) => {
        if (rows.length > 0) {
          setDirs(rows.map((d) => ({ path: d.directory_path, readOnly: d.read_only, id: d.id })));
        }
      })
      .catch(() => {});
  }, []);

  const addFolder = useCallback(async () => {
    const selected = await window.workspacesAPI.selectDirectory();
    if (!selected) return;
    setDirs((prev) => {
      if (prev.length >= MAX_WORKSPACE_DIRECTORIES) {
        setDirNote(`MAX ${MAX_WORKSPACE_DIRECTORIES} FOLDERS`);
        return prev;
      }
      for (const d of prev) {
        if (d.path === selected) {
          setDirNote('ALREADY ADDED');
          return prev;
        }
        if (selected.startsWith(d.path + '/')) {
          setDirNote(`NESTED INSIDE ${displayPath(d.path)} — ALREADY COVERED`);
          return prev;
        }
        if (d.path.startsWith(selected + '/')) {
          setDirNote(`CONTAINS ${displayPath(d.path)} — REMOVE THAT ONE FIRST`);
          return prev;
        }
      }
      setDirNote(null);
      return [...prev, { path: selected, readOnly: true }];
    });
  }, []);

  /** Creates the workspace (or diffs directories into the existing one). */
  const applyDirectories = useCallback(async (): Promise<boolean> => {
    if (dirs.length === 0 || applying) return false;
    setApplying(true);
    setDirNote(null);
    try {
      const active = await window.workspacesAPI.getActive();
      if (!active) {
        const name = dirs[0].path.split('/').filter(Boolean).pop() || 'My Workspace';
        await window.workspacesAPI.create({ name, directoryPaths: dirs.map((d) => d.path) });
      } else {
        const existing = await window.workspacesAPI.listDirectories();
        const keptPaths = new Set(dirs.map((d) => d.path));
        for (const row of existing) {
          if (!keptPaths.has(row.directory_path)) {
            await window.workspacesAPI.removeDirectory(row.id);
          }
        }
        const existingPaths = new Set(existing.map((r) => r.directory_path));
        for (const d of dirs) {
          if (!existingPaths.has(d.path)) {
            await window.workspacesAPI.addDirectory(d.path);
          }
        }
      }
      // Apply read-only flags to the final rows.
      const rows = await window.workspacesAPI.listDirectories();
      const byPath = new Map(dirs.map((d) => [d.path, d.readOnly]));
      for (const row of rows) {
        const wanted = byPath.get(row.directory_path);
        if (wanted !== undefined && wanted !== row.read_only) {
          await window.workspacesAPI.updateDirectoryPermission(row.id, wanted);
        }
      }
      return true;
    } catch (err) {
      setDirNote(String(err instanceof Error ? err.message : err).toUpperCase());
      return false;
    } finally {
      setApplying(false);
    }
  }, [dirs, applying]);

  const continueToScan = useCallback(async () => {
    if (await applyDirectories()) setStep(4);
  }, [applyDirectories]);

  const skipScan = useCallback(async () => {
    if (await applyDirectories()) onFinished();
  }, [applyDirectories, onFinished]);

  // ── Step 4 — Scanning ──
  const [scanLabel, setScanLabel] = useState<string | null>(null);
  const [scanFile, setScanFile] = useState<string | null>(null);
  const [scanCount, setScanCount] = useState(0);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanNonce, setScanNonce] = useState(0);
  const scanTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (step !== 4) return;
    setScanLabel(null);
    setScanFile(null);
    setScanCount(0);
    setScanProgress(0);
    setScanError(null);

    // Asymptotic activity bar — the walk has no known denominator.
    const startedAt = Date.now();
    scanTimerRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const p = 1 - Math.exp(-elapsed / 45_000);
      setScanProgress(Math.min(90, Math.round(p * 90)));
    }, 500);

    const unsubscribe = window.scannerAPI.onEvent((event: ScannerEvent) => {
      if (event.type === 'progress') {
        setScanLabel(event.text);
      } else if (event.type === 'file_activity') {
        setScanFile(event.path);
        setScanCount((n) => n + 1);
      } else if (event.type === 'complete') {
        setScanProgress(100);
        if (scanTimerRef.current) clearInterval(scanTimerRef.current);
        setTimeout(() => setStep(5), 600);
      } else if (event.type === 'error') {
        setScanError(event.error);
        if (scanTimerRef.current) clearInterval(scanTimerRef.current);
      }
    });

    window.scannerAPI.start().catch((err) => {
      setScanError(err instanceof Error ? err.message : String(err));
      if (scanTimerRef.current) clearInterval(scanTimerRef.current);
    });

    return () => {
      unsubscribe();
      if (scanTimerRef.current) clearInterval(scanTimerRef.current);
    };
  }, [step, scanNonce]);

  // ── Step 5 — Review ──
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [profileLine, setProfileLine] = useState<string | null>(null);

  useEffect(() => {
    if (step !== 5) return;
    window.scannedFilesAPI
      .getAll()
      .then((rows) => {
        const c: Record<string, number> = { manuscript: 0, grant: 0, reference: 0, presentation: 0 };
        for (const row of rows) c[row.file_type] = (c[row.file_type] ?? 0) + 1;
        setCounts(c);
      })
      .catch(() => setCounts({ manuscript: 0, grant: 0, reference: 0, presentation: 0 }));
    window.academiaFileAPI
      .read(MEMORY_PATH_ABOUT_YOU)
      .then(({ content }) => {
        const line = content.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find((l) => l.length > 0);
        setProfileLine(line ?? null);
      })
      .catch(() => setProfileLine(null));
  }, [step]);

  // ⏎ = primary action.
  useEnterKey(
    step === 1 ? () => setStep(2)
      : step === 2 ? (apiKey.trim() && keyStatus !== 'checking' ? connectKey : null)
      : step === 3 ? (dirs.length > 0 && !applying ? continueToScan : null)
      : step === 5 ? onFinished
      : null,
  );

  const version = process.env.APP_VERSION || '0.0.0';

  /* ── Step 1 — Welcome ── */
  if (step === 1) {
    return (
      <StepScaffold
        step={1}
        titleHero
        title={<>Build tools. Break things.<br />Locally.</>}
        sub="ACABOX is a tool-building copilot for scientists. Describe what you need — it writes it, runs it, and hosts it on this machine. Nothing leaves your disk."
      >
        <div className="cdOnb__features">
          <div className="cdOnb__feature"><MSymbol name="bolt" size={17} />Chats that end in working tools</div>
          <div className="cdOnb__feature"><MSymbol name="hard_drive" size={17} />Local-first — your files are never synced anywhere</div>
          <div className="cdOnb__feature"><MSymbol name="key" size={17} />Your own API key — talks straight to Anthropic</div>
        </div>
        <div className="cdOnb__actions cdOnb__actions--hero">
          <button type="button" className="cdBtnPrimary" onClick={() => setStep(2)}>
            Get started
            <MSymbol name="arrow_forward" size={16} />
          </button>
        </div>
        <span className="cdOnb__footnote">V{version} · NO ACCOUNT · NO TELEMETRY</span>
      </StepScaffold>
    );
  }

  /* ── Step 2 — API key ── */
  if (step === 2) {
    const rejected = keyStatus === 'rejected';
    return (
      <StepScaffold
        step={2}
        onBack={() => setStep(1)}
        title="Plug in a brain."
        sub="ACABOX drives Claude with your key. It stays on this machine and talks straight to Anthropic — no middleman, no proxy."
      >
        <div className="cdOnb__fieldLabel">ANTHROPIC API KEY</div>
        <div className={`cdOnb__inputWrap${rejected ? ' cdOnb__inputWrap--error' : ''}`}>
          <MSymbol name="key" size={16} />
          <input
            className="cdOnb__input"
            type="password"
            value={apiKey}
            placeholder="sk-ant-api03-…"
            autoFocus
            onChange={(e) => {
              setApiKey(e.target.value);
              if (keyStatus === 'rejected') { setKeyStatus('idle'); setKeyError(null); }
            }}
            aria-label="Anthropic API key"
          />
          {rejected && <MSymbol name="error" size={16} />}
        </div>
        {rejected && keyError && <div className="cdOnb__errorStrip">{keyError}</div>}
        <div className="cdOnb__helper">
          {rejected ? (
            <>Grab the right one at <button type="button" className="cdTextLink" onClick={() => (window as any).electronAPI.invoke('shell:openExternal', 'https://console.anthropic.com/settings/keys')}>console.anthropic.com → API keys</button>.</>
          ) : (
            <>No key yet? Mint one at <button type="button" className="cdTextLink" onClick={() => (window as any).electronAPI.invoke('shell:openExternal', 'https://console.anthropic.com/settings/keys')}>console.anthropic.com</button> — takes a minute.</>
          )}
        </div>
        <div className="cdOnb__actions">
          <button
            type="button"
            className="cdBtnPrimary"
            disabled={!apiKey.trim() || keyStatus === 'checking'}
            onClick={connectKey}
          >
            {keyStatus === 'checking' ? 'CHECKING…' : rejected ? 'Retry' : 'Connect'}
          </button>
        </div>
        <span className="cdOnb__footnote">STORED ON THIS MACHINE · SENT ONLY TO API.ANTHROPIC.COM</span>
      </StepScaffold>
    );
  }

  /* ── Step 3 — Workspace directories ── */
  if (step === 3) {
    return (
      <StepScaffold
        step={3}
        onBack={initialStep === 1 ? () => setStep(2) : undefined}
        title="Point it at the science."
        sub="Share the folders where your research lives. Read-only means it reads, never writes."
      >
        {dirs.length > 0 && (
          <div className="cdDirCard">
            {dirs.map((d) => (
              <div key={d.path} className="cdDirRow">
                <MSymbol name="folder" size={17} />
                <span className="cdDirRow__path">{displayPath(d.path)}</span>
                <span className="cdDirRow__spacer" />
                <span className="cdDirRow__roLabel">READ-ONLY</span>
                <button
                  type="button"
                  className={`cdToggle${d.readOnly ? ' cdToggle--on' : ''}`}
                  role="switch"
                  aria-checked={d.readOnly}
                  aria-label={`Read-only for ${displayPath(d.path)}`}
                  onClick={() =>
                    setDirs((prev) => prev.map((x) => (x.path === d.path ? { ...x, readOnly: !x.readOnly } : x)))
                  }
                >
                  <span className="cdToggle__knob" />
                </button>
                <button
                  type="button"
                  className="cdIconBtn cdIconBtn--26 cdIconBtn--danger"
                  title="Remove"
                  onClick={() => setDirs((prev) => prev.filter((x) => x.path !== d.path))}
                >
                  <MSymbol name="close" size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
        <button type="button" className="cdAddRow" style={dirs.length === 0 ? { marginTop: 24 } : undefined} onClick={addFolder}>
          <MSymbol name="add" size={16} />
          Add a folder
        </button>
        {dirNote && <div className="cdOnb__inlineNote">{dirNote}</div>}
        <div className="cdOnb__actions">
          <button
            type="button"
            className="cdBtnPrimary"
            disabled={dirs.length === 0 || applying}
            onClick={continueToScan}
          >
            {applying ? 'SETTING UP…' : 'Continue — scan these'}
          </button>
          {dirs.length > 0 && (
            <button type="button" className="cdTextLink" disabled={applying} onClick={skipScan}>
              Skip for now
            </button>
          )}
        </div>
        <span className="cdOnb__footnote">CHANGE ANYTIME — SETTINGS → WORKSPACE</span>
      </StepScaffold>
    );
  }

  /* ── Step 4 — Scanning ── */
  if (step === 4) {
    const firstDir = dirs[0] ? displayPath(dirs[0].path) : '';
    return (
      <StepScaffold
        step={4}
        title="Reading the room."
        sub="Building your research profile — what you study, write, and cite — so new chats start smart. Local only."
      >
        <div className="cdScanStatus">
          <span className={`cdDot ${scanError ? 'cdDot--error' : 'cdDot--busy cdDot--pulse'}`} />
          <span className="cdScanStatus__label">
            {scanError ? 'SCAN FAILED' : scanLabel || `SCANNING ${firstDir}`}
          </span>
          <span className="cdScanStatus__spacer" />
          {scanCount > 0 && <span className="cdScanStatus__count">{scanCount.toLocaleString()} FILES</span>}
        </div>
        <div className="cdOnb__progressBar">
          <div className="cdOnb__progressFill" style={{ width: `${scanProgress}%` }} />
        </div>
        {scanFile && !scanError && <div className="cdScanFile">▸ {scanFile}</div>}
        {scanError && <div className="cdOnb__errorStrip">{scanError.toUpperCase()}</div>}
        <div className="cdOnb__actions" style={{ marginTop: 32 }}>
          {scanError ? (
            <>
              <button type="button" className="cdBtnPrimary" onClick={() => setScanNonce((n) => n + 1)}>Retry</button>
              <button type="button" className="cdTextLink" onClick={onFinished}>Skip — finish setup now</button>
            </>
          ) : (
            <button type="button" className="cdTextLink" onClick={onFinished}>Skip — finish setup now</button>
          )}
        </div>
        <span className="cdOnb__footnote">SKIPPING KEEPS THE SCAN RUNNING IN THE BACKGROUND</span>
      </StepScaffold>
    );
  }

  /* ── Step 5 — Scan review ── */
  const cards: { label: string; key: string }[] = [
    { label: 'MANUSCRIPTS', key: 'manuscript' },
    { label: 'GRANTS', key: 'grant' },
    { label: 'REFERENCES', key: 'reference' },
    { label: 'PRESENTATIONS', key: 'presentation' },
  ];
  return (
    <StepScaffold
      step={5}
      title="Here's what it found."
      sub={profileLine ?? 'Your research profile is built. Sound right?'}
    >
      <div className="cdOnbCards">
        {cards.map((c) => (
          <div key={c.key} className="cdOnbCard">
            <span className="cdOnbCard__label">{c.label}</span>
            <span className="cdOnbCard__count">{counts ? (counts[c.key] ?? 0).toLocaleString() : '—'}</span>
          </div>
        ))}
      </div>
      <div className="cdOnb__actions">
        <button type="button" className="cdBtnPrimary" onClick={onFinished}>
          Looks right — finish
          <MSymbol name="arrow_forward" size={16} />
        </button>
        <button type="button" className="cdTextLink" onClick={() => { setScanNonce((n) => n + 1); setStep(4); }}>
          Rescan
        </button>
        <button type="button" className="cdTextLink" onClick={() => setStep(3)}>
          Edit folders
        </button>
      </div>
      <span className="cdOnb__footnote">CHANGE FOLDERS ANYTIME — SETTINGS → WORKSPACE</span>
    </StepScaffold>
  );
};
