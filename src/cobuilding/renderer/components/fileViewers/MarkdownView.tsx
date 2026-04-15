import React, { useState, type FC } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownViewProps {
  content: string;
}

type Mode = 'rendered' | 'source';

export const MarkdownView: FC<MarkdownViewProps> = ({ content }) => {
  const [mode, setMode] = useState<Mode>('rendered');

  return (
    <div className="markdownView">
      <div className="markdownViewToolbar">
        <button
          type="button"
          className={`markdownViewToggle${mode === 'rendered' ? ' markdownViewToggleActive' : ''}`}
          onClick={() => setMode('rendered')}
        >
          Rendered
        </button>
        <button
          type="button"
          className={`markdownViewToggle${mode === 'source' ? ' markdownViewToggleActive' : ''}`}
          onClick={() => setMode('source')}
        >
          Source
        </button>
      </div>
      {mode === 'rendered' ? (
        <div className="markdownViewRendered">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      ) : (
        <pre className="fileViewerPre">{content}</pre>
      )}
    </div>
  );
};
