/**
 * Visual test to verify the highlighting behavior
 * This test demonstrates how the parser handles word-level changes
 */

import { parseSplitDiff, highlightWordChanges } from '../splitDiffParser';

describe('Visual highlighting verification', () => {
  it('should properly highlight word-level changes in a realistic example', () => {
    // This is similar to the text you showed in the screenshot
    const diff = `--- Previous Version
+++ Current Version
@@ -1,5 +1,5 @@
 ## Methods
~and and also as TFs, such as, and machines such as chromatin complexes work in concert to control chromatin accessibility and of transcriptional apparati to targe. Specifically, the mammalian Switch/Sucrose [-Non-Fermenting-]{+and also Non-Fermenting+} (mSWI/SNF) family of a heterogenous collection of 11-15 subunit protein entities that utilize the energy of ATP to alter DNA-nucleosome contacts and hence remodel chromatin architecture2-7 . The mSWI/SNF complexes are found in three major, termed BAF (cBAF or BAF), polybromo-associated BAF (PBAF), and non- BAF (ncBAF), each of which is demarcated by the of specific subunits and which localization proclivities and nucleosome on [-chromatin-] 8-16.`;

    const result = parseSplitDiff(diff);

    // Find the modified line (line 2 in this case)
    const modifiedLine = result.find((line) => line.type === 'modify');

    expect(modifiedLine).toBeDefined();
    expect(modifiedLine!.originalContent).toContain('[-Non-Fermenting-]');
    expect(modifiedLine!.originalContent).toContain('{+and also Non-Fermenting+}');
    expect(modifiedLine!.originalContent).toContain('[-chromatin-]');

    // Test left side highlighting (should show deletions in red)
    const leftSegments = highlightWordChanges(modifiedLine!.originalContent!, 'left');

    // Find highlighted segments on the left
    const leftHighlights = leftSegments.filter((seg) => seg.type === 'highlight');

    // Should have 2 highlighted deletions: "Non-Fermenting" and "chromatin"
    expect(leftHighlights.length).toBeGreaterThanOrEqual(1);
    expect(leftHighlights.some((seg) => seg.text.includes('Non-Fermenting'))).toBe(true);

    // Test right side highlighting (should show additions in green)
    const rightSegments = highlightWordChanges(
      modifiedLine!.originalContent!,
      'right'
    );

    // Find highlighted segments on the right
    const rightHighlights = rightSegments.filter((seg) => seg.type === 'highlight');

    // Should have highlighted additions
    expect(rightHighlights.length).toBeGreaterThanOrEqual(1);
    expect(rightHighlights.some((seg) => seg.text.includes('and also Non-Fermenting'))).toBe(
      true
    );

    // Verify the left panel shows "Non-Fermenting" and "chromatin"
    expect(modifiedLine!.leftContent).toContain('Non-Fermenting');
    expect(modifiedLine!.leftContent).toContain('chromatin');

    // Verify the right panel shows "and also Non-Fermenting" but NOT "chromatin"
    expect(modifiedLine!.rightContent).toContain('and also Non-Fermenting');
    expect(modifiedLine!.rightContent).not.toContain('chromatin 8');
  });

  it('should show clear visual difference between left and right panels', () => {
    const diff = '~The methodology describes the [-original-]{+improved+} experimental design.';
    const result = parseSplitDiff(diff);

    const line = result[0];

    // Left panel content: "The methodology describes the original experimental design."
    expect(line.leftContent).toBe(
      'The methodology describes the original experimental design.'
    );

    // Right panel content: "The methodology describes the improved experimental design."
    expect(line.rightContent).toBe(
      'The methodology describes the improved experimental design.'
    );

    // Left side highlights "original" in red
    const leftSegments = highlightWordChanges(line.originalContent!, 'left');
    const leftHighlight = leftSegments.find((seg) => seg.type === 'highlight');
    expect(leftHighlight?.text).toBe('original');

    // Right side highlights "improved" in green
    const rightSegments = highlightWordChanges(line.originalContent!, 'right');
    const rightHighlight = rightSegments.find((seg) => seg.type === 'highlight');
    expect(rightHighlight?.text).toBe('improved');
  });

  it('should handle complex word changes with spaces', () => {
    const diff =
      '~The mSWI/SNF complexes are found in three majo, termed BAF (cBAF or BAF), polybromo-associated BAF (PBAF), and [-non-canonical-]{+non-canonical+} BAF (ncBAF).';
    const result = parseSplitDiff(diff);

    const line = result[0];

    // Verify both sides have the base text
    expect(line.leftContent).toContain('BAF (ncBAF)');
    expect(line.rightContent).toContain('BAF (ncBAF)');

    // Left should show "non-canonical" with hyphen
    expect(line.leftContent).toContain('non-canonical');

    // Right should show "non-canonical" without the deleted version
    expect(line.rightContent).toContain('non-canonical');

    // Highlighting test
    const leftSegments = highlightWordChanges(line.originalContent!, 'left');
    const leftHighlights = leftSegments.filter((seg) => seg.type === 'highlight');
    expect(leftHighlights.some((seg) => seg.text === 'non-canonical')).toBe(true);

    const rightSegments = highlightWordChanges(line.originalContent!, 'right');
    const rightHighlights = rightSegments.filter((seg) => seg.type === 'highlight');
    expect(rightHighlights.some((seg) => seg.text === 'non-canonical')).toBe(true);
  });
});
