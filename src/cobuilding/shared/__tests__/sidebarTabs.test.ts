import * as fs from 'fs';
import * as path from 'path';
import { SIDEBAR_TAB_IDS } from '../types';

/**
 * The deep-link tab list used to exist in three hand-maintained copies, and the
 * third — the zod enum in `agent-server/index.ts` — **silently strips** a value
 * it does not recognise instead of erroring. So adding a tab to the other two
 * produced a notification that navigated nowhere, with nothing in any log.
 *
 * These tests guard the unification rather than the symptom: the value list is
 * asserted once, and the source is scanned so a fourth copy cannot quietly
 * appear. A test that only checked the union's contents would pass happily
 * while someone reintroduced a literal next door.
 */

const SRC = path.resolve(__dirname, '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '__tests__') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('SIDEBAR_TAB_IDS', () => {
  it('covers every tab the shell can navigate to', () => {
    // Kept in sync by hand with RailTab / SidebarTab, which are renderer-side
    // and cannot be imported here without dragging the renderer into the
    // agent-server bundle. If you add a tab, this list is the reason the
    // notification deep-link keeps working.
    expect([...SIDEBAR_TAB_IDS].sort()).toEqual([
      'activity', 'chats', 'debug', 'files', 'home', 'knowledge', 'servers', 'settings', 'tools',
    ]);
  });

  it('includes the tabs all three old copies were missing', () => {
    expect(SIDEBAR_TAB_IDS).toContain('knowledge');
    expect(SIDEBAR_TAB_IDS).toContain('activity');
  });

  it('has no duplicates', () => {
    expect(new Set(SIDEBAR_TAB_IDS).size).toBe(SIDEBAR_TAB_IDS.length);
  });
});

describe('no second copy of the tab list', () => {
  const files = walk(SRC);

  it('finds every sidebar-tab zod enum pointing at the shared constant', () => {
    // Any z.enum listing sidebar tabs must be `z.enum(SIDEBAR_TAB_IDS)`.
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf-8');
      // A literal enum that mentions both 'home' and 'settings' is a tab list.
      const re = /z\.enum\(\s*\[[^\]]*['"]home['"][^\]]*['"]settings['"][^\]]*\]\s*\)/g;
      if (re.test(src)) offenders.push(path.relative(SRC, f));
    }
    expect(offenders).toEqual([]);
  });

  it('still has the two zod sites, so this test cannot pass vacuously', () => {
    const users = files.filter((f) =>
      /z\.enum\(\s*SIDEBAR_TAB_IDS\s*\)/.test(fs.readFileSync(f, 'utf-8')));
    expect(users.map((f) => path.relative(SRC, f)).sort()).toEqual([
      'agent-server/index.ts',
      'main/mcpServers/notificationMcpServer.ts',
    ]);
  });
});
