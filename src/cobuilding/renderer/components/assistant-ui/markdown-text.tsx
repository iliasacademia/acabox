import React from 'react';
import '@assistant-ui/react-markdown/styles/dot.css';

import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import { type FC, memo, useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';

import { TooltipIconButton } from './tooltip-icon-button';

const MarkdownTextImpl = () => {
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
  a: ({ href, children, ...props }) => (
    <a
      {...props}
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) {
          (window as any).electronAPI.invoke('shell:openExternal', href);
        }
      }}
    >
      {children}
    </a>
  ),
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
