import log from 'electron-log';
import { createBriefing, listBriefings } from '../db/briefingsRepository';
import type { PaperRecord } from './papersService';

/**
 * Persist fetched papers as `type: 'paper'` briefings on the active workspace.
 * Dedupes by externalId stored inside briefing_data, so re-fetching the same
 * digest doesn't re-spam the Home tab.
 *
 * Returns the number of new briefings created.
 */
export function persistPapersAsBriefings(
  workspaceId: string,
  papers: PaperRecord[],
): number {
  if (papers.length === 0) return 0;

  const seen = collectKnownPaperKeys(workspaceId);
  let created = 0;

  for (const p of papers) {
    const key = paperKey(p);
    if (seen.has(key)) continue;

    const data = {
      title: p.title,
      authors: p.authors,
      url: p.url,
      abstract: p.abstract,
      // Extras for round-tripping; renderer's BriefingDataPaper ignores them.
      externalId: p.externalId,
      doi: p.doi,
      source: p.source,
      sources: p.sources,
      venue: p.venue,
      publishedAt: p.publishedAt,
      pdfUrl: p.pdfUrl,
    };

    const why = p.matchedTopic
      ? `Matches your topic: ${p.matchedTopic}`
      : null;

    try {
      createBriefing({
        workspaceId,
        type: 'paper',
        briefingData: data,
        whyImSuggestingThis: why,
      });
      seen.add(key);
      created++;
    } catch (err) {
      log.warn(
        `[Papers→Briefings] failed to insert "${p.title}": ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (created > 0) {
    log.info(`[Papers→Briefings] created ${created} new paper briefings`);
  }
  return created;
}

function paperKey(p: { externalId?: string; doi?: string | null; title?: string }): string {
  if (p.doi) return `doi:${p.doi.toLowerCase()}`;
  if (p.externalId) return `ext:${p.externalId}`;
  return `title:${(p.title ?? '').toLowerCase().trim()}`;
}

function collectKnownPaperKeys(workspaceId: string): Set<string> {
  const keys = new Set<string>();
  // No status filter — we want to skip papers we've ever stored, regardless
  // of whether the user opened/dismissed them.
  const existing = listBriefings(workspaceId, {});
  for (const b of existing) {
    if (b.type !== 'paper') continue;
    try {
      const data = JSON.parse(b.briefing_data) as {
        externalId?: string;
        doi?: string | null;
        title?: string;
      };
      keys.add(paperKey(data));
    } catch {
      // briefing_data isn't valid JSON — skip; the briefing will simply be
      // treated as not-yet-stored on the next iteration.
    }
  }
  return keys;
}
