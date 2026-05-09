import React, { type FC } from 'react';
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light';
import javascriptLang from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import jsxLang from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import typescriptLang from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import tsxLang from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import pythonLang from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import jsonLang from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import rLang from 'react-syntax-highlighter/dist/esm/languages/prism/r';
import markupLang from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import oneLight from 'react-syntax-highlighter/dist/esm/styles/prism/one-light';

SyntaxHighlighter.registerLanguage('javascript', javascriptLang);
SyntaxHighlighter.registerLanguage('jsx', jsxLang);
SyntaxHighlighter.registerLanguage('typescript', typescriptLang);
SyntaxHighlighter.registerLanguage('tsx', tsxLang);
SyntaxHighlighter.registerLanguage('python', pythonLang);
SyntaxHighlighter.registerLanguage('json', jsonLang);
SyntaxHighlighter.registerLanguage('r', rLang);
SyntaxHighlighter.registerLanguage('markup', markupLang);

export function languageForPath(path: string): string | null {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = lower.slice(dot + 1);
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': return 'javascript';
    case 'jsx': return 'jsx';
    case 'ts': return 'typescript';
    case 'tsx': return 'tsx';
    case 'py': return 'python';
    case 'json': return 'json';
    case 'r': return 'r';
    case 'html': case 'htm': return 'markup';
    default: return null;
  }
}

const CUSTOM_STYLE: React.CSSProperties = {
  margin: 0,
  padding: 0,
  background: 'transparent',
  backgroundColor: 'transparent',
  borderLeft: 'none',
  boxShadow: 'none',
  fontSize: '0.8125rem',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  overflowWrap: 'anywhere',
};

const CODE_TAG_PROPS = {
  style: {
    fontFamily: 'inherit',
    fontSize: 'inherit',
    background: 'transparent',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    overflowWrap: 'anywhere',
  } as React.CSSProperties,
};

export const CodeView: FC<{
  content: string;
  path?: string;
  language?: string | null;
  fallbackClassName?: string;
}> = ({ content, path, language, fallbackClassName }) => {
  const resolved = language ?? (path ? languageForPath(path) : null);
  if (!resolved) {
    return <pre className={fallbackClassName}>{content}</pre>;
  }
  return (
    <SyntaxHighlighter
      language={resolved}
      style={oneLight}
      customStyle={CUSTOM_STYLE}
      codeTagProps={CODE_TAG_PROPS}
    >
      {content}
    </SyntaxHighlighter>
  );
};
