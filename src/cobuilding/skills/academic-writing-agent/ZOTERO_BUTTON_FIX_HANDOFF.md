# Bug: Zotero "add to library" button missing on Writing Agent HTML responses

## Symptom

When the academic-writing-agent skill loads and emits a structured HTML response (anything starting with `<details>`, `<article>`, etc.), DOI links inside the response don't get the green "add to Zotero" / "open in Zotero" button next to them. The same DOI links — when the same agent emits Markdown instead of HTML — render with the button correctly.

## Cause

`src/cobuilding/renderer/components/assistant-ui/markdown-text.tsx` has two render paths inside `MarkdownTextImpl` (around line 337):

```tsx
if (text && looksLikeHtml(text)) {
  return (
    <div
      className="writingAgentHtml"
      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(text) }}
    />
  );
}
return <MarkdownTextPrimitive ... />;
```

The Zotero button is added by the React `<a>` component override registered on the **Markdown path** (around line 409). The override detects `https://doi.org/...` hrefs and wraps the link with `<ZoteroAddRefButton />`.

`dangerouslySetInnerHTML` renders raw HTML directly into the DOM. It does not run any of the React component overrides — so DOI links in HTML responses never see the override and never get the button.

This will keep biting us as we add more React-component features to the chat (file references, approval buttons, etc.) — anything keyed on a markdown component override silently disappears for HTML responses.

## Fix

Replace `dangerouslySetInnerHTML` with `html-react-parser`, which parses HTML into React elements and lets us reuse the same `<a>` override the Markdown path uses.

### Step 1 — install

```
npm install html-react-parser
```

### Step 2 — extract the DOI-aware anchor into a reusable component

So both render paths share it:

```tsx
const extractDoiFromHref = (href: string | undefined): string | null => {
  if (!href) return null;
  const m = href.match(/^https?:\/\/(?:dx\.)?doi\.org\/(10\.\d{4,9}\/[^\s?#]+)/i);
  return m ? m[1] : null;
};

const AnchorWithDoi: FC<{ href?: string; children?: React.ReactNode } & Record<string, any>> = ({
  href, children, ...props
}) => {
  const doi = extractDoiFromHref(href);
  const link = (
    <a
      {...props}
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) (window as any).electronAPI.invoke(IPC_CHANNELS.OPEN_EXTERNAL_URL, href);
      }}
    >
      {children}
    </a>
  );
  if (!doi) return link;
  return (
    <span className="docRefInline">
      {link}
      <ZoteroAddRefButton doi={doi} />
    </span>
  );
};
```

Then change the `a:` entry in `defaultComponents` (line 409) to:

```tsx
a: ({ href, children, ...props }) => (
  <AnchorWithDoi href={href} {...props}>{children}</AnchorWithDoi>
),
```

### Step 3 — add an HTML parser helper

```tsx
import parse, { domToReact, type DOMNode, type HTMLReactParserOptions, Element } from 'html-react-parser';

function parseAgentHtml(html: string): React.ReactNode {
  const sanitized = DOMPurify.sanitize(html, { ADD_TAGS: ['details', 'summary'] });
  const options: HTMLReactParserOptions = {
    replace: (node: DOMNode) => {
      if (node instanceof Element && node.name === 'a') {
        const { href, ...rest } = node.attribs ?? {};
        return (
          <AnchorWithDoi href={href} {...rest}>
            {domToReact(node.children as DOMNode[], options)}
          </AnchorWithDoi>
        );
      }
      return undefined;
    },
  };
  return parse(sanitized, options);
}
```

### Step 4 — swap the HTML branch

```tsx
if (text && looksLikeHtml(text)) {
  return <div className="writingAgentHtml">{parseAgentHtml(text)}</div>;
}
```

DOMPurify still runs (so the security guarantee from `dangerouslySetInnerHTML` is preserved); we just feed its output through a parser that respects React component overrides instead of dropping it straight into the DOM.

## Why this is the right fix

- **Unifies the two paths.** Today, every React enhancement we add to chat (Zotero button, file-ref hover cards, approval buttons) silently doesn't apply to HTML responses. Fixing it once at the parser layer makes them all work everywhere.
- **No regression risk on Markdown responses.** The Markdown path is unchanged — it still uses `MarkdownTextPrimitive`. We just move the `<a>` logic into a small reusable component that both paths import.
- **Preserves DOMPurify sanitization.** The security boundary is identical to what's there today.
- **Small footprint.** ~30 lines of new code, one new dep (`html-react-parser`, ~70KB).

## Validation

The change was prototyped locally and verified:
- `npm run typecheck` clean
- `npx eslint src/cobuilding/renderer/components/assistant-ui/markdown-text.tsx` clean

Manual test plan after the change lands:

1. Trigger a Cite response in the academic-writing-agent skill (e.g. select a phrase like "Chain-of-Thought" and prompt "find papers on this topic"). The response is HTML (`<details><article>...`) with DOI links inside `<section class="citation-claim">`.
2. Verify each DOI link now shows the green "+" / checkmark Zotero button next to it, identical to how Markdown responses render.
3. Trigger any Markdown response (e.g. ask a non-skill question) and verify it still works — buttons should appear unchanged.
4. Trigger a non-DOI link in either path and verify it renders as a plain link with no button, as before.
