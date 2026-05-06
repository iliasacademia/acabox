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
import { type FC, memo, useEffect, useMemo, useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';

import { TooltipIconButton } from './tooltip-icon-button';
import { ApprovalParagraph, ApprovalList } from './approval-buttons';
import { AnchorWithDoi, parseAgentHtml } from './doi-link';

/** Detect if content is HTML (starts with a tag like <article>, <div>, <p>, etc.) */
function looksLikeHtml(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('<') && /<\/?[a-z][\s\S]*>/i.test(trimmed);
}

/** Auto-link bare DOIs that the agent emits as plain text (e.g. "DOI: 10.x/y"). */
const DOI_RE = /\b10\.\d{4,9}\/[^\s\]<>"'(),]+/g;

function autolinkDoiText(text: string, keyPrefix: string): React.ReactNode {
  if (!text.includes('10.') || !text.includes('/')) return text;
  DOI_RE.lastIndex = 0;
  const matches = [...text.matchAll(DOI_RE)];
  if (matches.length === 0) return text;
  const out: React.ReactNode[] = [];
  let last = 0;
  matches.forEach((m, i) => {
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const doi = m[0].replace(/[.,;:]+$/, '');
    const url = `https://doi.org/${doi}`;
    // Reuse AnchorWithDoi so the bare-DOI autolink path produces the same
    // structure as <a href="..."> from Markdown / HTML responses (single
    // shared docRefInline wrapper + Zotero button). Previously this branch
    // had its own duplicated copy that would drift out of sync.
    out.push(
      <AnchorWithDoi key={`${keyPrefix}-ref-${i}`} href={url}>
        {doi}
      </AnchorWithDoi>,
    );
    last = start + doi.length;
  });
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function autolinkChildren(node: React.ReactNode, keyPrefix: string): React.ReactNode {
  if (typeof node === 'string') return autolinkDoiText(node, keyPrefix);
  if (Array.isArray(node)) return node.map((c, i) => autolinkChildren(c, `${keyPrefix}-${i}`));
  if (React.isValidElement(node)) {
    if (node.type === 'a' || node.type === 'code' || node.type === 'pre') return node;
    const props: any = node.props;
    // react-markdown maps anchor AST nodes to our `a:` override function, so the
    // element's `type` is the override (a function), not the string 'a'. Bail on
    // any element carrying an href so we don't autolink the DOI inside its label
    // and end up with two buttons stacked next to a single link.
    if (props && typeof props.href === 'string') return node;
    if (props && props.children !== undefined) {
      return React.cloneElement(
        node as any,
        undefined,
        autolinkChildren(props.children, `${keyPrefix}-c`),
      );
    }
  }
  return node;
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

  // If the text content is HTML from Writing Agent, parse it into React
  // elements so component overrides (DOI anchor → Zotero button, future
  // file-ref hover cards, approval buttons, etc.) apply the same way they do
  // for Markdown responses. dangerouslySetInnerHTML would silently drop them.
  if (text && looksLikeHtml(text)) {
    return <div className="writingAgentHtml">{parseAgentHtml(text)}</div>;
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

const ParagraphWithDoiLinks = (props: any) => {
  const children = autolinkChildren(props.children, 'p');
  return <ApprovalParagraph {...props}>{children}</ApprovalParagraph>;
};

const ListItemWithDoiLinks = (props: any) => (
  <li {...props}>{autolinkChildren(props.children, 'li')}</li>
);

const TableCellWithDoiLinks = (props: any) => (
  <td {...props}>{autolinkChildren(props.children, 'td')}</td>
);

const defaultComponents = memoizeMarkdownComponents({
  p: ParagraphWithDoiLinks as any,
  ul: ApprovalList as any,
  li: ListItemWithDoiLinks as any,
  td: TableCellWithDoiLinks as any,
  a: ({ href, children, ...props }) => (
    <AnchorWithDoi href={href} {...props}>{children}</AnchorWithDoi>
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
