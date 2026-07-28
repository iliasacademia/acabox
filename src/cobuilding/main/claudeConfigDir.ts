/**
 * Where Claude Code keeps its own config for the chat agent.
 *
 * `CLAUDE_CONFIG_DIR` holds, among other things:
 *  - `.claude.json` → `customApiKeyResponses.approved` (the API-key approval
 *    `shared/claudeConfigApproval.ts` writes) and `mcpOAuth` (access +
 *    refresh tokens for every connector the user has signed in to)
 *  - `projects/<key>/*.jsonl` → full session transcripts
 *
 * This used to live at `<workspace>/.academia/claude-config`, i.e. inside the
 * agent's own cwd, where the agent has Read/Write/Bash. Connector OAuth tokens
 * for third-party services do not belong somewhere the agent can cat them, so
 * it now lives under userData alongside the app's other private state (the
 * directory scanner already did this with `scanner-claude-config`).
 *
 * The SDK derives its per-project session key from the query's `cwd`, which is
 * unchanged, so moving the directory preserves session resume.
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import log from 'electron-log';

export const CLAUDE_CONFIG_DIR_NAME = 'claude-config';

/** Absolute path to the agent's Claude Code config dir (outside the workspace). */
export function getClaudeConfigDir(): string {
  return path.join(app.getPath('userData'), CLAUDE_CONFIG_DIR_NAME);
}

/** The pre-2026-07-28 location, inside the workspace. */
function legacyClaudeConfigDir(workspacePath: string): string {
  return path.join(workspacePath, '.academia', CLAUDE_CONFIG_DIR_NAME);
}

/**
 * Move an existing in-workspace config dir to userData, once.
 *
 * Idempotent and best-effort: if the destination already exists we leave the
 * legacy directory alone rather than merging (merging two `.claude.json`
 * files would risk clobbering a newer approval or token set). Failure is
 * logged, not thrown — a failed migration must not stop the agent booting; it
 * just means a fresh config dir and one re-authentication.
 */
export function migrateClaudeConfigDir(workspacePath: string): void {
  const legacy = legacyClaudeConfigDir(workspacePath);
  const target = getClaudeConfigDir();

  if (!fs.existsSync(legacy)) return;
  if (fs.existsSync(target)) {
    log.info(`[ClaudeConfig] Both ${legacy} and ${target} exist; keeping ${target} and leaving the legacy copy in place.`);
    return;
  }

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(legacy, target);
    log.info(`[ClaudeConfig] Moved ${legacy} → ${target} (out of the agent-writable workspace)`);
  } catch (err) {
    // Cross-device rename is the realistic failure; fall back to copy+remove.
    try {
      fs.cpSync(legacy, target, { recursive: true });
      fs.rmSync(legacy, { recursive: true, force: true });
      log.info(`[ClaudeConfig] Copied ${legacy} → ${target} (rename failed: ${(err as Error).message})`);
    } catch (copyErr) {
      log.warn(`[ClaudeConfig] Could not migrate ${legacy}: ${(copyErr as Error).message}`);
    }
  }
}
