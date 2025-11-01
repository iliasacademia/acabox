import { stripHtml } from '../utils';

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
});
