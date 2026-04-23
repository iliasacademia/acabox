import React from 'react';
import '@assistant-ui/react-markdown/styles/dot.css';
import '../WritingAgentView.css';

import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from '@assistant-ui/react-markdown';
import { useAuiState } from '@assistant-ui/react';
import remarkGfm from 'remark-gfm';
import DOMPurify from 'dompurify';
import { type FC, memo, useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';

import { TooltipIconButton } from './tooltip-icon-button';

/** Detect if content is HTML (starts with a tag like <article>, <div>, <p>, etc.) */
function looksLikeHtml(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('<') && /<\/?[a-z][\s\S]*>/i.test(trimmed);
}

const MarkdownTextImpl = () => {
  const text = useAuiState((s: any) => {
    const parts = s.message?.parts;
    if (!parts) return null;
    // Find the current text part's content
    const textParts = parts.filter((p: any) => p.type === 'text');
    return textParts.length > 0 ? textParts[textParts.length - 1]?.text : null;
  });

  // If the text content is HTML from Writing Agent, render it as sanitized HTML
  if (text && looksLikeHtml(text)) {
    return (
      <div
        className="writingAgentHtml"
        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(text) }}
      />
    );
  }

  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className="auiMd"
      components={defaultComponents}
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);

const CodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const onCopy = () => {
    if (!code || isCopied) return;
    copyToClipboard(code);
  };

  return (
    <div className="codeHeaderRoot">
      <span className="codeHeaderLanguage">{language}</span>
      <TooltipIconButton tooltip="Copy" onClick={onCopy}>
        {!isCopied && <CopyIcon />}
        {isCopied && <CheckIcon />}
      </TooltipIconButton>
    </div>
  );
};

const useCopyToClipboard = ({
  copiedDuration = 3000,
}: { copiedDuration?: number } = {}) => {
  const [isCopied, setIsCopied] = useState<boolean>(false);

  const copyToClipboard = (value: string) => {
    if (!value) return;
    navigator.clipboard.writeText(value).then(() => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), copiedDuration);
    });
  };

  return { isCopied, copyToClipboard };
};

const defaultComponents = memoizeMarkdownComponents({
  a: ({ href, children, ...props }) => {
    const isWordRef = href?.startsWith('word-ref:');
    return (
      <a
        {...props}
        href={href}
        style={isWordRef ? { color: '#0645b1', cursor: 'pointer', textDecoration: 'underline' } : undefined}
        onClick={(e) => {
          e.preventDefault();
          if (isWordRef) {
            // Scroll Word to the referenced text
            const anchor = href!.substring('word-ref:'.length);
            (window as any).electronAPI.invoke('word:scroll-to', anchor);
          } else if (href) {
            (window as any).electronAPI.invoke('shell:openExternal', href);
          }
        }}
      >
        {children}
      </a>
    );
  },
  code: function Code({ className, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    return (
      <code
        className={`${!isCodeBlock ? 'inlineCode' : ''}${className ? ` ${className}` : ''}`}
        {...props}
      />
    );
  },
  CodeHeader,
});
