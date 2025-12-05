/**
 * Tests for splitDiffParser utility functions
 */

import {
  parseSplitDiff,
  highlightWordChanges,
  DiffLine,
} from '../splitDiffParser';

describe('splitDiffParser', () => {
  describe('parseSplitDiff', () => {
    it('should parse context lines', () => {
      const diff = ' # Methods\n This is unchanged text';
      const result = parseSplitDiff(diff);

      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('context');
      expect(result[0].leftContent).toBe('# Methods');
      expect(result[0].rightContent).toBe('# Methods');
      expect(result[0].leftLineNumber).toBe(1);
      expect(result[0].rightLineNumber).toBe(1);
    });

    it('should parse deleted lines', () => {
      const diff = '-Old text here';
      const result = parseSplitDiff(diff);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('delete');
      expect(result[0].leftContent).toBe('Old text here');
      expect(result[0].rightContent).toBeUndefined();
      expect(result[0].leftLineNumber).toBe(1);
      expect(result[0].rightLineNumber).toBeUndefined();
    });

    it('should parse added lines', () => {
      const diff = '+New text here';
      const result = parseSplitDiff(diff);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('add');
      expect(result[0].leftContent).toBeUndefined();
      expect(result[0].rightContent).toBe('New text here');
      expect(result[0].leftLineNumber).toBeUndefined();
      expect(result[0].rightLineNumber).toBe(1);
    });

    it('should parse modified lines with word-level changes', () => {
      const diff = '~The [-original-]{+improved+} approach';
      const result = parseSplitDiff(diff);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('modify');
      expect(result[0].leftContent).toBe('The original approach');
      expect(result[0].rightContent).toBe('The improved approach');
      expect(result[0].originalContent).toBe('The [-original-]{+improved+} approach');
      expect(result[0].leftLineNumber).toBe(1);
      expect(result[0].rightLineNumber).toBe(1);
    });

    it('should skip header lines', () => {
      const diff = `--- Previous Version
+++ Current Version
@@ -5,7 +5,7 @@
 # Methods`;

      const result = parseSplitDiff(diff);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('context');
      expect(result[0].leftContent).toBe('# Methods');
    });

    it('should handle complex diff with all line types', () => {
      const diff = `--- Previous Version
+++ Current Version
@@ -1,5 +1,5 @@
 # Methods
 # Results
~The methodology describes the [-original-]{+improved+} experimental design.
-This line was completely removed.
+This line was completely added.
 # Conclusion`;

      const result = parseSplitDiff(diff);

      expect(result).toHaveLength(6);

      // Line 1: Context
      expect(result[0].type).toBe('context');
      expect(result[0].leftLineNumber).toBe(1);
      expect(result[0].rightLineNumber).toBe(1);

      // Line 2: Context
      expect(result[1].type).toBe('context');
      expect(result[1].leftLineNumber).toBe(2);
      expect(result[1].rightLineNumber).toBe(2);

      // Line 3: Modified
      expect(result[2].type).toBe('modify');
      expect(result[2].leftContent).toBe(
        'The methodology describes the original experimental design.'
      );
      expect(result[2].rightContent).toBe(
        'The methodology describes the improved experimental design.'
      );
      expect(result[2].leftLineNumber).toBe(3);
      expect(result[2].rightLineNumber).toBe(3);

      // Line 4: Deleted
      expect(result[3].type).toBe('delete');
      expect(result[3].leftContent).toBe('This line was completely removed.');
      expect(result[3].rightContent).toBeUndefined();
      expect(result[3].leftLineNumber).toBe(4);

      // Line 5: Added
      expect(result[4].type).toBe('add');
      expect(result[4].leftContent).toBeUndefined();
      expect(result[4].rightContent).toBe('This line was completely added.');
      expect(result[4].rightLineNumber).toBe(4);

      // Line 6: Context
      expect(result[5].type).toBe('context');
      expect(result[5].leftLineNumber).toBe(5);
      expect(result[5].rightLineNumber).toBe(5);
    });

    it('should handle empty string', () => {
      const result = parseSplitDiff('');
      expect(result).toHaveLength(0);
    });

    it('should maintain correct line numbers with mixed changes', () => {
      const diff = ` Line 1
-Deleted line
 Line 2
+Added line
 Line 3`;

      const result = parseSplitDiff(diff);

      expect(result).toHaveLength(5);

      // Context line 1
      expect(result[0].leftLineNumber).toBe(1);
      expect(result[0].rightLineNumber).toBe(1);

      // Deleted line
      expect(result[1].leftLineNumber).toBe(2);
      expect(result[1].rightLineNumber).toBeUndefined();

      // Context line 2
      expect(result[2].leftLineNumber).toBe(3);
      expect(result[2].rightLineNumber).toBe(2);

      // Added line
      expect(result[3].leftLineNumber).toBeUndefined();
      expect(result[3].rightLineNumber).toBe(3);

      // Context line 3
      expect(result[4].leftLineNumber).toBe(4);
      expect(result[4].rightLineNumber).toBe(4);
    });
  });

  describe('highlightWordChanges', () => {
    describe('left side (deletions)', () => {
      it('should highlight deleted words and remove additions', () => {
        const originalContent = 'Text with [-deleted-]{+added+} content';
        const result = highlightWordChanges(originalContent, 'left');

        expect(result).toHaveLength(3);
        expect(result[0].type).toBe('normal');
        expect(result[0].text).toBe('Text with ');
        expect(result[1].type).toBe('highlight');
        expect(result[1].text).toBe('deleted');
        expect(result[2].type).toBe('normal');
        expect(result[2].text).toBe(' content');
      });

      it('should handle multiple deletions', () => {
        const originalContent = 'The [-old-] approach with [-removed-] text';
        const result = highlightWordChanges(originalContent, 'left');

        expect(result).toHaveLength(5);
        expect(result[1].type).toBe('highlight');
        expect(result[1].text).toBe('old');
        expect(result[3].type).toBe('highlight');
        expect(result[3].text).toBe('removed');
      });

      it('should handle text without markers', () => {
        const originalContent = 'Plain text without changes';
        const result = highlightWordChanges(originalContent, 'left');

        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('normal');
        expect(result[0].text).toBe('Plain text without changes');
      });
    });

    describe('right side (additions)', () => {
      it('should highlight added words and remove deletions', () => {
        const originalContent = 'Text with [-deleted-]{+added+} content';
        const result = highlightWordChanges(originalContent, 'right');

        expect(result).toHaveLength(3);
        expect(result[0].type).toBe('normal');
        expect(result[0].text).toBe('Text with ');
        expect(result[1].type).toBe('highlight');
        expect(result[1].text).toBe('added');
        expect(result[2].type).toBe('normal');
        expect(result[2].text).toBe(' content');
      });

      it('should handle multiple additions', () => {
        const originalContent = 'The {+new+} approach with {+extra+} text';
        const result = highlightWordChanges(originalContent, 'right');

        expect(result).toHaveLength(5);
        expect(result[1].type).toBe('highlight');
        expect(result[1].text).toBe('new');
        expect(result[3].type).toBe('highlight');
        expect(result[3].text).toBe('extra');
      });

      it('should handle text without markers', () => {
        const originalContent = 'Plain text without changes';
        const result = highlightWordChanges(originalContent, 'right');

        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('normal');
        expect(result[0].text).toBe('Plain text without changes');
      });
    });

    it('should handle empty string', () => {
      expect(highlightWordChanges('', 'left')).toHaveLength(0);
      expect(highlightWordChanges('', 'right')).toHaveLength(0);
    });
  });

  describe('Modified line processing', () => {
    it('should correctly split modified line for both panels', () => {
      const diff = '~The [-original-]{+improved+} approach {+with better controls+}';
      const result = parseSplitDiff(diff);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('modify');

      // Left side should have: "The original approach "
      expect(result[0].leftContent).toBe('The original approach ');

      // Right side should have: "The improved approach with better controls"
      expect(result[0].rightContent).toBe(
        'The improved approach with better controls'
      );

      // Original content should be preserved
      expect(result[0].originalContent).toBe(
        'The [-original-]{+improved+} approach {+with better controls+}'
      );
    });

    it('should handle modified line with only additions', () => {
      const diff = '~Text {+with additions+}';
      const result = parseSplitDiff(diff);

      expect(result[0].leftContent).toBe('Text ');
      expect(result[0].rightContent).toBe('Text with additions');
      expect(result[0].originalContent).toBe('Text {+with additions+}');
    });

    it('should handle modified line with only deletions', () => {
      const diff = '~Text [-with deletions-]';
      const result = parseSplitDiff(diff);

      expect(result[0].leftContent).toBe('Text with deletions');
      expect(result[0].rightContent).toBe('Text ');
      expect(result[0].originalContent).toBe('Text [-with deletions-]');
    });
  });
});
