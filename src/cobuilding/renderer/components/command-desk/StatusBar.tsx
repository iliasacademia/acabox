import React, { useState, useEffect } from 'react';

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
export function StatusBar({ firstRun }: { firstRun?: boolean } = {}) {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [agentCount, setAgentCount] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = () => {
      window.systemStatsAPI
        .get()
        .then((s) => { if (alive) setStats(s); })
        .catch(() => {});
      window.sessionsAPI
        .getRunningIds()
        .then((ids) => { if (alive) setAgentCount(ids.length); })
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
      {!firstRun && agentCount != null && <span>AGENTS {agentCount} LIVE</span>}
      <span className="cdStatusBar__spacer" />
      {firstRun ? <span>FIRST RUN</span> : stats && <span>UP {formatUptime(stats.appUptimeSec)}</span>}
    </div>
  );
}
