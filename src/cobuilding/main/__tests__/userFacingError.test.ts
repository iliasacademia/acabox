import { splitErrorDetails } from '../../shared/errorDetails';
import {
  API_KEY_REJECTED,
  ASSISTANT_NOT_RESPONDING,
  toUserFacingError,
} from '../userFacingError';

describe('toUserFacingError', () => {
  it('turns an unhealthy agent server into a plain headline with the raw text as details', () => {
    const out = toUserFacingError('Agent server failed to become healthy within 15s');
    const { headline, details } = splitErrorDetails(out);
    expect(headline).toBe(ASSISTANT_NOT_RESPONDING);
    expect(details).toBe('Agent server failed to become healthy within 15s');
  });

  it('classifies the exit-before-healthy and connection-refused variants the same way', () => {
    for (const raw of [
      'Agent server exited before becoming healthy (code=1, signal=null)',
      'connect ECONNREFUSED 127.0.0.1:23200',
      'fetch failed',
    ]) {
      expect(splitErrorDetails(toUserFacingError(raw)).headline).toBe(ASSISTANT_NOT_RESPONDING);
    }
  });

  it('never shows an HTTP status as the headline for a rejected key', () => {
    const { headline, details } = splitErrorDetails(toUserFacingError('Failed to authenticate. API Error: 401'));
    expect(headline).toBe(API_KEY_REJECTED);
    expect(details).toContain('401');
  });

  it('maps an empty or "Unknown agent error" message to the not-responding headline', () => {
    expect(toUserFacingError('Unknown agent error')).toBe(ASSISTANT_NOT_RESPONDING);
    expect(toUserFacingError('')).toBe(ASSISTANT_NOT_RESPONDING);
    expect(toUserFacingError(undefined)).toBe(ASSISTANT_NOT_RESPONDING);
  });

  it('passes through sentences the host already wrote in plain words', () => {
    for (const plain of [
      API_KEY_REJECTED,
      'No Anthropic API key configured. Add one in Settings.',
      'The assistant stopped and could not be restarted. Quit and reopen Acabox.',
    ]) {
      expect(toUserFacingError(plain)).toBe(plain);
    }
  });

  it('hides unrecognised raw text behind details rather than leading with it', () => {
    const { headline, details } = splitErrorDetails(toUserFacingError('TypeError: x is not a function at /Users/me/app.js:1'));
    expect(headline).not.toContain('TypeError');
    expect(details).toContain('TypeError');
  });

  it('explains an out-of-credit account and a busy service in words', () => {
    expect(toUserFacingError('Your credit balance is too low to access the API')).toMatch(/run out of credit/);
    expect(toUserFacingError('529 overloaded_error')).toMatch(/busy/);
  });
});
