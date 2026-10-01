/** @jest-environment node */
import { checkAnthropicKey } from '../apiKeyCheck';

const stub = (impl: (url: string, init: RequestInit) => Promise<{ status: number }>) =>
  jest.fn(impl as any) as unknown as typeof fetch & jest.Mock;

describe('checkAnthropicKey', () => {
  it('sends the key to /v1/models?limit=1 on the default host', async () => {
    const f = stub(async () => ({ status: 200 }));
    expect((await checkAnthropicKey('k', undefined, f)).verdict).toBe('accepted');
    const [url, init] = (f as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=1');
    expect((init as any).headers['x-api-key']).toBe('k');
  });
  it('respects a configured base URL', async () => {
    const f = stub(async () => ({ status: 401 }));
    expect((await checkAnthropicKey('k', 'http://127.0.0.1:9/', f)).verdict).toBe('rejected');
    expect((f as jest.Mock).mock.calls[0][0]).toBe('http://127.0.0.1:9/v1/models?limit=1');
  });
  it('turns a thrown error into unconfirmed', async () => {
    const f = stub(async () => { throw new Error('offline'); });
    expect(await checkAnthropicKey('k', undefined, f)).toEqual({ verdict: 'unconfirmed', detail: 'offline' });
  });
});
