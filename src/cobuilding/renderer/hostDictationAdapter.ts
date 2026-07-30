import type { DictationAdapter } from '@assistant-ui/react';

/**
 * assistant-ui `DictationAdapter` backed by Acabox's on-device Swift helper
 * (`main/dictationService.ts` → `src/cobuilding/swift/dictation-mac`).
 *
 * assistant-ui ships `WebSpeechDictationAdapter`, and it is deliberately NOT
 * used: it drives Chromium's Web Speech API, which cannot work here. Electron
 * bundles no SODA models, so the on-device path is absent, and the remaining
 * path uploads the microphone to Google — unacceptable for an app built around
 * research data staying on the machine. Same interface, local implementation.
 *
 * Registering this adapter is also what makes `ComposerPrimitive.Dictate`
 * render: with no dictation adapter the primitive's hook returns null and the
 * button disables itself, which is exactly the behaviour we want on a machine
 * where the helper didn't build.
 *
 * ## Transcript semantics
 *
 * The helper emits `partial` events carrying the WHOLE utterance so far, not a
 * delta — later words revise earlier ones as the recognizer gains context.
 * That lines up with assistant-ui's interim model (an interim result replaces
 * the tail after the base text), so partials map to `isFinal: false` and the
 * one closing `final` maps to `isFinal: true`, which the runtime commits.
 * Text the user had already typed is preserved by the runtime, which snapshots
 * it as the base before the session starts — this adapter must never touch it.
 */

type Listener = () => void;
type ResultListener = (result: DictationAdapter.Result) => void;

/** Errors the user can act on; anything else gets the helper's own message. */
const ERROR_COPY: Record<string, string> = {
  'mic-denied':
    'Microphone access is off. Turn it on in System Settings › Privacy & Security › Microphone.',
  'speech-denied':
    'Speech recognition access is off. Turn it on in System Settings › Privacy & Security › Speech Recognition.',
  'no-input-device': 'No microphone was found.',
  'locale-unsupported': 'Dictation is not available for this language.',
};

export function describeDictationError(code: string, message: string): string {
  return ERROR_COPY[code] ?? message;
}

class HostDictationSession implements DictationAdapter.Session {
  status: DictationAdapter.Status = { type: 'starting' };

  private speechListeners = new Set<ResultListener>();
  private startListeners = new Set<Listener>();
  private endListeners = new Set<ResultListener>();
  private unsubscribeEvents: () => void;

  /** Resolves the `stop()` promise once the helper reports the final text. */
  private resolveStop: (() => void) | null = null;
  private lastTranscript = '';
  private finished = false;

  constructor(
    private readonly locale: string,
    private readonly onError: (message: string) => void,
  ) {
    this.unsubscribeEvents = window.dictationAPI.onEvent((event) => this.handle(event));

    void window.dictationAPI.start(locale).then((result) => {
      if (!result.ok) {
        this.onError(result.error ?? 'Dictation could not start.');
        this.finish('error');
      }
    });
  }

  private handle(event: DictationEvent): void {
    switch (event.type) {
      case 'listening':
        this.status = { type: 'running' };
        for (const listener of this.startListeners) listener();
        break;

      case 'partial':
        this.lastTranscript = event.text;
        this.emitSpeech(event.text, false);
        break;

      case 'final':
        // Commit before ending: the runtime treats onSpeechEnd as "session
        // over" and tears down, so a final transcript delivered after it would
        // be dropped and the user would watch their words vanish.
        this.lastTranscript = event.text;
        if (event.text) this.emitSpeech(event.text, true);
        this.finish('stopped');
        break;

      case 'stopped':
        // Reached without a `final` only when the helper died mid-dictation.
        this.finish('stopped');
        break;

      case 'error':
        this.onError(describeDictationError(event.code, event.message));
        this.finish('error');
        break;

      // 'hello' / 'ready' / 'level' / 'installing' / 'installed' are surfaced
      // by useDictationStatus for the UI, not needed for the transcript.
      default:
        break;
    }
  }

  private emitSpeech(transcript: string, isFinal: boolean): void {
    for (const listener of this.speechListeners) listener({ transcript, isFinal });
  }

  private finish(reason: 'stopped' | 'cancelled' | 'error'): void {
    if (this.finished) return;
    this.finished = true;
    this.status = { type: 'ended', reason };

    this.resolveStop?.();
    this.resolveStop = null;

    for (const listener of this.endListeners) {
      listener({ transcript: this.lastTranscript, isFinal: true });
    }

    this.unsubscribeEvents();
    this.speechListeners.clear();
    this.startListeners.clear();
    this.endListeners.clear();
  }

  async stop(): Promise<void> {
    if (this.finished) return;
    await window.dictationAPI.stop();
    // Wait for the helper's `final`, which carries the tail of the utterance —
    // resolving immediately would cut the last word or two.
    await new Promise<void>((resolve) => {
      this.resolveStop = resolve;
      // The helper always answers, but a crashed one never will, and a promise
      // that never settles would wedge the composer in "recording" forever.
      setTimeout(() => {
        if (!this.finished) this.finish('stopped');
        else resolve();
      }, 3000);
    });
  }

  cancel(): void {
    void window.dictationAPI.stop();
    this.finish('cancelled');
  }

  onSpeechStart(callback: Listener): () => void {
    this.startListeners.add(callback);
    return () => this.startListeners.delete(callback);
  }

  onSpeechEnd(callback: ResultListener): () => void {
    this.endListeners.add(callback);
    return () => this.endListeners.delete(callback);
  }

  onSpeech(callback: ResultListener): () => void {
    this.speechListeners.add(callback);
    return () => this.speechListeners.delete(callback);
  }
}

export function createHostDictationAdapter(options: {
  locale?: string;
  onError: (message: string) => void;
}): DictationAdapter {
  return {
    listen: () => new HostDictationSession(options.locale ?? 'en-US', options.onError),
    // Leave the textarea editable while dictating. Recognition revises the tail
    // as you speak, so a stray keystroke can land mid-revision — but blocking
    // input would also block the far more common case of fixing a misheard word
    // without stopping first, and the user can always stop and edit.
    disableInputDuringDictation: false,
  };
}
