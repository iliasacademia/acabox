/**
 * A user-facing error is a plain headline, optionally followed by the raw
 * technical text. The two travel as ONE string (the chat error channel carries
 * a string and nothing else), joined by a marker the renderer splits on so the
 * raw part can sit behind a "Details" disclosure instead of being the headline.
 */
export const ERROR_DETAILS_MARKER = '\n\nDetails: ';

export function withErrorDetails(headline: string, details?: string | null): string {
  const d = (details ?? '').trim();
  if (!d || d === headline) return headline;
  return `${headline}${ERROR_DETAILS_MARKER}${d}`;
}

export function splitErrorDetails(text: string): { headline: string; details: string | null } {
  const at = text.indexOf(ERROR_DETAILS_MARKER);
  if (at < 0) return { headline: text, details: null };
  const details = text.slice(at + ERROR_DETAILS_MARKER.length).trim();
  return { headline: text.slice(0, at), details: details || null };
}
