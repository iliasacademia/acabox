/**
 * The title a chat carries until its first reply names it.
 *
 * Sentence case, like every other label. Rows created before 2026-10-01
 * stored `New Chat` (the SQL column default said so), and nothing rewrites
 * stored titles — so every comparison goes through `isPlaceholderTitle`,
 * which accepts both spellings, rather than `===` against the constant.
 */
export const DEFAULT_SESSION_TITLE = 'New chat';

export function isPlaceholderTitle(title: string | null | undefined): boolean {
  if (title == null) return true;
  const t = title.trim();
  return t === '' || t.toLowerCase() === DEFAULT_SESSION_TITLE.toLowerCase();
}
