import React, { memo, useMemo, useEffect, useRef, useState } from 'react';
import { CheckIcon, LoaderIcon, XCircleIcon } from 'lucide-react';
import type { ToolCallMessagePartComponent } from '@assistant-ui/react';
import { useToolElapsed } from '../../progressStore';

const MAX_LINES_STREAMING = 30;
const MAX_LINES_COMPLETE = 25;

function basename(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

interface WriteArgs {
  filePath?: string;
  content?: string;
  isPartial: boolean;
}

function parseWriteArgs(
  args: Record<string, unknown> | undefined,
  argsText?: string,
): WriteArgs {
  const source = args && Object.keys(args).length > 0 ? args : undefined;

  if (source) {
    return {
      filePath: source.file_path as string | undefined,
      content: source.content as string | undefined,
      isPartial: false,
    };
  }

  if (!argsText) return { isPartial: true };

  // Try full parse first
  try {
    const parsed = JSON.parse(argsText);
    return {
      filePath: parsed.file_path,
      content: parsed.content,
      isPartial: false,
    };
  } catch {
    // Partial JSON during streaming.
    // Strategy: strip any incomplete trailing escape sequence, then append `"}`
    // to close the current string value and object, and let JSON.parse do the
    // unescaping correctly. This works for the common streaming pattern:
    //   {"file_path": "...", "content": "<content streaming here...
    const filePathMatch = argsText.match(/"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const filePath = filePathMatch ? filePathMatch[1] : undefined;

    let content: string | undefined;

    if (argsText.includes('"content"')) {
      // Count trailing backslashes — an odd count means a truncated escape sequence.
      let trailingSlashes = 0;
      for (let i = argsText.length - 1; i >= 0 && argsText[i] === '\\'; i--) {
        trailingSlashes++;
      }
      const safe = trailingSlashes % 2 === 1 ? argsText.slice(0, -1) : argsText;

      // Close the open string + object and parse — this lets the JS engine
      // handle all JSON escape sequences (\n, \t, \\, \uXXXX, etc.) correctly.
      try {
        const completed = JSON.parse(safe + '"}');
        if (typeof completed?.content === 'string') {
          content = completed.content || undefined;
        }
      } catch {
        // Truncation landed on a structurally awkward spot (e.g. mid-key).
        // Fall back to manual extraction for display purposes.
        const colonIdx = argsText.indexOf(':', argsText.indexOf('"content"') + 9);
        const quoteIdx = colonIdx !== -1 ? argsText.indexOf('"', colonIdx + 1) : -1;
        if (quoteIdx !== -1) {
          const raw = argsText.slice(quoteIdx + 1);
          // Single-pass JSON unescape (correct order, no double-replacement).
          const unescaped = raw.replace(
            /\\(\\|n|t|r|"|\/|b|f|u[0-9a-fA-F]{4})/g,
            (_, seq: string) => {
              switch (seq[0]) {
                case '\\': return '\\';
                case 'n': return '\n';
                case 't': return '\t';
                case 'r': return '\r';
                case '"': return '"';
                case '/': return '/';
                case 'b': return '\b';
                case 'f': return '\f';
                default: return String.fromCharCode(parseInt(seq.slice(1), 16));
              }
            },
          );
          content = unescaped || undefined;
        }
      }
    }

    return { filePath, content, isPartial: true };
  }
}

function ContentPreview({
  content,
  isStreaming,
}: {
  content: string;
  isStreaming: boolean;
}) {
  const lines = content.split('\n');
  const lineCount = lines.length;

  if (isStreaming) {
    // Show the most recent lines so the user sees content scrolling in
    const displayLines = lines.slice(-MAX_LINES_STREAMING);
    const hiddenAbove = lineCount - displayLines.length;
    return (
      <div className="fileWriteCodeWrapper">
        {hiddenAbove > 0 && (
          <div className="fileWriteCodeOverflow">
            \u2026 {hiddenAbove} line{hiddenAbove !== 1 ? 's' : ''} above
          </div>
        )}
        <pre className="fileWriteCode">{displayLines.join('\n')}</pre>
        <span className="fileWriteCursor" />
      </div>
    );
  }

  // Complete — show first N lines with a count for the rest
  const displayLines = lines.slice(0, MAX_LINES_COMPLETE);
  const hiddenBelow = lineCount - displayLines.length;
  return (
    <div className="fileWriteCodeWrapper">
      <pre className="fileWriteCode">{displayLines.join('\n')}</pre>
      {hiddenBelow > 0 && (
        <div className="fileWriteCodeOverflow">
          \u2026 {hiddenBelow} more line{hiddenBelow !== 1 ? 's' : ''}
        </div>
      )}
    </div>
  );
}

/** Wall-clock timer: counts seconds from first render, resets when toolCallId changes. */
function useLocalElapsed(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    startRef.current = Date.now();
    setSeconds(0);
    if (!active) return;
    const id = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [active]);

  return seconds;
}

const ToolWriteImpl: ToolCallMessagePartComponent = ({
  toolCallId,
  args,
  argsText,
  status,
}: any) => {
  const isRunning = status?.type === 'running';
  const isComplete = status?.type === 'complete';
  const isError =
    status?.type === 'incomplete' && status.reason !== 'cancelled';
  const isCancelled =
    status?.type === 'incomplete' && status.reason === 'cancelled';
  const sdkElapsed = useToolElapsed(toolCallId ?? '');
  const localElapsed = useLocalElapsed(isRunning);
  // Prefer SDK-provided elapsed (updated by tool_progress events) but fall back
  // to local timer which starts from component mount — covers the model-generation
  // phase where no tool_progress events fire yet.
  const elapsed = sdkElapsed ?? (isRunning ? localElapsed : null);

  const { filePath, content, isPartial } = useMemo(
    () => parseWriteArgs(args, argsText),
    [args, argsText],
  );

  const fileName = filePath ? basename(filePath) : null;
  const lineCount = content ? content.split('\n').length : 0;
  const isStreaming = isPartial || isRunning;

  return (
    <div
      className={[
        'fileWriteCard',
        isComplete ? 'fileWriteCard--complete' : '',
        isError ? 'fileWriteCard--error' : '',
        isCancelled ? 'fileWriteCard--cancelled' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="fileWriteHeader">
        <div className="fileWriteHeaderLeft">
          {isRunning && (
            <LoaderIcon className="fileWriteIcon fileWriteIcon--running" />
          )}
          {isComplete && (
            <CheckIcon className="fileWriteIcon fileWriteIcon--complete" />
          )}
          {(isError || isCancelled) && (
            <XCircleIcon className="fileWriteIcon fileWriteIcon--error" />
          )}
          <span className="fileWriteLabel">
            {isRunning ? 'Writing' : isComplete ? 'Wrote' : 'Write'}
          </span>
          {fileName && (
            <span className="fileWriteFileName">{fileName}</span>
          )}
        </div>
        <div className="fileWriteHeaderRight">
          {isRunning && (
            <span className="fileWriteElapsed">{formatElapsed(elapsed ?? 0)}</span>
          )}
          {content && (
            <span
              className={`fileWriteLineCount${isStreaming ? ' fileWriteLineCount--streaming' : ''}`}
            >
              {lineCount} line{lineCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>
      {filePath && filePath !== fileName && (
        <div className="fileWritePath">{filePath}</div>
      )}
      {content ? (
        <ContentPreview content={content} isStreaming={isStreaming} />
      ) : isRunning ? (
        <div className="fileWriteEmpty">
          <LoaderIcon className="fileWriteEmptyIcon" />
          Starting to write\u2026
        </div>
      ) : null}
    </div>
  );
};

export const ToolWrite = memo(
  ToolWriteImpl,
) as unknown as ToolCallMessagePartComponent;
ToolWrite.displayName = 'ToolWrite';
