/**
 * Deterministic chat<->tool linking, at the moment a tool is scaffolded or
 * opened, instead of via the after-the-fact message scan in
 * `chatRepository.findSessionForApp`.
 *
 * Incident (2026-09-18): a chat scaffolded a tool via
 * `manage_mini_app.mjs --name "Co-Scientist Spend Explorer" ...`, which prints
 * `{"name":..., "dir_name":..., "dir":...}` as its result. The scaffold
 * command line only ever carries the display name, never the dir name — the
 * dir name appears solely in the tool_result JSON — so the legacy scan (which
 * requires an assistant row containing both the script name AND the dir name)
 * never matched, the tool card opened to a brand-new empty chat, and the
 * user's real conversation was stranded under an unrelated auto-title.
 *
 * Pure, side-effect-free, and never throws — this is bookkeeping that must
 * never break a turn if the shape of a message is unexpected.
 */

/** Charset matches what the scaffold script and the MCP tool schema produce:
 *  no `/`, no `\`, not dot-prefixed, first character alphanumeric. */
const APP_DIR_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** True iff `value` is a non-empty string safe to use as an app dir name. */
export function isLinkableAppDirName(value: unknown): value is string {
  return typeof value === 'string' && APP_DIR_NAME_PATTERN.test(value);
}

/**
 * Finds the dir name a scaffold command reported, if any.
 *
 * `command` must reference the scaffold script — otherwise a Bash command
 * whose output happens to contain scaffold-shaped JSON (e.g. `cat`-ing a
 * manifest) would be misread as having just created a tool.
 *
 * `resultText` is scanned line by line, not parsed as a whole: agents chain
 * commands (`node …manage_mini_app.mjs … && ls -la …`) and npm/node may print
 * warnings before the script's own JSON line. The first line that parses as a
 * JSON object with a linkable `dir_name` wins.
 */
export function extractScaffoldedDirName(command: string, resultText: string): string | null {
  if (typeof command !== 'string' || !command.includes('manage_mini_app.mjs')) return null;
  if (typeof resultText !== 'string' || !resultText) return null;

  for (const rawLine of resultText.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
    const dirName = (parsed as Record<string, unknown>).dir_name;
    if (isLinkableAppDirName(dirName)) return dirName;
  }

  return null;
}

const OPEN_TOOL_NAMES = new Set([
  'mcp__mini-apps__build_and_open_mini_application',
  'mcp__mini-apps__open_mini_application',
]);

/**
 * Finds the dir name a `build_and_open_mini_application` / `open_mini_application`
 * tool call named, if the block is one of those calls and its `dir_name` is
 * safe to use.
 */
export function extractOpenedDirName(block: { type?: unknown; name?: unknown; input?: unknown }): string | null {
  if (!block || block.type !== 'tool_use') return null;
  if (typeof block.name !== 'string' || !OPEN_TOOL_NAMES.has(block.name)) return null;
  const input = block.input;
  if (typeof input !== 'object' || input === null) return null;
  const dirName = (input as Record<string, unknown>).dir_name;
  return isLinkableAppDirName(dirName) ? dirName : null;
}
