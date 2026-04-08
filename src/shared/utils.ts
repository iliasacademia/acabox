import { DateTime } from 'luxon';

export function getLocalDate(date?: Date): string {
  const dt = date ? DateTime.fromJSDate(date) : DateTime.now();
  return dt.toFormat('yyyy-MM-dd');
}

export function getLocalTime(date?: Date): string {
  const dt = date ? DateTime.fromJSDate(date) : DateTime.now();
  return dt.toFormat('HH:mm');
}

export function getLocalTimezone(): string {
  return DateTime.now().offsetNameShort ?? '';
}

export function utcToLocal(timestamp: string | number): string {
  const dt = typeof timestamp === 'number'
    ? DateTime.fromSeconds(timestamp, { zone: 'utc' })
    : DateTime.fromISO(timestamp, { zone: 'utc' });
  if (!dt.isValid) return String(timestamp);
  return dt.toLocal().toISO()!;
}

/**
 * Strip HTML tags from a string and decode HTML entities
 * @param html HTML string to strip
 * @returns Plain text without HTML tags
 */
export function stripHtml(html: string): string {
  if (!html) return '';

  // Remove script and style tags with their content first (security)
  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');

  // Remove remaining HTML tags
  text = text.replace(/<[^>]*>/g, '');

  // Decode numeric character references (decimal: &#123; and hex: &#x1A;)
  text = text.replace(/&#x([0-9A-Fa-f]+);/g, (_match, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });
  text = text.replace(/&#(\d+);/g, (_match, dec) => {
    return String.fromCharCode(parseInt(dec, 10));
  });

  // Decode common named HTML entities
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
    '&ndash;': '\u2013', // en dash
    '&mdash;': '\u2014', // em dash
    '&hellip;': '\u2026', // horizontal ellipsis
    '&copy;': '\u00A9', // copyright
    '&reg;': '\u00AE', // registered trademark
    '&trade;': '\u2122', // trademark
    '&euro;': '\u20AC', // euro
    '&pound;': '\u00A3', // pound
    '&yen;': '\u00A5', // yen
    '&cent;': '\u00A2', // cent
    '&deg;': '\u00B0', // degree
    '&plusmn;': '\u00B1', // plus-minus
    '&times;': '\u00D7', // multiplication
    '&divide;': '\u00F7', // division
    '&frac14;': '\u00BC', // one quarter
    '&frac12;': '\u00BD', // one half
    '&frac34;': '\u00BE', // three quarters
    '&bull;': '\u2022', // bullet
    '&middot;': '\u00B7', // middle dot
    '&lsquo;': '\u2018', // left single quote
    '&rsquo;': '\u2019', // right single quote
    '&ldquo;': '\u201C', // left double quote
    '&rdquo;': '\u201D', // right double quote
    '&laquo;': '\u00AB', // left angle quote
    '&raquo;': '\u00BB', // right angle quote
  };

  // Replace named entities (must be done after numeric entities)
  Object.keys(entities).forEach(entity => {
    text = text.replace(new RegExp(entity, 'g'), entities[entity]);
  });

  // Trim whitespace
  return text.trim();
}
