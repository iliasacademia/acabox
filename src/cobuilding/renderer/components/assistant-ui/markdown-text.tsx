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
import { type FC, memo, useEffect, useMemo, useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';

import { TooltipIconButton } from './tooltip-icon-button';
import { ApprovalParagraph, ApprovalList } from './approval-buttons';
import { IPC_CHANNELS } from '../../../../shared/types';

/** Detect if content is HTML (starts with a tag like <article>, <div>, <p>, etc.) */
function looksLikeHtml(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('<') && /<\/?[a-z][\s\S]*>/i.test(trimmed);
}

const DOI_RE = /\b10\.\d{4,9}\/[^\s\]<>"'(),]+/g;

function remarkDoiAutolink() {
  const transformText = (node: any, parent: any) => {
    const value: string = node.value ?? '';
    DOI_RE.lastIndex = 0;
    const matches = [...value.matchAll(DOI_RE)];
    if (matches.length === 0) return 0;
    const replacements: any[] = [];
    let last = 0;
    for (const m of matches) {
      const start = m.index ?? 0;
      if (start > last) replacements.push({ type: 'text', value: value.slice(last, start) });
      const doi = m[0].replace(/[.,;:]+$/, '');
      replacements.push({
        type: 'link',
        url: `https://doi.org/${doi}`,
        title: null,
        children: [{ type: 'text', value: doi }],
      });
      last = start + doi.length;
    }
    if (last < value.length) replacements.push({ type: 'text', value: value.slice(last) });
    const idx = parent.children.indexOf(node);
    parent.children.splice(idx, 1, ...replacements);
    return replacements.length - 1;
  };

  const walk = (node: any, parent: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'link' || node.type === 'linkReference') return;
    if (node.type === 'code' || node.type === 'inlineCode') return;
    if (node.type === 'text' && parent) {
      transformText(node, parent);
      return;
    }
    if (Array.isArray(node.children)) {
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (child.type === 'text' && node) {
          const advance = transformText(child, node);
          i += advance;
        } else {
          walk(child, node);
        }
      }
    }
  };

  return (tree: any) => walk(tree, null);
}

declare global {
  interface WindowEventMap {
    'open-file-tab': CustomEvent<{ filePath: string; lineNumber?: number }>;
  }
}

/** Matches backtick text that looks like a file path (with or without directory). */
const FILE_EXT_RE = /^(\.{0,2}\/?(?:[\w.@-]+\/)*[\w.@-]+\.(?:png|jpg|jpeg|gif|svg|webp|bmp|pdf|csv|tsv|json|jsonl|md|txt|py|r|sh|js|ts|tsx|jsx|css|html|yaml|yml|toml|sql|ipynb|xlsx|xlsm|tex|latex|log|xml|env|cfg|ini|bib|fcs|h5ad|h5|hdf5|parquet|feather|rds|rda))(?::(\d+))?$/i;

/**
 * Module-level cache: candidate text → resolved relative path.
 * Only positive results are cached. Negative results (null) are NOT cached so
 * that files the agent just created can be discovered on the next render.
 */
const resolvedPathCache = new Map<string, string>();

function useResolvedFilePath(candidate: string | null, hintDirs: string[]): string | null {
  const [resolved, setResolved] = useState<string | null>(
    () => (candidate ? (resolvedPathCache.get(candidate) ?? null) : null),
  );
  useEffect(() => {
    if (!candidate) { setResolved(null); return; }
    const cached = resolvedPathCache.get(candidate);
    if (cached !== undefined) { setResolved(cached); return; }
    let cancelled = false;
    const resolve = async () => {
      let result: string | null = null;
      if (candidate.includes('/')) {
        const exists = await (window as any).filesAPI.fileExists(candidate);
        result = exists ? candidate : null;
      } else {
        result = await (window as any).filesAPI.findByName(candidate, hintDirs);
      }
      if (result !== null) {
        resolvedPathCache.set(candidate, result);
      }
      if (!cancelled) setResolved(result);
    };
    resolve();
    return () => { cancelled = true; };
  }, [candidate]); // hintDirs intentionally excluded — first resolution wins
  return resolved;
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
      remarkPlugins={[remarkGfm, remarkDoiAutolink]}
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
  p: ApprovalParagraph as any,
  ul: ApprovalList as any,
  a: ({ href, children, ...props }) => (
    <a
      {...props}
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) {
          (window as any).electronAPI.invoke(IPC_CHANNELS.OPEN_EXTERNAL_URL, href);
        }
      }}
    >
      {children}
    </a>
  ),
  code: function Code({ className, children, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    const text = typeof children === 'string' ? children : '';
    const match = !isCodeBlock ? text.match(FILE_EXT_RE) : null;
    const candidate = match?.[1] ?? null;
    const lineNumber = match?.[2] ? parseInt(match[2], 10) : undefined;

    // Extract directory hints from message context (for bare filenames)
    const messageText = useAuiState((s: any) => {
      if (!candidate || candidate.includes('/')) return '';
      const parts = s.message?.parts;
      if (!parts) return '';
      return parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
    });

    const hintDirs = useMemo(() => {
      if (!messageText) return [];
      const dirs = new Set<string>();
      const re = /(?:[\w.@-]+\/)+/g;
      let m;
      while ((m = re.exec(messageText)) !== null) {
        dirs.add(m[0].replace(/\/$/, ''));
      }
      return Array.from(dirs);
    }, [messageText]);

    const resolvedPath = useResolvedFilePath(candidate, hintDirs);

    if (isCodeBlock) {
      return <code className={className ?? ''} {...props}>{children}</code>;
    }

    if (resolvedPath) {
      return (
        <code
          className={`inlineCode inlineCode--filePath${className ? ` ${className}` : ''}`}
          onClick={() => {
            window.dispatchEvent(new CustomEvent('open-file-tab', {
              detail: { filePath: resolvedPath, lineNumber },
            }));
          }}
          title={`Open ${resolvedPath}${lineNumber ? ` at line ${lineNumber}` : ''}`}
          {...props}
        >
          {children}
        </code>
      );
    }

    return (
      <code
        className={`inlineCode${className ? ` ${className}` : ''}`}
        {...props}
      >
        {children}
      </code>
    );
  },
  CodeHeader,
});
