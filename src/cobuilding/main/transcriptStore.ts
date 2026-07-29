/**
 * Lifecycle for the SDK's own conversation transcripts.
 *
 * Claude Code writes one JSONL transcript per conversation to
 * `<CLAUDE_CONFIG_DIR>/projects/<key>/<sdkSessionId>.jsonl`, and that file — not
 * anything in our database — is what `resumeSessionId` replays. Nothing in the
 * app ever deleted one: `deleteSession` drops the row and the Debug hard reset
 * drops every row, both leaving the transcripts behind forever. They are not
 * small (1.4 MB and 1.1 MB for two ordinary chats on the machine this was
 * written on; 5.5 MB for one that had a CSV inlined into it).
 *
 * Two facts make this safe and simple, both established by measurement rather
 * than assumption:
 *
 *  - **One chat is one transcript.** Resume appends to the existing file and
 *    keeps the same session id, so `sessions.sdk_session_id` names the whole
 *    history — there is no chain of ancestor files to chase.
 *  - **An unreferenced transcript is unreachable.** Resume only ever names an
 *    id read out of `sessions.sdk_session_id`, so a file no row points at can
 *    never be replayed again. That is what makes the orphan sweep sound.
 *
 * The sweep therefore also removes transcripts from agent runs that were never
 * chats at all — the workspace scanner, title generation, standalone test
 * harnesses. Those are one-shot queries that are never resumed, so this is
 * intended, not collateral.
 */
import * as fs from 'fs';
import * as path from 'path';
import log from 'electron-log';
import { getClaudeConfigDir } from './claudeConfigDir';

/**
 * Project subdirectories under the config dir. Normally one, but the SDK keys
 * projects off the query's `cwd`, so a workspace that has moved leaves the old
 * key behind with transcripts still in it.
 */
function projectDirs(): string[] {
  const root = path.join(getClaudeConfigDir(), 'projects');
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name));
  } catch {
    return []; // No config dir yet — nothing to clean.
  }
}

/** Transcript files directly inside a project dir, as [sessionId, absPath]. */
function transcriptsIn(dir: string): Array<[string, string]> {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => [e.name.slice(0, -'.jsonl'.length), path.join(dir, e.name)]);
  } catch {
    return [];
  }
}

function removeQuietly(file: string): number {
  try {
    const bytes = fs.statSync(file).size;
    fs.rmSync(file, { force: true });
    return bytes;
  } catch (err) {
    // Best-effort throughout: a transcript we cannot delete is wasted disk,
    // never a reason to fail the delete the user actually asked for.
    log.warn(`[Transcripts] Could not remove ${path.basename(file)}: ${(err as Error).message}`);
    return 0;
  }
}

/**
 * Delete the transcript for one conversation. Call with the value of
 * `sessions.sdk_session_id` read BEFORE the row is deleted — once the row is
 * gone there is nothing left to identify the file by.
 *
 * A null/undefined id means the chat never completed a turn and has no
 * transcript; that is a no-op, not an error.
 */
export function deleteTranscript(sdkSessionId: string | null | undefined): boolean {
  if (!sdkSessionId) return false;
  for (const dir of projectDirs()) {
    const file = path.join(dir, `${sdkSessionId}.jsonl`);
    if (fs.existsSync(file)) {
      const bytes = removeQuietly(file);
      log.info(`[Transcripts] Removed transcript ${sdkSessionId} (${bytes} bytes)`);
      return true;
    }
  }
  return false;
}

/**
 * Delete every transcript no live chat points at.
 *
 * Runs at boot, deliberately: nothing is resuming or writing a transcript at
 * that point, so there is no window in which a file could be in use. Do not
 * move this onto a timer without solving that — the scanner and title
 * generation both create transcripts mid-run, and would be swept out from
 * under themselves.
 */
export function sweepOrphanTranscripts(liveSdkSessionIds: Iterable<string>): {
  removed: number;
  bytes: number;
} {
  const live = new Set(liveSdkSessionIds);
  let removed = 0;
  let bytes = 0;

  for (const dir of projectDirs()) {
    for (const [id, file] of transcriptsIn(dir)) {
      if (live.has(id)) continue;
      bytes += removeQuietly(file);
      removed++;
    }
  }

  if (removed > 0) {
    log.info(
      `[Transcripts] Swept ${removed} orphaned transcript(s), reclaimed ${Math.round(bytes / 1024)} KB`,
    );
  }
  return { removed, bytes };
}
