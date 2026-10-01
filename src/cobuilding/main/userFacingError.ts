import { withErrorDetails } from '../shared/errorDetails';

/**
 * The one funnel between a failure anywhere under a chat turn and the words
 * the person sees. Raw host and SDK text ("Agent server failed to become
 * healthy within 15s", "Failed to authenticate. API Error: 401") used to be
 * the headline of a chat bubble; now it is classified here, the headline is a
 * plain sentence with a next step, and the raw text rides along as `Details`.
 *
 * Electron-free and pure so it can be unit-tested.
 */

export const ASSISTANT_NOT_RESPONDING =
  "Acabox's assistant isn't responding. Try again in a moment — if it keeps happening, quit and reopen Acabox.";

export const ASSISTANT_COULD_NOT_START =
  "Acabox couldn't start its assistant. Quit and reopen Acabox, then try again.";

export const API_KEY_REJECTED =
  'Your Anthropic API key was rejected. Update it in Settings and try again.';

const OUT_OF_CREDIT =
  'Your Anthropic account has run out of credit. Add credit in your Anthropic console, then try again.';

const SERVICE_BUSY =
  'Anthropic is busy right now. Wait a minute and try again.';

const GENERIC =
  "Something went wrong while I was working on that. Try sending it again — if it keeps happening, quit and reopen Acabox.";

/**
 * Messages the host already wrote in plain words. They are passed through as
 * they are — classifying them again would bury a good sentence under the
 * generic one.
 */
const PLAIN_PREFIXES = [
  'Your Anthropic API key',
  'No Anthropic API key',
  "Acabox's assistant",
  "Acabox couldn't",
  'The assistant stopped',
  'This chat got too long',
  "I didn't manage",
];

export function toUserFacingError(raw: string | null | undefined): string {
  const text = (raw ?? '').trim();
  if (!text || /^unknown agent error$/i.test(text)) return ASSISTANT_NOT_RESPONDING;
  if (PLAIN_PREFIXES.some((p) => text.startsWith(p))) return text;

  if (/failed to authenticate|api error: ?40[13]|invalid x-api-key|authentication_error/i.test(text)) {
    return withErrorDetails(API_KEY_REJECTED, text);
  }
  if (/credit balance|insufficient (credit|funds)|billing/i.test(text)) {
    return withErrorDetails(OUT_OF_CREDIT, text);
  }
  if (/overloaded|rate.?limit|\b(429|529)\b/i.test(text)) {
    return withErrorDetails(SERVICE_BUSY, text);
  }
  if (/agent (server )?(failed|exited)|failed to become healthy|exited before becoming healthy|ECONNREFUSED|ECONNRESET|socket hang up|fetch failed|HTTP 5\d\d/i.test(text)) {
    return withErrorDetails(ASSISTANT_NOT_RESPONDING, text);
  }
  return withErrorDetails(GENERIC, text);
}
