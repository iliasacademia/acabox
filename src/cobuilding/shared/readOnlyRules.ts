/**
 * Permission deny rules that enforce a locked (read-only) shared folder.
 *
 * Before 2026-10-01 the lock was advisory: the prompt said "direct edits will
 * fail" and nothing made them fail. The SDK's `Options.settings` accepts
 * `{ permissions: { deny: string[] } }`, and a deny rule beats `allowedTools`,
 * so a locked folder is now refused at the tool layer.
 *
 * RULE SYNTAX, read out of the bundled Claude Code 2.1.280 binary rather than
 * assumed (its path normaliser does `if (e.startsWith("//")) return
 * normalize(e.slice(1))`; a second call site does `i.startsWith("//") ?
 * i.slice(1) : i`; and its own warning text offers `Edit(/**)` as the
 * "workspace-scoped" form, i.e. a single leading slash is NOT absolute):
 *   - `//abs/path/**`  filesystem-absolute (the leading `//` is stripped to `/`)
 *   - `/path/**`       relative to the project root, a trap
 *   - `~/path/**`      home-relative
 *   - `path/**`        relative to the cwd
 * Patterns are gitignore-style, so `/**` matches everything beneath. Inside
 * the `Tool(...)` wrapper the rule string unescapes `\(`, `\)` and `\\`, so
 * those are escaped for the rule layer. For the glob layer, `* ? [ ]` and `\`
 * are backslash-escaped (a folder literally named `data[1]` must not become a
 * character class that silently matches nothing). Escaping of unusual
 * characters is best effort and not exercised against the CLI; spaces need
 * none and are the case that matters.
 *
 * `Edit` rules cover the file-edit tools generally, but the three are listed
 * explicitly so the rule set does not depend on that. Shell writes (`Bash`)
 * are NOT blocked by any of this; the prompt tells the agent not to do them.
 *
 * Each locked folder yields rules for BOTH its real path and its workspace
 * symlink (`<workspace>/<name>`), because the agent addresses it through the
 * symlink and the CLI may or may not resolve it before matching.
 */

export const READ_ONLY_RULE_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const;

export interface LockableDirectory {
  directory_path: string;
  read_only: boolean;
}

/**
 * The name each shared folder carries in the workspace root: the sanitized
 * basename, with `_2`, `_3` for collisions, in list order. Single source of
 * truth for both the symlink the agent addresses (`buildMountMap` ->
 * `syncWorkspaceSymlinks`) and the deny rules below; two copies would let a
 * lock cover a name the agent never uses.
 */
export function mountNames(directoryPaths: string[]): string[] {
  const counts = new Map<string, number>();
  return directoryPaths.map(p => {
    const base = p.replace(/\/+$/, '').split('/').pop()!.replace(/[^a-zA-Z0-9._-]/g, '') || 'dir';
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    return count > 0 ? `${base}_${count + 1}` : base;
  });
}

function stripTrailingSlashes(p: string): string {
  const stripped = p.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

function escapeForRule(p: string): string {
  return p
    .replace(/([\\*?[\]])/g, '\\$1') // glob layer
    .replace(/\\/g, '\\\\') // rule layer
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/** `Edit(//abs/path/**)` for one absolute path. Null for a path that cannot be a folder lock. */
export function denyRuleForPath(tool: string, absPath: string): string | null {
  const clean = stripTrailingSlashes(absPath);
  // A lock on `/` would deny every write on the machine; never a real folder.
  if (!clean.startsWith('/') || clean === '/') return null;
  return `${tool}(/${escapeForRule(clean)}/**)`;
}

/** Deny rules for every locked directory, real path and workspace symlink. */
export function buildReadOnlyDenyRules(
  workspacePath: string,
  dirs: LockableDirectory[],
): string[] {
  const rules = new Set<string>();
  // Names are computed over ALL folders (a collision suffix depends on the
  // unlocked ones too), then only the locked ones produce rules.
  const names = mountNames(dirs.map(d => d.directory_path));
  dirs.forEach((dir, i) => {
    if (!dir.read_only) return;
    const real = stripTrailingSlashes(dir.directory_path);
    const paths = [real, `${stripTrailingSlashes(workspacePath)}/${names[i]}`];
    for (const p of paths) {
      for (const tool of READ_ONLY_RULE_TOOLS) {
        const rule = denyRuleForPath(tool, p);
        if (rule) rules.add(rule);
      }
    }
  });
  return [...rules];
}
