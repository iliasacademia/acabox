/**
 * DOI link rendering for the desktop chat panel.
 *
 * Exports:
 *   - extractDoiFromHref — pull a DOI out of a doi.org URL (kept so callers
 *     that decorate DOI-style links can still detect them).
 *   - AnchorWithDoi — <a> wrapper that opens external URLs through the
 *     Electron shell IPC instead of letting the renderer navigate away.
 *   - parseAgentHtml — DOMPurify-sanitize an HTML response and parse it
 *     into React elements via html-react-parser, replacing <a> nodes
 *     with AnchorWithDoi so links still open externally.
 */

import React, { type FC } from 'react';
import DOMPurify from 'dompurify';
import parse, { domToReact, type DOMNode, type HTMLReactParserOptions } from 'html-react-parser';
import { IPC_CHANNELS } from '../../../../shared/types';

function openExternal(url: string): void {
  try {
    (window as any).electronAPI?.invoke(IPC_CHANNELS.OPEN_EXTERNAL_URL, url);
  } catch { /* swallow */ }
}

export const extractDoiFromHref = (href: string | undefined): string | null => {
  if (!href) return null;
  const m = href.match(/^https?:\/\/(?:dx\.)?doi\.org\/(10\.\d{4,9}\/[^\s?#]+)/i);
  return m ? m[1] : null;
};

export const AnchorWithDoi: FC<{ href?: string; children?: React.ReactNode } & Record<string, any>> = ({
  href,
  children,
  ...props
}) => (
  <a
    {...props}
    href={href}
    onClick={(e) => {
      e.preventDefault();
      if (href) openExternal(href);
    }}
  >
    {children}
  </a>
);

/**
 * Parse a Writing Agent HTML response into React elements so component-level
 * overrides apply to it the same way they apply to Markdown responses.
 * Sanitizes via DOMPurify first to preserve the security boundary that
 * `dangerouslySetInnerHTML` would otherwise drop.
 *
 * `<details>` and `<summary>` are explicitly allowed because skills wrap
 * responses in `<details class="skill-trace">` blocks.
 */
export function parseAgentHtml(html: string): React.ReactNode {
  const sanitized = DOMPurify.sanitize(html, { ADD_TAGS: ['details', 'summary'] });
  const options: HTMLReactParserOptions = {
    replace: (node: DOMNode) => {
      const el = node as { type?: string; name?: string; attribs?: Record<string, string>; children?: DOMNode[] };
      if (el.type === 'tag' && el.name === 'a') {
        const { href, ...rest } = el.attribs ?? {};
        return (
          <AnchorWithDoi href={href} {...rest}>
            {domToReact((el.children ?? []) as DOMNode[], options)}
          </AnchorWithDoi>
        );
      }
      return undefined;
    },
  };
  return parse(sanitized, options);
}
