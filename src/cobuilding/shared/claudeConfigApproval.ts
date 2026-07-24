import * as fs from 'fs';
import * as path from 'path';

/**
 * Pre-approve an Anthropic API key for the bundled Claude Code binary.
 *
 * Claude Code only honors the ANTHROPIC_API_KEY env var when the key has been
 * "approved": interactively it prompts ("Do you want to use this API key?")
 * and records the key's last 20 characters in
 * `customApiKeyResponses.approved` of `.claude.json` under CLAUDE_CONFIG_DIR.
 * Headless (SDK / --print) runs can never answer that prompt, so an
 * unapproved key yields "Not logged in · Please run /login" instead of a
 * completion. Acabox has no login flow — the user-supplied key is the only
 * credential — so record the approval ourselves before every SDK invocation.
 *
 * Idempotent, and preserves everything else in .claude.json (userID,
 * migration flags, session state).
 */
export function ensureApiKeyApproved(configDir: string, apiKey: string | null | undefined): void {
  if (!apiKey) return;
  const entry = apiKey.slice(-20);
  const configPath = path.join(configDir, '.claude.json');

  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    // Missing or unreadable — start fresh; Claude Code tolerates a minimal file.
  }

  const responses = (config.customApiKeyResponses ?? {}) as {
    approved?: string[];
    rejected?: string[];
  };
  const approved = responses.approved ?? [];
  const rejected = responses.rejected ?? [];
  if (approved.includes(entry) && !rejected.includes(entry)) return;

  config.customApiKeyResponses = {
    ...responses,
    approved: approved.includes(entry) ? approved : [...approved, entry],
    // A previously rejected key would still be refused — clear it.
    rejected: rejected.filter((r) => r !== entry),
  };

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config));
}
