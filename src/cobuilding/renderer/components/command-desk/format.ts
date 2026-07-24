/** Formatting helpers for the Command Desk's mono metadata (timestamps, sizes). */

/** Compact relative time for mono labels: "NOW", "12M", "3H", "2D". */
export function relTimeShort(when: string | number): string {
  const t = typeof when === 'number' ? when : Date.parse(when);
  if (Number.isNaN(t)) return '—';
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return 'NOW';
  if (mins < 60) return `${mins}M`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}H`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}D`;
  return `${Math.floor(days / 30)}MO`;
}

/** File sizes the way the design shows them: "14K", "2M", "1.1G". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)}K`;
  const mb = kb / 1024;
  if (mb < 1024) return mb < 10 ? `${mb.toFixed(1)}M` : `${Math.round(mb)}M`;
  const gb = mb / 1024;
  return gb < 10 ? `${gb.toFixed(1)}G` : `${Math.round(gb)}G`;
}

/** Header date, e.g. "WED JUL 23 · 09:41". */
export function headerDate(now: Date): string {
  const weekday = now.toLocaleDateString('en-US', { weekday: 'short' });
  const month = now.toLocaleDateString('en-US', { month: 'short' });
  const day = now.getDate();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${weekday} ${month} ${day} · ${hh}:${mm}`.toUpperCase();
}
