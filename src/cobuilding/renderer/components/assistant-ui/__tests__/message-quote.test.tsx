/**
 * The two rendered halves of a quote, driven through real React.
 *
 * The property worth pinning is that they read the SAME object: the chip
 * reads it off the live composer, the block reads it off the message's
 * metadata, and after a reload the history converter has put the persisted
 * copy in exactly that second place. If those ever diverge, a quote will look
 * one way before sending and another way afterwards.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AcaboxQuote } from '../../../../shared/quotes';

let composerQuote: AcaboxQuote | undefined;
let messageQuote: AcaboxQuote | undefined;
const setQuote = jest.fn();

jest.mock('@assistant-ui/react', () => ({
  __esModule: true,
  useAuiState: (selector: any) => selector({ composer: { quote: composerQuote } }),
  useComposerRuntime: () => ({ setQuote }),
  useMessageQuote: () => messageQuote,
}));

import { ComposerQuoteChip, MessageQuoteBlock } from '../message-quote';

const quote = (over: Partial<AcaboxQuote> = {}): AcaboxQuote => ({
  text: 'n_refs counts mentions',
  truncated: false,
  messageId: 'm-1',
  source: { kind: 'message', role: 'assistant' },
  ...over,
});

describe('quote rendering', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    composerQuote = undefined;
    messageQuote = undefined;
    setQuote.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  const mount = async (el: React.ReactElement) => {
    await act(async () => { root.render(el); });
  };

  describe('<ComposerQuoteChip/>', () => {
    it('renders nothing when no quote is pending', async () => {
      await mount(<ComposerQuoteChip />);
      expect(container.innerHTML).toBe('');
    });

    it('shows the excerpt and its origin', async () => {
      composerQuote = quote();
      await mount(<ComposerQuoteChip />);
      expect(container.textContent).toContain('n_refs counts mentions');
      // Attribution is shown for chat prose HERE even though it is omitted
      // from what the agent receives: the user is looking at a chip detached
      // from its origin and does need reminding which one it was.
      expect(container.textContent).toContain('your earlier reply');
    });

    it('says so when the excerpt was truncated', async () => {
      composerQuote = quote({ truncated: true });
      await mount(<ComposerQuoteChip />);
      expect(container.textContent).toContain('truncated');
    });

    it('names a file quote by its path', async () => {
      composerQuote = quote({ source: { kind: 'file', path: 'MyResearch/counts.csv' } });
      await mount(<ComposerQuoteChip />);
      expect(container.textContent).toContain('MyResearch/counts.csv');
    });

    it('does not let the design system uppercase a case-sensitive path', async () => {
      // Meta lines are mono uppercase throughout this app, which is right for
      // a category ("YOUR EARLIER REPLY") and wrong for a path — it would
      // silently render MyResearch/Data.csv as MYRESEARCH/DATA.CSV. Found by
      // looking at a screenshot: the component already held the right string.
      composerQuote = quote({ source: { kind: 'file', path: 'MyResearch/Data.csv' } });
      await mount(<ComposerQuoteChip />);
      expect(container.querySelector('.cdQuoteChip__meta')!.className)
        .toContain('cdQuoteMeta--literal');
    });

    it('still uppercases a category label', async () => {
      composerQuote = quote();
      await mount(<ComposerQuoteChip />);
      expect(container.querySelector('.cdQuoteChip__meta')!.className)
        .not.toContain('cdQuoteMeta--literal');
    });

    it('clears the quote through the composer when removed', async () => {
      composerQuote = quote();
      await mount(<ComposerQuoteChip />);
      const remove = container.querySelector('.cdQuoteChip__remove') as HTMLButtonElement;
      expect(remove).toBeTruthy();

      await act(async () => { remove.click(); });

      // Cleared on the runtime, not in local state — the composer is what
      // holds the quote and what will or will not send it.
      expect(setQuote).toHaveBeenCalledWith(undefined);
    });

    it('clamps the displayed excerpt without shortening what is held', async () => {
      const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
      composerQuote = quote({ text: long });
      await mount(<ComposerQuoteChip />);
      const text = container.querySelector('.cdQuoteChip__text') as HTMLElement;
      // The clamp is visual only: all 40 lines are still in the DOM, so the
      // full excerpt is what gets sent.
      expect(text.style.webkitLineClamp).toBe('3');
      expect(text.textContent).toContain('line 39');
    });
  });

  describe('<MessageQuoteBlock/>', () => {
    it('renders nothing for a message with no quote', async () => {
      await mount(<MessageQuoteBlock text="" messageId="" />);
      expect(container.innerHTML).toBe('');
    });

    it('renders the stored quote, ignoring the narrower props the library passes', async () => {
      // The library's Quote slot hands over its own `{text, messageId}`; the
      // provenance only exists on the stored object, so the component reads
      // that instead.
      messageQuote = quote({ text: 'stored excerpt', source: { kind: 'tool', toolName: 'Bash' } });
      await mount(<MessageQuoteBlock text="props excerpt" messageId="m-1" />);
      expect(container.textContent).toContain('stored excerpt');
      expect(container.textContent).not.toContain('props excerpt');
      expect(container.textContent).toContain('the Bash tool output');
    });

    it('labels a quote identically in the chip and in the message', async () => {
      // Same object, same label — this is what makes a sent quote
      // recognisable as the thing that was in the composer a moment earlier.
      const q = quote({ truncated: true, source: { kind: 'miniapp', appDirName: 'dna', appName: 'DNA Toolkit' } });
      composerQuote = q;
      await mount(<ComposerQuoteChip />);
      const chipLabel = container.querySelector('.cdQuoteChip__meta')!.textContent;

      composerQuote = undefined;
      messageQuote = q;
      await mount(<MessageQuoteBlock text="" messageId="" />);
      const blockLabel = container.querySelector('.cdMsgQuote__meta')!.textContent;

      expect(blockLabel).toBe(chipLabel);
      expect(blockLabel).toContain('the DNA Toolkit tool');
    });
  });
});
