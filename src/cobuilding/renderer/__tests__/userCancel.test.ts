import { isUserCancel } from '../userCancel';

function abortError(detach: boolean): Error {
  const e = new Error('aborted') as Error & { detach: boolean };
  e.name = 'AbortError';
  e.detach = detach;
  return e;
}

describe('isUserCancel', () => {
  it('is true for the runtime cancelRun() reason (Stop)', () => {
    expect(isUserCancel(abortError(false))).toBe(true);
  });

  it('is false for a detach (thread switched while the turn runs on)', () => {
    expect(isUserCancel(abortError(true))).toBe(false);
  });

  it('is false for anything else', () => {
    expect(isUserCancel(undefined)).toBe(false);
    expect(isUserCancel(new Error('boom'))).toBe(false);
    expect(isUserCancel('AbortError')).toBe(false);
  });
});
