import { stripHtml, getLocalDate, getLocalTime, getLocalTimezone, utcToLocal, toUtcIso } from '../utils';

describe('getLocalDate', () => {
  it('should return YYYY-MM-DD for a given date', () => {
    expect(getLocalDate(new Date(2024, 0, 1))).toBe('2024-01-01');
    expect(getLocalDate(new Date(2024, 11, 31))).toBe('2024-12-31');
  });

  it('should default to today', () => {
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    expect(getLocalDate()).toBe(expected);
  });
});

describe('getLocalTime', () => {
  it('should return HH:MM for a given date', () => {
    expect(getLocalTime(new Date(2024, 0, 1, 9, 5))).toBe('09:05');
    expect(getLocalTime(new Date(2024, 0, 1, 14, 30))).toBe('14:30');
    expect(getLocalTime(new Date(2024, 0, 1, 0, 0))).toBe('00:00');
  });
});

describe('getLocalTimezone', () => {
  it('should return a non-empty string', () => {
    const tz = getLocalTimezone();
    expect(typeof tz).toBe('string');
    expect(tz.length).toBeGreaterThan(0);
  });
});

describe('utcToLocal', () => {
  it('should convert a UTC ISO string to local time with offset', () => {
    const utc = '2024-06-15T10:30:00.000Z';
    const result = utcToLocal(utc);
    // Verify it parses to the same instant
    expect(new Date(result).getTime()).toBe(new Date(utc).getTime());
    // Verify it contains a timezone offset (not Z)
    expect(result).not.toContain('Z');
    expect(result).toMatch(/[+-]\d{2}:\d{2}$/);
    // Verify local hours are used
    const localHours = String(new Date(utc).getHours()).padStart(2, '0');
    expect(result).toContain(`T${localHours}:`);
  });

  it('should handle Unix epoch seconds', () => {
    const epochSecs = 1718446200; // 2024-06-15T10:30:00Z
    const result = utcToLocal(epochSecs);
    const d = new Date(epochSecs * 1000);
    const localHours = String(d.getHours()).padStart(2, '0');
    expect(result).toContain(`T${localHours}:`);
    expect(result).toMatch(/[+-]\d{2}:\d{2}$/);
  });

  it('should pass through invalid timestamps', () => {
    expect(utcToLocal('not-a-date')).toBe('not-a-date');
  });
});

describe('toUtcIso', () => {
  it('should pass through UTC Z timestamps unchanged', () => {
    const utc = '2026-04-09T21:18:00.000Z';
    expect(toUtcIso(utc)).toBe(utc);
  });

  it('should convert local time with offset to UTC', () => {
    const local = '2026-04-09T14:18:00.000-07:00';
    expect(toUtcIso(local)).toBe('2026-04-09T21:18:00.000Z');
  });

  it('should convert positive offset to UTC', () => {
    const input = '2026-04-10T03:30:00.000+05:30';
    expect(toUtcIso(input)).toBe('2026-04-09T22:00:00.000Z');
  });

  it('should preserve the same instant when converting', () => {
    const local = '2026-04-09T14:18:00.000-07:00';
    const utcResult = toUtcIso(local);
    expect(new Date(utcResult).getTime()).toBe(new Date(local).getTime());
  });

  it('should pass through invalid timestamps', () => {
    expect(toUtcIso('not-a-date')).toBe('not-a-date');
  });
});

describe('stripHtml', () => {
  it('should remove HTML tags from string', () => {
    const html = '<p>This is <strong>bold</strong> text</p>';
    const result = stripHtml(html);
    expect(result).toBe('This is bold text');
  });

  it('should decode common HTML entities', () => {
    const html = 'Text with &amp; &lt; &gt; &quot; &#39; entities';
    const result = stripHtml(html);
    expect(result).toBe('Text with & < > " \' entities');
  });

  it('should handle combined HTML tags and entities', () => {
    const html = '<p>Email: <a href="mailto:test@example.com">test@example.com</a> &amp; more</p>';
    const result = stripHtml(html);
    expect(result).toBe('Email: test@example.com & more');
  });

  it('should return empty string for empty input', () => {
    expect(stripHtml('')).toBe('');
  });

  it('should trim whitespace from result', () => {
    const html = '  <p>  Text  </p>  ';
    const result = stripHtml(html);
    expect(result).toBe('Text');
  });

  it('should handle text without HTML tags', () => {
    const plainText = 'Plain text without tags';
    const result = stripHtml(plainText);
    expect(result).toBe(plainText);
  });

  it('should handle nested HTML tags', () => {
    const html = '<div><p>Nested <span><em>tags</em></span></p></div>';
    const result = stripHtml(html);
    expect(result).toBe('Nested tags');
  });

  it('should handle self-closing tags', () => {
    const html = 'Line 1<br/>Line 2<hr/>End';
    const result = stripHtml(html);
    expect(result).toBe('Line 1Line 2End');
  });

  it('should remove script tags and their content for security', () => {
    const html = '<p>Safe content</p><script>alert("XSS")</script><p>More safe content</p>';
    const result = stripHtml(html);
    expect(result).toBe('Safe contentMore safe content');
    expect(result).not.toContain('alert');
  });

  it('should remove style tags and their content', () => {
    const html = '<p>Text</p><style>.class { color: red; }</style><p>More text</p>';
    const result = stripHtml(html);
    expect(result).toBe('TextMore text');
    expect(result).not.toContain('color');
  });

  it('should decode decimal numeric character references', () => {
    const html = 'Text with &#8217; apostrophe and &#8220;quotes&#8221;';
    const result = stripHtml(html);
    // &#8217; = right single quote, &#8220; = left double quote, &#8221; = right double quote
    expect(result).toBe('Text with \u2019 apostrophe and \u201Cquotes\u201D');
  });

  it('should decode hexadecimal numeric character references', () => {
    const html = 'Text with &#x27; apostrophe and &#xA9; copyright';
    const result = stripHtml(html);
    expect(result).toBe("Text with ' apostrophe and \u00A9 copyright");
  });

  it('should decode additional named entities', () => {
    const html = 'Copyright &copy; 2024 &mdash; All rights &reg; reserved &trade;';
    const result = stripHtml(html);
    expect(result).toBe('Copyright \u00A9 2024 \u2014 All rights \u00AE reserved \u2122');
  });

  it('should handle mixed numeric and named entities', () => {
    const html = '&#8220;Hello&rdquo; &#x2013; &#169; 2024';
    const result = stripHtml(html);
    // &#8220; = left double quote, &rdquo; = right double quote, &#x2013; = en dash, &#169; = copyright
    expect(result).toBe('\u201CHello\u201D \u2013 \u00A9 2024');
  });

  it('should handle complex real-world notification content', () => {
    const html = '<p>Your review is ready! Check it out at <a href="#">link</a>.</p><script>track()</script>';
    const result = stripHtml(html);
    expect(result).toBe('Your review is ready! Check it out at link.');
    expect(result).not.toContain('script');
    expect(result).not.toContain('track');
  });
});
