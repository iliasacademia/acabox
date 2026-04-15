import React, { useEffect, useMemo, useRef, useState, type FC } from 'react';
import { parse, HtmlGenerator } from 'latex.js';
// NOTE: latex.js ships base/article/katex CSS in dist/css, but its package.json
// `exports` field doesn't expose them, and the CSS references ~30 woff2 font
// files via relative url(). We rely on inherited typography for now; math
// renders structurally but without proper KaTeX font glyphs.

interface LatexViewProps {
  content: string;
}

type Mode = 'rendered' | 'source';

export const LatexView: FC<LatexViewProps> = ({ content }) => {
  const [mode, setMode] = useState<Mode>('rendered');

  // Parse once per content change — even if the user toggles to source and back,
  // we don't want to re-parse the document.
  const parsed = useMemo(() => {
    try {
      const generator = new HtmlGenerator({ hyphenate: false });
      const doc = parse(preprocessLatex(content), { generator }).htmlDocument();
      return { ok: true as const, body: doc.body, head: doc.head };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }, [content]);

  return (
    <div className="latexView">
      <div className="latexViewToolbar">
        <button
          type="button"
          className={`latexViewToggle${mode === 'rendered' ? ' latexViewToggleActive' : ''}`}
          onClick={() => setMode('rendered')}
        >
          Rendered
        </button>
        <button
          type="button"
          className={`latexViewToggle${mode === 'source' ? ' latexViewToggleActive' : ''}`}
          onClick={() => setMode('source')}
        >
          Source
        </button>
      </div>
      {mode === 'rendered' ? (
        parsed.ok ? (
          <LatexRendered body={parsed.body} />
        ) : (
          <div className="latexViewError">
            <p>Could not render this LaTeX document:</p>
            <pre className="fileViewerPre">{parsed.error}</pre>
          </div>
        )
      ) : (
        <pre className="fileViewerPre">{content}</pre>
      )}
    </div>
  );
};

/**
 * latex.js produces an `HTMLElement` for the document body. We attach it
 * directly via a ref instead of serializing to a string, which preserves
 * any inline styles, scripts, and event handlers latex.js sets up
 * (e.g., for hyperlinks, footnote popovers).
 */
const LatexRendered: FC<{ body: HTMLElement }> = ({ body }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    node.replaceChildren(body);
    return () => {
      node.replaceChildren();
    };
  }, [body]);

  return <div ref={containerRef} className="latexViewRendered" />;
};

/**
 * latex.js doesn't bundle the amsmath package, so common display-math
 * environments (`equation`, `align`, `gather`, `eqnarray`) raise
 * "unknown environment" errors. KaTeX — which latex.js uses for math —
 * does understand `aligned` / `gathered` / etc. *inside* `\[...\]`, so we
 * rewrite the offending blocks into KaTeX-friendly equivalents before parsing.
 *
 * Starred variants (`equation*`, `align*`, ...) suppress equation numbering
 * in real LaTeX; here we treat them the same since latex.js doesn't number
 * equations anyway.
 */
function preprocessLatex(source: string): string {
  return source
    .replace(/\\begin\{equation\*?\}/g, '\\[')
    .replace(/\\end\{equation\*?\}/g, '\\]')
    .replace(/\\begin\{align\*?\}/g, '\\[\\begin{aligned}')
    .replace(/\\end\{align\*?\}/g, '\\end{aligned}\\]')
    .replace(/\\begin\{gather\*?\}/g, '\\[\\begin{gathered}')
    .replace(/\\end\{gather\*?\}/g, '\\end{gathered}\\]')
    .replace(/\\begin\{eqnarray\*?\}/g, '\\[\\begin{aligned}')
    .replace(/\\end\{eqnarray\*?\}/g, '\\end{aligned}\\]');
}
