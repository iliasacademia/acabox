import { DEFAULT_SESSION_TITLE, isPlaceholderTitle } from '../sessionTitle';
import { splitErrorDetails, withErrorDetails } from '../errorDetails';

describe('isPlaceholderTitle', () => {
  it('uses sentence case for new chats', () => {
    expect(DEFAULT_SESSION_TITLE).toBe('New chat');
  });

  it('accepts both spellings, because stored rows keep the old one', () => {
    expect(isPlaceholderTitle('New chat')).toBe(true);
    expect(isPlaceholderTitle('New Chat')).toBe(true);
  });

  it('treats a missing or blank title as the placeholder', () => {
    expect(isPlaceholderTitle(undefined)).toBe(true);
    expect(isPlaceholderTitle(null)).toBe(true);
    expect(isPlaceholderTitle('   ')).toBe(true);
  });

  it('does not treat a real title as the placeholder', () => {
    expect(isPlaceholderTitle('Traffic based on knowledge')).toBe(false);
    expect(isPlaceholderTitle('New chat about qPCR')).toBe(false);
  });
});

describe('error details', () => {
  it('round-trips a headline and its raw details', () => {
    const joined = withErrorDetails('Something went wrong.', 'ECONNREFUSED 127.0.0.1:23200');
    expect(splitErrorDetails(joined)).toEqual({
      headline: 'Something went wrong.',
      details: 'ECONNREFUSED 127.0.0.1:23200',
    });
  });

  it('adds nothing when there are no details or they repeat the headline', () => {
    expect(withErrorDetails('Plain.', '')).toBe('Plain.');
    expect(withErrorDetails('Plain.', 'Plain.')).toBe('Plain.');
    expect(splitErrorDetails('Plain.')).toEqual({ headline: 'Plain.', details: null });
  });
});
