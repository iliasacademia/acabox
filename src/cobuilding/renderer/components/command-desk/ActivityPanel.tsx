import React, { useCallback, useEffect, useState } from 'react';
import { useComposerRuntime } from '@assistant-ui/react';
import { MSymbol } from './MSymbol';
import { resolveToolIcon } from './toolIcon';

/**
 * "What is my computer doing for me, and what happened while I wasn't looking?"
 *
 * Everything else that reports tool state — the chips on home cards, the rail
 * dots, the status-bar count — is a pointer at this. Chips are glanceable but
 * can't carry actions or history; this can. Three sections, in the order a
 * returning user cares about them:
 *
 *   Needs attention — work that stopped without being seen, and tools that no
 *                     longer build. The reason to come here.
 *   Running now     — with a way to stop it, which exists nowhere else.
 *   Recently done   — so "did that finish?" has an answer.
 *
 * A section with nothing in it is not rendered: an empty panel is the correct
 * answer to "is anything happening?" and beats three empty headings.
 */

interface Props {
  apps: MiniAppEntry[];
  onOpenTool: (dirName: string) => void;
  /** Switch the shell to the chat view; the prompt is composed here. */
  onSwitchToChat: () => void;
}

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

function elapsed(fromMs: number, toMs: number): string {
  const secs = Math.max(0, Math.round((toMs - fromMs) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** "just now" / "4m ago" / "3h ago" — reads as prose, unlike the mono chips. */
function agoText(atMs: number, nowMs: number): string {
  const secs = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const KIND_LABEL: Record<string, string> = {
  command: 'Command',
  kernel: 'Code',
  claude: 'Claude',
  'agent-tool': 'Agent',
};

/** How a finished job should read to someone who wasn't watching it. */
function outcomeText(job: ToolJob): { text: string; tone: 'good' | 'bad' | 'unknown' } {
  switch (job.status) {
    case 'done': return { text: 'Finished', tone: 'good' };
    case 'failed': return { text: 'Failed', tone: 'bad' };
    case 'cancelled': return { text: 'Stopped by you', tone: 'unknown' };
    case 'interrupted': return { text: 'Interrupted when Acabox closed', tone: 'bad' };
    // We were not its parent, so there is no exit code to report. Saying
    // "finished" here would be inventing an outcome we never observed.
    case 'finishedWhileAway': return { text: 'Ran while Acabox was closed — result unknown', tone: 'unknown' };
    default: return { text: job.status, tone: 'unknown' };
  }
}

export function ActivityPanel({ apps, onOpenTool, onSwitchToChat }: Props) {
  const composerRuntime = useComposerRuntime();
  const [jobs, setJobs] = useState<ToolJob[]>([]);
  const [broken, setBroken] = useState<BuildHealth[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    window.jobsAPI.list().then(setJobs).catch(() => {});
    window.buildHealthAPI.list().then(setBroken).catch(() => {});
    const offJobs = window.jobsAPI.onChanged(setJobs);
    const offHealth = window.buildHealthAPI.onChanged(setBroken);
    return () => { offJobs(); offHealth(); };
  }, []);

  // Only to keep the running-for durations ticking.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const nameOf = useCallback(
    (dirName: string) => apps.find((a) => a.dirName === dirName)?.name ?? dirName,
    [apps],
  );
  const iconOf = useCallback(
    (dirName: string) => resolveToolIcon(apps.find((a) => a.dirName === dirName)?.icon ?? null),
    [apps],
  );

  const running = jobs.filter((j) => j.status === 'running');
  const unseen = jobs.filter((j) => j.status === 'interrupted' || j.status === 'finishedWhileAway');
  const recent = jobs
    .filter((j) => j.status !== 'running' && !unseen.includes(j) && (j.endedAt ?? 0) > now - RECENT_WINDOW_MS)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, 12);

  const stop = useCallback(async (job: ToolJob) => {
    const mins = Math.round((Date.now() - job.startedAt) / 60_000);
    if (mins >= 1) {
      const ok = window.confirm(
        `Stop "${nameOf(job.dirName)}"?\n\nIt has been working for ${mins} minute${mins === 1 ? '' : 's'}. ` +
        'Anything it has half-written will be left as it is.',
      );
      if (!ok) return;
    }
    await window.jobsAPI.cancel(job.id);
  }, [nameOf]);

  /**
   * The point of surfacing a broken tool here is that the fix is one click
   * away, not that the user learns it is broken and must go hunting. The build
   * error goes in verbatim — it is the only thing that makes the request
   * actionable for the agent.
   */
  const askClaudeToFix = useCallback((b: BuildHealth) => {
    onSwitchToChat();
    composerRuntime.setText(
      `The mini-app "${nameOf(b.dirName)}" (\`.applications/${b.dirName}\`) fails to build. ` +
      `Please read its source, fix the problem, and rebuild it.\n\n` +
      `Build output:\n\`\`\`\n${(b.error ?? '').slice(0, 4000)}\n\`\`\``,
    );
    composerRuntime.send();
  }, [composerRuntime, nameOf, onSwitchToChat]);

  const nothingAtAll = running.length === 0 && unseen.length === 0 && recent.length === 0 && broken.length === 0;

  return (
    <div className="cdActivity">
      <div className="cdActivity__header">
        <h1 className="cdHome__title">Activity</h1>
      </div>

      {nothingAtAll && (
        <div className="cdActivity__empty">
          <MSymbol name="check_circle" size={22} />
          <span>Nothing running, and nothing waiting on you.</span>
        </div>
      )}

      {(unseen.length > 0 || broken.length > 0) && (
        <section className="cdActivity__section">
          <div className="cdSectionLabel">Needs attention</div>

          {broken.map((b) => {
            const Icon = iconOf(b.dirName);
            return (
              <div key={`broken-${b.dirName}`} className="cdActivityRow cdActivityRow--bad">
                <Icon className="cdActivityRow__icon" style={{ width: 16, height: 16 }} />
                <div className="cdActivityRow__main">
                  <div className="cdActivityRow__title">{nameOf(b.dirName)}</div>
                  <div className="cdActivityRow__sub">
                    This tool doesn’t build, so it can’t run. Last tried {agoText(b.at, now)}.
                  </div>
                </div>
                <button className="cdBtnXs" onClick={() => askClaudeToFix(b)}>
                  Ask Claude to fix it
                </button>
              </div>
            );
          })}

          {unseen.map((job) => {
            const Icon = iconOf(job.dirName);
            const outcome = outcomeText(job);
            return (
              <div key={job.id} className="cdActivityRow">
                <Icon className="cdActivityRow__icon" style={{ width: 16, height: 16 }} />
                <div className="cdActivityRow__main">
                  <div className="cdActivityRow__title">{nameOf(job.dirName)}</div>
                  <div className="cdActivityRow__sub">
                    {KIND_LABEL[job.kind] ?? job.kind} · {outcome.text}
                  </div>
                </div>
                <button className="cdBtnXs" onClick={() => onOpenTool(job.dirName)}>Open</button>
              </div>
            );
          })}
        </section>
      )}

      {running.length > 0 && (
        <section className="cdActivity__section">
          <div className="cdSectionLabel">Running now</div>
          {running.map((job) => {
            const Icon = iconOf(job.dirName);
            return (
              <div key={job.id} className="cdActivityRow">
                <span className="cdDot cdDot--busy cdDot--pulse" />
                <Icon className="cdActivityRow__icon" style={{ width: 16, height: 16 }} />
                <div className="cdActivityRow__main">
                  <div className="cdActivityRow__title">{nameOf(job.dirName)}</div>
                  <div className="cdActivityRow__sub">
                    {KIND_LABEL[job.kind] ?? job.kind} · {job.label} · running {elapsed(job.startedAt, now)}
                    {job.adopted && ' · started before Acabox was reopened'}
                  </div>
                </div>
                <button className="cdBtnXs" onClick={() => onOpenTool(job.dirName)}>Open</button>
                <button className="cdBtnXs" onClick={() => stop(job)}>Stop</button>
              </div>
            );
          })}
        </section>
      )}

      {recent.length > 0 && (
        <section className="cdActivity__section">
          <div className="cdSectionLabel">Recently finished</div>
          {recent.map((job) => {
            const Icon = iconOf(job.dirName);
            const outcome = outcomeText(job);
            return (
              <div key={job.id} className={`cdActivityRow${outcome.tone === 'bad' ? ' cdActivityRow--bad' : ''}`}>
                <Icon className="cdActivityRow__icon" style={{ width: 16, height: 16 }} />
                <div className="cdActivityRow__main">
                  <div className="cdActivityRow__title">{nameOf(job.dirName)}</div>
                  <div className="cdActivityRow__sub">
                    {outcome.text} · took {elapsed(job.startedAt, job.endedAt ?? now)} ·{' '}
                    {agoText(job.endedAt ?? now, now)}
                  </div>
                </div>
                <button className="cdBtnXs" onClick={() => onOpenTool(job.dirName)}>Open</button>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
