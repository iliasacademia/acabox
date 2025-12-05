/**
 * Diff Parser Utility
 *
 * Parses custom diff format with line prefixes:
 * - ' ' (space): Unchanged context line
 * - '-': Deleted line
 * - '+': Added line
 * - '~': Modified line (with word-level markers)
 *
 * Word-level markers in modified lines:
 * - [-removed text-]: Deleted words
 * - {+added text+}: Added words
 */

export type DiffLineType = 'context' | 'deleted' | 'added' | 'modified' | 'header';

export interface DiffLine {
  type: DiffLineType;
  content: string;
  lineNumber?: number;
}

export interface ParsedDiff {
  lines: DiffLine[];
  title?: string;
  modifiedDate?: string;
  manuscriptName?: string;
}

/**
 * Parse a diff string into structured line data
 */
export function parseDiff(diffString: string): DiffLine[] {
  if (!diffString) return [];

  const lines = diffString.split('\n');
  const parsedLines: DiffLine[] = [];
  let lineNumber = 0;

  for (const line of lines) {
    if (line.length === 0) {
      // Empty line - treat as context
      parsedLines.push({
        type: 'context',
        content: '',
        lineNumber: lineNumber++,
      });
      continue;
    }

    const prefix = line[0];
    const content = line.slice(1);

    // Detect header lines (starting with @@ or ---)
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) {
      parsedLines.push({
        type: 'header',
        content: line,
      });
      continue;
    }

    let type: DiffLineType;
    switch (prefix) {
      case ' ':
        type = 'context';
        break;
      case '-':
        type = 'deleted';
        break;
      case '+':
        type = 'added';
        break;
      case '~':
        type = 'modified';
        break;
      default:
        // Unknown prefix - treat as context
        type = 'context';
    }

    parsedLines.push({
      type,
      content,
      lineNumber: lineNumber++,
    });
  }

  return parsedLines;
}

/**
 * Parse word-level diff markers in modified lines
 * Converts [-deleted-] and {+added+} markers into spans
 */
export interface WordDiffSegment {
  type: 'normal' | 'deleted' | 'added';
  text: string;
}

export function parseWordDiff(text: string): WordDiffSegment[] {
  const segments: WordDiffSegment[] = [];
  let currentPos = 0;

  // Regex to match [-...-] or {+...+}
  const regex = /(\[-[^\]]*-\]|\{\+[^}]*\+\})/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Add text before the match as normal
    if (match.index > currentPos) {
      const normalText = text.slice(currentPos, match.index);
      if (normalText) {
        segments.push({ type: 'normal', text: normalText });
      }
    }

    // Add the matched marker
    const marker = match[0];
    if (marker.startsWith('[-') && marker.endsWith('-]')) {
      // Deleted text
      segments.push({
        type: 'deleted',
        text: marker.slice(2, -2), // Remove [- and -]
      });
    } else if (marker.startsWith('{+') && marker.endsWith('+}')) {
      // Added text
      segments.push({
        type: 'added',
        text: marker.slice(2, -2), // Remove {+ and +}
      });
    }

    currentPos = match.index + marker.length;
  }

  // Add remaining text as normal
  if (currentPos < text.length) {
    const remainingText = text.slice(currentPos);
    if (remainingText) {
      segments.push({ type: 'normal', text: remainingText });
    }
  }

  return segments;
}

/**
 * Get line type from prefix character
 */
export function getLineType(prefix: string): DiffLineType {
  switch (prefix) {
    case ' ':
      return 'context';
    case '-':
      return 'deleted';
    case '+':
      return 'added';
    case '~':
      return 'modified';
    default:
      return 'context';
  }
}
