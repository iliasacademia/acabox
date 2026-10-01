import { interpretKeyCheck, maskApiKey, buildApiKeyStatus } from '../apiKeyCheck';

describe('interpretKeyCheck', () => {
  it.each([200, 204])('accepts %i', (status) => {
    expect(interpretKeyCheck({ status })).toEqual({ verdict: 'accepted' });
  });
  it.each([401, 403])('rejects %i', (status) => {
    expect(interpretKeyCheck({ status }).verdict).toBe('rejected');
  });
  it.each([400, 404, 429, 500, 529])('does not judge the key on %i', (status) => {
    const r = interpretKeyCheck({ status });
    expect(r.verdict).toBe('unconfirmed');
    expect(r.detail).toBeTruthy();
  });
  it('treats a network error as unconfirmed and keeps the text', () => {
    expect(interpretKeyCheck({ error: 'ENOTFOUND' })).toEqual({ verdict: 'unconfirmed', detail: 'ENOTFOUND' });
  });
});

describe('status response', () => {
  const key = 'sk-ant-api03-SECRETSECRETSECRET-abcd';
  it('masks to prefix and last 4', () => {
    expect(maskApiKey(key)).toBe('sk-ant-api…abcd');
    expect(maskApiKey(null)).toBeNull();
  });
  it('never contains the key', () => {
    const s = buildApiKeyStatus({ apiKey: key, source: 'settings' });
    expect(JSON.stringify(s)).not.toContain('SECRETSECRET');
    expect(s.hasKey).toBe(true);
  });
});
