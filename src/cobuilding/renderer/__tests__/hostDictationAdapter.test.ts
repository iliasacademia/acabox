import { createHostDictationAdapter, describeDictationError } from '../hostDictationAdapter';

/**
 * The adapter's job is translating the helper's event stream into the shape
 * assistant-ui's composer runtime consumes. Everything that can go wrong here
 * is a transcript bug the user sees directly — duplicated words, a lost final
 * clause, a composer stuck in "recording" — so the ordering rules are pinned
 * explicitly rather than left to integration testing.
 */

type Emit = (event: any) => void;

function installFakeHost(): {
  emit: Emit;
  start: jest.Mock;
  stop: jest.Mock;
  setStartResult: (r: { ok: boolean; error?: string }) => void;
} {
  const listeners = new Set<(event: any) => void>();
  let startResult: { ok: boolean; error?: string } = { ok: true };

  const start = jest.fn(async () => startResult);
  const stop = jest.fn(async () => ({ ok: true }));

  (window as any).dictationAPI = {
    probe: jest.fn(async () => ({ available: true, engine: 'transcriber' })),
    start,
    stop,
    onEvent: (cb: (event: any) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };

  return {
    emit: (event) => listeners.forEach((l) => l(event)),
    start,
    stop,
    setStartResult: (r) => {
      startResult = r;
    },
  };
}

/** Records the calls the composer runtime would make against a session. */
function observe(session: any) {
  const speech: Array<{ transcript: string; isFinal?: boolean }> = [];
  const ended: Array<{ transcript: string }> = [];
  let startedCount = 0;
  session.onSpeech((r: any) => speech.push(r));
  session.onSpeechStart(() => { startedCount += 1; });
  session.onSpeechEnd((r: any) => ended.push(r));
  return { speech, ended, get started() { return startedCount; } };
}

describe('hostDictationAdapter', () => {
  let host: ReturnType<typeof installFakeHost>;
  let errors: string[];

  beforeEach(() => {
    host = installFakeHost();
    errors = [];
  });

  const makeSession = () =>
    createHostDictationAdapter({ onError: (m) => errors.push(m) }).listen() as any;

  it('starts the host session on listen()', () => {
    makeSession();
    expect(host.start).toHaveBeenCalledWith('en-US');
  });

  it('begins in `starting` and flips to `running` only once listening', () => {
    const session = makeSession();
    const seen = observe(session);

    expect(session.status).toEqual({ type: 'starting' });
    expect(seen.started).toBe(0);

    host.emit({ type: 'listening' });

    expect(session.status).toEqual({ type: 'running' });
    expect(seen.started).toBe(1);
  });

  it('maps partials to interim results (isFinal false)', () => {
    const session = makeSession();
    const seen = observe(session);

    host.emit({ type: 'partial', text: 'plot the' });
    host.emit({ type: 'partial', text: 'plot the assay' });

    // Cumulative, not delta — the runtime replaces the tail each time, so
    // marking these final would concatenate and produce
    // "plot the plot the assay".
    expect(seen.speech).toEqual([
      { transcript: 'plot the', isFinal: false },
      { transcript: 'plot the assay', isFinal: false },
    ]);
  });

  it('commits the final transcript BEFORE ending the session', () => {
    const session = makeSession();
    const seen = observe(session);

    host.emit({ type: 'partial', text: 'plot the assay' });
    host.emit({ type: 'final', text: 'plot the assay results' });

    // Ordering is load-bearing: the runtime tears the session down inside
    // onSpeechEnd, so a final transcript delivered afterwards is discarded and
    // the user watches their last words disappear on stop.
    const finalIndex = seen.speech.findIndex((r) => r.isFinal);
    expect(finalIndex).toBeGreaterThanOrEqual(0);
    expect(seen.speech[finalIndex]).toEqual({
      transcript: 'plot the assay results',
      isFinal: true,
    });
    expect(seen.ended).toHaveLength(1);
    expect(session.status).toEqual({ type: 'ended', reason: 'stopped' });
  });

  it('does not emit an empty final result', () => {
    const session = makeSession();
    const seen = observe(session);

    host.emit({ type: 'final', text: '' });

    // Pressing the mic and saying nothing should leave the composer untouched,
    // not append a separator to whatever the user had typed.
    expect(seen.speech).toHaveLength(0);
    expect(seen.ended).toHaveLength(1);
  });

  it('ends the session when the helper dies without a final', () => {
    const session = makeSession();
    const seen = observe(session);

    host.emit({ type: 'stopped' });

    expect(session.status).toEqual({ type: 'ended', reason: 'stopped' });
    expect(seen.ended).toHaveLength(1);
  });

  it('surfaces helper errors and ends the session', () => {
    const session = makeSession();
    host.emit({ type: 'error', code: 'mic-denied', message: 'raw message' });

    expect(session.status).toEqual({ type: 'ended', reason: 'error' });
    // Actionable copy, not the helper's phrasing.
    expect(errors[0]).toContain('System Settings');
  });

  it('reports a refused start', async () => {
    host.setStartResult({ ok: false, error: 'Dictation helper not built.' });
    const session = makeSession();
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toContain('Dictation helper not built.');
    expect(session.status).toEqual({ type: 'ended', reason: 'error' });
  });

  it('stop() waits for the final transcript before resolving', async () => {
    const session = makeSession();
    const seen = observe(session);
    host.emit({ type: 'listening' });

    let resolved = false;
    const pending = session.stop().then(() => { resolved = true; });
    await Promise.resolve();
    await Promise.resolve();

    // Resolving early makes the runtime tear down before the helper has
    // flushed the tail of the utterance.
    expect(resolved).toBe(false);
    expect(host.stop).toHaveBeenCalled();

    host.emit({ type: 'final', text: 'run the analysis' });
    await pending;

    expect(resolved).toBe(true);
    expect(seen.speech[seen.speech.length - 1]).toEqual({
      transcript: 'run the analysis',
      isFinal: true,
    });
  });

  it('stop() gives up after a timeout so a dead helper cannot wedge the composer', async () => {
    jest.useFakeTimers();
    try {
      const session = makeSession();
      host.emit({ type: 'listening' });

      let resolved = false;
      const pending = session.stop().then(() => { resolved = true; });
      await Promise.resolve();
      await Promise.resolve();
      expect(resolved).toBe(false);

      jest.advanceTimersByTime(3100);
      await pending;

      expect(resolved).toBe(true);
      expect(session.status).toEqual({ type: 'ended', reason: 'stopped' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancel() ends with reason `cancelled`', () => {
    const session = makeSession();
    session.cancel();
    expect(session.status).toEqual({ type: 'ended', reason: 'cancelled' });
    expect(host.stop).toHaveBeenCalled();
  });

  it('ignores events after the session has ended', () => {
    const session = makeSession();
    const seen = observe(session);

    host.emit({ type: 'final', text: 'done' });
    const afterFinal = seen.speech.length;

    // A second session's events must never leak into a torn-down one.
    host.emit({ type: 'partial', text: 'later utterance' });

    expect(seen.speech).toHaveLength(afterFinal);
    expect(seen.ended).toHaveLength(1);
  });

  it('leaves the composer editable during dictation', () => {
    const adapter = createHostDictationAdapter({ onError: () => {} });
    expect(adapter.disableInputDuringDictation).toBe(false);
  });

  describe('describeDictationError', () => {
    it('rewrites permission failures into an actionable instruction', () => {
      expect(describeDictationError('mic-denied', 'x')).toMatch(/Privacy & Security › Microphone/);
      expect(describeDictationError('speech-denied', 'x')).toMatch(/Speech Recognition/);
    });

    it('passes unknown codes through unchanged', () => {
      expect(describeDictationError('weird', 'the raw message')).toBe('the raw message');
    });
  });
});
