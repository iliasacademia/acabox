/**
 * Split Diff Viewer Component
 *
 * Displays diffs in a side-by-side view with:
 * - Left panel: Previous version
 * - Right panel: Current version
 * - Word-level highlighting for modified lines
 */

import React, { useMemo } from 'react';
import {
  parseSplitDiff,
  highlightWordChanges,
  DiffLine,
} from './splitDiffParser';

interface SplitDiffViewerProps {
  diffText: string;
}

/**
 * Renders highlighted text segments for word-level changes
 * Uses the original content with markers to properly highlight changes
 */
const HighlightedText: React.FC<{
  originalContent: string;
  side: 'left' | 'right';
}> = ({ originalContent, side }) => {
  const segments = useMemo(
    () => highlightWordChanges(originalContent, side),
    [originalContent, side]
  );

  if (segments.length === 0) {
    return <></>;
  }

  return (
    <>
      {segments.map((segment, index) => {
        if (segment.type === 'highlight') {
          return (
            <mark
              key={index}
              className={side === 'left' ? 'deletion' : 'addition'}
            >
              {segment.text}
            </mark>
          );
        }
        return <span key={index}>{segment.text}</span>;
      })}
    </>
  );
};

/**
 * Renders a single line in the diff view
 */
const DiffLineComponent: React.FC<{
  line: DiffLine;
  side: 'left' | 'right';
}> = ({ line, side }) => {
  const isLeft = side === 'left';
  const content = isLeft ? line.leftContent : line.rightContent;
  const lineNumber = isLeft ? line.leftLineNumber : line.rightLineNumber;

  // Determine if this line should be rendered (or shown as empty space)
  const shouldRender =
    line.type === 'context' ||
    line.type === 'modify' ||
    (line.type === 'delete' && isLeft) ||
    (line.type === 'add' && !isLeft);

  if (!shouldRender) {
    // Show empty space to maintain alignment
    return <div className="diff-line empty-line" />;
  }

  // Determine the CSS class based on line type
  let lineClass = 'diff-line';
  if (line.type === 'context') {
    lineClass += ' context';
  } else if (line.type === 'delete') {
    lineClass += ' deletion';
  } else if (line.type === 'add') {
    lineClass += ' addition';
  } else if (line.type === 'modify') {
    lineClass += ' modification';
  }

  return (
    <div className={lineClass}>
      <span className="line-number">{lineNumber}</span>
      <span className="line-content">
        {line.type === 'modify' && line.originalContent ? (
          <HighlightedText originalContent={line.originalContent} side={side} />
        ) : (
          content
        )}
      </span>
    </div>
  );
};

/**
 * Main split diff viewer component
 */
export const SplitDiffViewer: React.FC<SplitDiffViewerProps> = ({
  diffText,
}) => {
  const lines = useMemo(() => {
    if (!diffText) return [];
    try {
      return parseSplitDiff(diffText);
    } catch (error) {
      console.error('[SplitDiffViewer] Failed to parse diff:', error);
      return [];
    }
  }, [diffText]);

  if (lines.length === 0) {
    return <div className="diff-empty-state">No changes to display</div>;
  }

  return (
    <div className="split-diff-container">
      {/* Header */}
      <div className="split-diff-header">
        <div className="panel-header left-panel-header">Previous Version</div>
        <div className="panel-header right-panel-header">Current Version</div>
      </div>

      {/* Content */}
      <div className="split-diff-content">
        {/* Left Panel */}
        <div className="diff-panel left-panel">
          {lines.map((line, index) => (
            <DiffLineComponent key={`left-${index}`} line={line} side="left" />
          ))}
        </div>

        {/* Right Panel */}
        <div className="diff-panel right-panel">
          {lines.map((line, index) => (
            <DiffLineComponent
              key={`right-${index}`}
              line={line}
              side="right"
            />
          ))}
        </div>
      </div>
    </div>
  );
};

export default SplitDiffViewer;
