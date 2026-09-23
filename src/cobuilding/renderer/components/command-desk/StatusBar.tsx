import React, { useState, useEffect } from 'react';
import { useToolStatuses } from '../../toolStatusStore';
import { useServerCounts } from '../../mcpServerStore';
import { useActiveChatCount } from '../../chatActivityStore';

const POLL_MS = 5_000;

/**
 * "3.1/8.0G" (shared unit; switches to T above 1000G). RAM is sized in
 * binary units, disks in decimal — matching Finder/Disk Utility.
 */
function sizePair(usedBytes: number, totalBytes: number, base: 'binary' | 'decimal'): string {
  const G = base === 'decimal' ? 1e9 : 2 ** 30;
  const T = base === 'decimal' ? 1e12 : 2 ** 40;
  if (totalBytes >= 1000 * G) {
    return `${(usedBytes / T).toFixed(1)}/${(totalBytes / T).toFixed(1)}T`;
  }
  const fmt = (n: number) => {
    const g = n / G;
    return g >= 100 ? String(Math.round(g)) : g.toFixed(1);
  };
  return `${fmt(usedBytes)}/${fmt(totalBytes)}G`;
}

function formatUptime(sec: number): string {
  const days = Math.floor(sec / 86_400);
  const hours = Math.floor((sec % 86_400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  if (days > 0) return `${days}D ${String(hours).padStart(2, '0')}H`;
  if (hours > 0) return `${hours}H ${String(mins).padStart(2, '0')}M`;
  return `${mins}M`;
}

/**
 * 26px bottom status bar — live host stats via `stats:get` plus the count of
 * currently-running agent sessions. Segments render only once real data is in;
 * nothing here is mocked.
 */
export function StatusBar() {
  const [stats, setStats] = useState<SystemStats | null>(null);
  // Chats with a turn in flight, pushed from main. This used to poll a
  // predicate that asked whether an agent session OBJECT existed, which stays
  // true for up to a minute after a turn while the renderer holds its
  // subscription — so an idle chat counted as a live agent.
  const agentCount = useActiveChatCount();
  const toolStatuses = useToolStatuses();
  const serverCounts = useServerCounts();
  const workingToolNames = [...toolStatuses.entries()]
    .filter(([, s]) => s.kind === 'working')
    .map(([dirName]) => dirName);
  const workingTools = workingToolNames.length;

  useEffect(() => {
    let alive = true;
    const poll = () => {
      window.systemStatsAPI
        .get()
        .then((s) => { if (alive) setStats(s); })
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  return (
    <div className="cdStatusBar">
      {stats && (
        <>
          <span>CPU {stats.cpuPercent}%</span>
          <span>MEM {sizePair(stats.memUsedBytes, stats.memTotalBytes, 'binary')}</span>
          {stats.diskUsedBytes != null && stats.diskTotalBytes != null && (
            <span>DISK {sizePair(stats.diskUsedBytes, stats.diskTotalBytes, 'decimal')}</span>
          )}
        </>
      )}
      {agentCount != null && <span>AGENTS {agentCount} LIVE</span>}
      {/* Tools can be working with no viewer open — this is the only place
          that is visible from every screen. Hidden when nothing is running. */}
      {workingTools > 0 && (
        <span title={workingToolNames.join(', ')}>
          <span className="cdDot cdDot--busy cdDot--pulse" style={{ display: 'inline-block', marginRight: 6 }} />
          {workingTools} TOOL{workingTools === 1 ? '' : 'S'} WORKING
        </span>
      )}
      {/* A server count is not news; a failing one is — no always-on count,
          matching the module comment above: segments render only on real
          data (docs/design/mcp-hosting.md, Increment 3). */}
      {serverCounts.down > 0 && (
        <span>
          <span className="cdDot cdDot--busy" style={{ background: 'var(--cd-error, #b60000)', display: 'inline-block', marginRight: 6 }} />
          {serverCounts.down} SERVER{serverCounts.down === 1 ? '' : 'S'} DOWN
        </span>
      )}
      {/* The one place a TRANSIENT count is itself news (R6,
          docs/design/mcp-hosting.md Increment 4): while a hosted server is
          still completing its handshake, its tools genuinely don't exist yet
          — a user who asks for them in that window deserves an explanation,
          not a silent "Claude can't do that" with no reason given. Gone the
          moment the last starting server lands (ready or failed), same as
          every other segment on this line. */}
      {serverCounts.starting > 0 && (
        <span>
          <span className="cdDot cdDot--busy cdDot--pulse" style={{ background: 'var(--cd-busy, #fecf4c)', display: 'inline-block', marginRight: 6 }} />
          {serverCounts.starting} SERVER{serverCounts.starting === 1 ? '' : 'S'} STARTING
        </span>
      )}
      <span className="cdStatusBar__spacer" />
      {stats && <span>UP {formatUptime(stats.appUptimeSec)}</span>}
    </div>
  );
}
