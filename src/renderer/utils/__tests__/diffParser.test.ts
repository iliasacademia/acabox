/**
 * Tests for diffParser utility functions
 */

import { parseDiff, parseWordDiff, getLineType } from '../diffParser';

describe('diffParser', () => {
  describe('parseDiff', () => {
    it('should parse context lines', () => {
      const diff = ' # Methods\n This is unchanged text';
      const result = parseDiff(diff);

      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('context');
      expect(result[0].content).toBe('# Methods');
      expect(result[1].type).toBe('context');
      expect(result[1].content).toBe('This is unchanged text');
    });

    it('should parse deleted lines', () => {
      const diff = '-Old text here';
      const result = parseDiff(diff);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('deleted');
      expect(result[0].content).toBe('Old text here');
    });

    it('should parse added lines', () => {
      const diff = '+New text here';
      const result = parseDiff(diff);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('added');
      expect(result[0].content).toBe('New text here');
    });

    it('should parse modified lines', () => {
      const diff = '~Text with [-old-]{+new+} words';
      const result = parseDiff(diff);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('modified');
      expect(result[0].content).toBe('Text with [-old-]{+new+} words');
    });

    it('should parse header lines', () => {
      const diff = '--- Previous Version\n+++ Current Version\n@@ -5,7 +5,7 @@';
      const result = parseDiff(diff);

      expect(result).toHaveLength(3);
      expect(result[0].type).toBe('header');
      expect(result[1].type).toBe('header');
      expect(result[2].type).toBe('header');
    });

    it('should parse mixed diff', () => {
      const diff = `--- Previous Version
+++ Current Version
@@ -5,7 +5,7 @@
 # Methods
~The methodology describes the [-original-]{+improved+} approach.
-Old line
+New line
 Unchanged line`;

      const result = parseDiff(diff);

      expect(result).toHaveLength(8);
      expect(result[0].type).toBe('header');
      expect(result[3].type).toBe('context');
      expect(result[4].type).toBe('modified');
      expect(result[5].type).toBe('deleted');
      expect(result[6].type).toBe('added');
      expect(result[7].type).toBe('context');
    });

    it('should handle empty string', () => {
      const result = parseDiff('');
      expect(result).toHaveLength(0);
    });

    it('should assign line numbers correctly', () => {
      const diff = ` Line 1
 Line 2
-Deleted
+Added
 Line 3`;

      const result = parseDiff(diff);

      expect(result[0].lineNumber).toBe(0);
      expect(result[1].lineNumber).toBe(1);
      expect(result[2].lineNumber).toBe(2);
      expect(result[3].lineNumber).toBe(3);
      expect(result[4].lineNumber).toBe(4);
    });
  });

  describe('parseWordDiff', () => {
    it('should parse deleted words', () => {
      const text = 'Text with [-deleted-] content';
      const result = parseWordDiff(text);

      expect(result).toHaveLength(3);
      expect(result[0].type).toBe('normal');
      expect(result[0].text).toBe('Text with ');
      expect(result[1].type).toBe('deleted');
      expect(result[1].text).toBe('deleted');
      expect(result[2].type).toBe('normal');
      expect(result[2].text).toBe(' content');
    });

    it('should parse added words', () => {
      const text = 'Text with {+added+} content';
      const result = parseWordDiff(text);

      expect(result).toHaveLength(3);
      expect(result[0].type).toBe('normal');
      expect(result[0].text).toBe('Text with ');
      expect(result[1].type).toBe('added');
      expect(result[1].text).toBe('added');
      expect(result[2].type).toBe('normal');
      expect(result[2].text).toBe(' content');
    });

    it('should parse mixed word diffs', () => {
      const text = 'The [-old-]{+new+} approach {+with additions+}';
      const result = parseWordDiff(text);

      expect(result).toHaveLength(5);
      expect(result[0].type).toBe('normal');
      expect(result[0].text).toBe('The ');
      expect(result[1].type).toBe('deleted');
      expect(result[1].text).toBe('old');
      expect(result[2].type).toBe('added');
      expect(result[2].text).toBe('new');
      expect(result[3].type).toBe('normal');
      expect(result[3].text).toBe(' approach ');
      expect(result[4].type).toBe('added');
      expect(result[4].text).toBe('with additions');
    });

    it('should handle text without markers', () => {
      const text = 'Plain text without changes';
      const result = parseWordDiff(text);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('normal');
      expect(result[0].text).toBe('Plain text without changes');
    });

    it('should handle empty string', () => {
      const result = parseWordDiff('');
      expect(result).toHaveLength(0);
    });
  });

  describe('getLineType', () => {
    it('should identify line types by prefix', () => {
      expect(getLineType(' ')).toBe('context');
      expect(getLineType('-')).toBe('deleted');
      expect(getLineType('+')).toBe('added');
      expect(getLineType('~')).toBe('modified');
      expect(getLineType('x')).toBe('context'); // Unknown defaults to context
    });
  });
});
