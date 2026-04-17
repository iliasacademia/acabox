import * as ort from 'onnxruntime-node';
import * as path from 'path';
import { app } from 'electron';
import log from 'electron-log';

export const SILERO_CHUNK_SAMPLES = 512;
const SAMPLE_RATE = 16000;
const SPEECH_THRESHOLD = 0.5;
// Number of consecutive non-speech frames before we consider speech ended
const SILENCE_FRAMES_TO_END = 12; // ~384ms

function getModelPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'silero_vad.onnx');
  }
  // In dev, __dirname is .webpack/main — two levels up reaches project root
  return path.join(__dirname, '../../src/cobuilding/assets/silero_vad.onnx');
}

export class SileroVAD {
  private session: ort.InferenceSession | null = null;
  private h: ort.Tensor;
  private c: ort.Tensor;

  constructor() {
    this.h = new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]);
    this.c = new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]);
  }

  async init(): Promise<void> {
    const modelPath = getModelPath();
    this.session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
    });
    log.info('[SileroVAD] Model loaded from', modelPath);
  }

  async process(samples: Float32Array): Promise<number> {
    if (!this.session) throw new Error('SileroVAD not initialized');

    const input = new ort.Tensor('float32', samples, [1, samples.length]);
    const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), [1]);

    const feeds = { input, h: this.h, c: this.c, sr };
    const results = await this.session.run(feeds);

    this.h = results['hn'];
    this.c = results['cn'];

    return (results['output'].data as Float32Array)[0];
  }

  reset(): void {
    this.h = new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]);
    this.c = new ort.Tensor('float32', new Float32Array(2 * 1 * 64), [2, 1, 64]);
  }
}

/** Stateful VAD that buffers speech and fires a callback when an utterance ends. */
export class SpeechSegmenter {
  private vad = new SileroVAD();
  private buffer: Float32Array[] = [];
  private isSpeaking = false;
  private silenceFrames = 0;
  private initPromise: Promise<void> | null = null;

  constructor(
    private onSpeechEnd: (audio: Float32Array) => void,
    private onSpeechStart?: () => void,
  ) {}

  init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.vad.init();
    return this.initPromise;
  }

  async processChunk(samples: Float32Array): Promise<void> {
    await this.init();

    const prob = await this.vad.process(samples);

    if (prob >= SPEECH_THRESHOLD) {
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.silenceFrames = 0;
        this.onSpeechStart?.();
      }
      this.buffer.push(samples);
      this.silenceFrames = 0;
    } else if (this.isSpeaking) {
      this.buffer.push(samples); // include trailing silence for natural endings
      this.silenceFrames++;

      if (this.silenceFrames >= SILENCE_FRAMES_TO_END) {
        this.flush();
      }
    }
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const totalLen = this.buffer.reduce((s, c) => s + c.length, 0);
    const merged = new Float32Array(totalLen);
    let offset = 0;
    for (const chunk of this.buffer) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.buffer = [];
    this.isSpeaking = false;
    this.silenceFrames = 0;
    this.vad.reset();
    this.onSpeechEnd(merged);
  }

  reset(): void {
    this.buffer = [];
    this.isSpeaking = false;
    this.silenceFrames = 0;
    this.vad.reset();
  }
}
