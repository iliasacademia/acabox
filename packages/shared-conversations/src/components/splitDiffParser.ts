/**
 * Split Diff Parser Utility
 *
 * Parses unified diff format into side-by-side view data structure.
 * Handles line-level changes (-, +) and word-level changes (~).
 *
 * Line Prefixes:
 * - ' ' (space): Context line (unchanged, appears in both versions)
 * - '-': Deleted line (only in previous version, left panel)
 * - '+': Added line (only in current version, right panel)
 * - '~': Modified line (has word-level changes, appears in both panels)
 *
 * Word-Level Markers:
 * - [-removed text-]: Text that was deleted (highlight in red on left)
 * - {+added text+}: Text that was added (highlight in green on right)
 */

export type DiffLineType = 'context' | 'delete' | 'add' | 'modify';

export interface DiffLine {
  type: DiffLineType;
  leftContent?: string;
  rightContent?: string;
  leftLineNumber?: number;
  rightLineNumber?: number;
  originalContent?: string; // Original content with markers for highlighting
}

/**
 * Parse unified diff format into structured side-by-side view data
 */
export function parseSplitDiff(diffText: string): DiffLine[] {
  if (!diffText) return [];

  const lines = diffText.split('\n');
  const result: DiffLine[] = [];
  let leftLineNum = 0;
  let rightLineNum = 0;

  for (const line of lines) {
    // Skip headers and empty lines
    if (
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('@@') ||
      line.trim() === ''
    ) {
      continue;
    }

    const prefix = line[0];
    const content = line.substring(1);

    switch (prefix) {
      case ' ': // Context line (unchanged)
        leftLineNum++;
        rightLineNum++;
        result.push({
          type: 'context',
          leftContent: content,
          rightContent: content,
          leftLineNumber: leftLineNum,
          rightLineNumber: rightLineNum,
        });
        break;

      case '-': // Deleted line (only on left)
        leftLineNum++;
        result.push({
          type: 'delete',
          leftContent: content,
          leftLineNumber: leftLineNum,
        });
        break;

      case '+': // Added line (only on right)
        rightLineNum++;
        result.push({
          type: 'add',
          rightContent: content,
          rightLineNumber: rightLineNum,
        });
        break;

      case '~': // Modified line with word-level changes
        leftLineNum++;
        rightLineNum++;

        // For left panel: remove {+...+} markers, keep [-...-] content without markers
        const leftContent = content
          .replace(/\{\+[^}]*\+\}/g, '') // Remove additions
          .replace(/\[-([^\]]*)\-\]/g, '$1'); // Keep deletion content without markers

        // For right panel: remove [-...-] markers, keep {+...+} content without markers
        const rightContent = content
          .replace(/\[-[^\]]*\-\]/g, '') // Remove deletions
          .replace(/\{\+([^}]*)\+\}/g, '$1'); // Keep addition content without markers

        result.push({
          type: 'modify',
          leftContent,
          rightContent,
          leftLineNumber: leftLineNum,
          rightLineNumber: rightLineNum,
          originalContent: content, // Store original for highlighting
        });
        break;

      default:
        // Unknown prefix - treat as context
        leftLineNum++;
        rightLineNum++;
        result.push({
          type: 'context',
          leftContent: content,
          rightContent: content,
          leftLineNumber: leftLineNum,
          rightLineNumber: rightLineNum,
        });
    }
  }

  return result;
}

/**
 * Highlight word-level changes within a line
 * For left panel: highlights [-text-] markers in red
 * For right panel: highlights {+text+} markers in green
 * Takes the ORIGINAL content with markers and processes it appropriately for each side
 */
export interface HighlightSegment {
  type: 'normal' | 'highlight';
  text: string;
}

export function highlightWordChanges(
  originalContent: string,
  side: 'left' | 'right'
): HighlightSegment[] {
  const segments: HighlightSegment[] = [];

  if (side === 'left') {
    // For left side: highlight [-text-] in red, remove {+text+}
    // Process the string step by step
    let position = 0;
    const regex = /(\[-[^\]]*\-\]|\{\+[^}]*\+\})/g;
    let match;

    while ((match = regex.exec(originalContent)) !== null) {
      // Add text before match as normal
      if (match.index > position) {
        const normalText = originalContent.slice(position, match.index);
        if (normalText) {
          segments.push({ type: 'normal', text: normalText });
        }
      }

      const marker = match[0];
      if (marker.startsWith('[-') && marker.endsWith('-]')) {
        // This is a deletion - highlight it in red
        const text = marker.slice(2, -2);
        segments.push({ type: 'highlight', text });
      }
      // If it's {+...+}, skip it (don't add anything)

      position = match.index + marker.length;
    }

    // Add remaining text
    if (position < originalContent.length) {
      const remainingText = originalContent.slice(position);
      if (remainingText) {
        segments.push({ type: 'normal', text: remainingText });
      }
    }
  } else {
    // For right side: highlight {+text+} in green, remove [-text-]
    let position = 0;
    const regex = /(\[-[^\]]*\-\]|\{\+[^}]*\+\})/g;
    let match;

    while ((match = regex.exec(originalContent)) !== null) {
      // Add text before match as normal
      if (match.index > position) {
        const normalText = originalContent.slice(position, match.index);
        if (normalText) {
          segments.push({ type: 'normal', text: normalText });
        }
      }

      const marker = match[0];
      if (marker.startsWith('{+') && marker.endsWith('+}')) {
        // This is an addition - highlight it in green
        const text = marker.slice(2, -2);
        segments.push({ type: 'highlight', text });
      }
      // If it's [-...-], skip it (don't add anything)

      position = match.index + marker.length;
    }

    // Add remaining text
    if (position < originalContent.length) {
      const remainingText = originalContent.slice(position);
      if (remainingText) {
        segments.push({ type: 'normal', text: remainingText });
      }
    }
  }

  // If no segments were added, return the cleaned content as normal
  if (segments.length === 0 && originalContent) {
    // Clean the content based on side
    const cleanedContent =
      side === 'left'
        ? originalContent
            .replace(/\{\+[^}]*\+\}/g, '')
            .replace(/\[-([^\]]*)\-\]/g, '$1')
        : originalContent
            .replace(/\[-[^\]]*\-\]/g, '')
            .replace(/\{\+([^}]*)\+\}/g, '$1');

    if (cleanedContent) {
      segments.push({ type: 'normal', text: cleanedContent });
    }
  }

  return segments;
}

/**
 * Extract the original content with word-level markers for modified lines
 * This is used internally to parse the raw ~ line before splitting into left/right
 */
export function extractOriginalModifiedContent(line: string): string {
  return line.substring(1); // Remove the ~ prefix
}
