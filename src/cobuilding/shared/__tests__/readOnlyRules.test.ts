import { buildReadOnlyDenyRules, denyRuleForPath, mountNames } from '../readOnlyRules';

const WS = '/Users/x/Library/Application Support/acabox/production/cobuilding-workspace';

describe('buildReadOnlyDenyRules', () => {
  it('emits nothing when no folder is locked', () => {
    expect(buildReadOnlyDenyRules(WS, [{ directory_path: '/Users/x/Data', read_only: false }])).toEqual([]);
    expect(buildReadOnlyDenyRules(WS, [])).toEqual([]);
  });

  it('covers the real path and the workspace symlink for Edit, Write and NotebookEdit', () => {
    const rules = buildReadOnlyDenyRules(WS, [{ directory_path: '/Users/x/Data/MyResearch', read_only: true }]);
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      expect(rules).toContain(`${tool}(//Users/x/Data/MyResearch/**)`);
      expect(rules).toContain(`${tool}(/${WS}/MyResearch/**)`);
    }
    expect(rules).toHaveLength(6);
  });

  it('uses the double-slash absolute form, never a single-slash (project-relative) one', () => {
    const rules = buildReadOnlyDenyRules(WS, [{ directory_path: '/Users/x/Data', read_only: true }]);
    for (const r of rules) expect(r).toMatch(/^\w+\(\/\/Users\//);
  });

  it('keeps spaces literal and ignores trailing slashes', () => {
    const rules = buildReadOnlyDenyRules(WS, [{ directory_path: '/Users/x/My Research///', read_only: true }]);
    expect(rules).toContain('Edit(//Users/x/My Research/**)');
    expect(rules).toContain(`Edit(/${WS}/MyResearch/**)`);
  });

  it('only locks the locked folders', () => {
    const rules = buildReadOnlyDenyRules(WS, [
      { directory_path: '/a/Open', read_only: false },
      { directory_path: '/a/Locked', read_only: true },
    ]);
    expect(rules.some(r => r.includes('/Open/'))).toBe(false);
    expect(rules.some(r => r.includes('/a/Locked/'))).toBe(true);
  });

  it('dedupes when the real path is the symlink path', () => {
    const rules = buildReadOnlyDenyRules('/ws', [{ directory_path: '/ws/Same', read_only: true }]);
    expect(rules).toHaveLength(3);
  });
});

describe('denyRuleForPath', () => {
  it('escapes glob and rule metacharacters', () => {
    // glob needs `\[`, and the rule layer halves `\\`, so the rule carries `\\[`.
    expect(denyRuleForPath('Edit', '/a/data[1]')).toBe('Edit(//a/data\\\\[1\\\\]/**)');
    expect(denyRuleForPath('Edit', '/a/b (copy)')).toBe('Edit(//a/b \\(copy\\)/**)');
  });
  it('refuses the filesystem root and relative paths', () => {
    expect(denyRuleForPath('Edit', '/')).toBeNull();
    expect(denyRuleForPath('Edit', 'relative/dir')).toBeNull();
  });
});

describe('mountNames', () => {
  it('sanitizes and dedupes exactly like the workspace symlinks', () => {
    expect(mountNames(['/a/My Data', '/b/Data', '/c/Data', '/d/Data/'])).toEqual(['MyData', 'Data', 'Data_2', 'Data_3']);
  });
  it('falls back to dir when nothing survives sanitizing', () => {
    expect(mountNames(['/a/\u00e9\u00e9'])).toEqual(['dir']);
  });
  it('rules follow the deduped symlink name, counting unlocked folders too', () => {
    const rules = buildReadOnlyDenyRules('/ws', [
      { directory_path: '/a/Data', read_only: false },
      { directory_path: '/b/Data', read_only: true },
    ]);
    expect(rules).toContain('Edit(//ws/Data_2/**)');
    expect(rules).not.toContain('Edit(//ws/Data/**)');
  });
});
