/**
 * The seam where a quote leaves the renderer.
 *
 * The composer stores the quote on the outgoing message's
 * `metadata.custom.quote` — a path nothing else in this app reads, set by
 * library code we do not own. A typo there fails silently in the worst
 * possible way: the chip appears, the message sends, and the agent simply
 * never learns what the user was pointing at. So the extraction is pinned
 * directly rather than left to review.
 *
 * The other half of the contract is that the quote travels as its own
 * argument, NOT folded into the text — main composes the blockquote, so the
 * stored row keeps what the user typed.
 */
import type { AcaboxQuote } from '../../shared/quotes';

jest.mock('@assistant-ui/react', () => ({ useAui: () => ({}) }));
jest.mock('../coscientistAnalytics', () => ({ track: jest.fn() }));
jest.mock('../components/ModelSelector', () => ({
  getSelectedModel: () => 'claude-opus-5',
  getSelectedEffort: () => 'high',
}));

import { createElectronChatAdapter } from '../chatAdapter';

const quote: AcaboxQuote = {
  text: 'n_refs counts mentions',
  truncated: false,
  messageId: 'm-42',
  source: { kind: 'message', role: 'assistant' },
};

/** A stream that ends immediately, so `run()` completes without a turn. */
function installChatApi() {
  const sendMessage = jest.fn(() => ({
    stream: { next: () => Promise.resolve({ value: null, done: true }) },
    release: jest.fn(),
  }));
  (window as any).chatAPI = {
    sendMessage,
    stopResponding: jest.fn(),
    getTurnStatus: jest.fn().mockResolvedValue({ turnInProgress: false, sessionAlive: false }),
  };
  (window as any).toolAnalyticsAPI = { setThreadCreationPrompt: jest.fn().mockResolvedValue(undefined) };
  (window as any).debugAPI = { log: jest.fn() };
  return sendMessage;
}

/** Typed loosely so `run()` can be driven with the minimal options the adapter
 *  actually reads, as the sibling watchdog suite does. */
function makeAdapter(): any {
  const aui = { threadListItem: () => ({ initialize: async () => ({ remoteId: 'thread-1' }) }) };
  return createElectronChatAdapter(aui, { current: undefined } as any);
}

async function send(message: Record<string, unknown>) {
  const sendMessage = installChatApi();
  const adapter = makeAdapter();
  const controller = new AbortController();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of adapter.run({
    messages: [message],
    abortSignal: controller.signal,
    context: {},
  })) { /* drained */ }
  return sendMessage;
}

beforeEach(() => {
  if (!(globalThis.crypto as any)?.randomUUID) {
    (globalThis as any).crypto = { ...(globalThis.crypto ?? {}), randomUUID: () => 'uuid-test' };
  }
});
afterEach(() => jest.clearAllMocks());

describe('chatAdapter quote extraction', () => {
  const userMessage = (over: Record<string, unknown> = {}) => ({
    role: 'user',
    content: [{ type: 'text', text: 'Is that per user?' }],
    ...over,
  });

  it('reads the quote off metadata.custom.quote and passes it through', async () => {
    const sendMessage = await send(userMessage({ metadata: { custom: { quote } } }));

    const args = sendMessage.mock.calls[0] as unknown[];
    expect(args[7]).toEqual(quote);
  });

  it('sends the TYPED text, leaving composition to main', async () => {
    // Composing here as well as in main would double the blockquote; composing
    // here INSTEAD of main would put it in the stored row, where it would
    // render a second time inside the bubble.
    const sendMessage = await send(userMessage({ metadata: { custom: { quote } } }));

    const args = sendMessage.mock.calls[0] as unknown[];
    expect(args[1]).toBe('Is that per user?');
    expect(args[1]).not.toContain('>');
  });

  it('passes undefined when there is no quote, leaving the ordinary path unchanged', async () => {
    const sendMessage = await send(userMessage());

    const args = sendMessage.mock.calls[0] as unknown[];
    expect(args[7]).toBeUndefined();
  });

  it('drops a malformed quote instead of forwarding it', async () => {
    // Re-validated on both sides of the IPC boundary; this is the near side.
    const sendMessage = await send(userMessage({ metadata: { custom: { quote: { text: 'no source' } } } }));

    const args = sendMessage.mock.calls[0] as unknown[];
    expect(args[7]).toBeUndefined();
  });

  it('survives a message with no metadata at all', async () => {
    // Every message in every existing thread looks like this.
    const sendMessage = await send({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    expect(sendMessage).toHaveBeenCalled();
    expect((sendMessage.mock.calls[0] as unknown[])[7]).toBeUndefined();
  });
});
