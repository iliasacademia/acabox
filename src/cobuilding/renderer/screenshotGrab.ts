/**
 * The picker half of screenshot-to-composer. Main calls
 * `window.__acaboxScreenshotGrab` with `executeJavaScript(…, userGesture=true)`
 * after the user clicked or dragged outside Acabox — `getDisplayMedia`
 * requires transient activation, and only a main-supplied gesture still has it
 * by then (see `main/screenshotHost.ts`).
 */
import {
  cropInPickedFrame,
  fitToPixelBudget,
  frameMatchesDisplay,
  type Rect,
  type ScreenshotResult,
} from '../shared/screenshot';

declare global {
  interface Window {
    __acaboxScreenshotGrab?: (args: { crop: Rect | null; displays: Rect[] }) => Promise<ScreenshotResult>;
  }
}

/** Chromium's ImageCapture, absent from TypeScript's DOM lib. */
declare const ImageCapture: {
  new (track: MediaStreamTrack): { grabFrame(): Promise<ImageBitmap> };
};

/**
 * Measured: the first ~17 frames arrive at a thumbnail size (556 px wide for a
 * 3456 px display) before full-resolution frames start ~30 ms in, and the
 * picker's own bar is still fading out for a moment after the click. So wait
 * for a full-size frame AND a short settle before keeping one.
 */
const SETTLE_MS = 250;
const MAX_WAIT_MS = 2_000;

async function grabFullFrame(track: MediaStreamTrack): Promise<ImageBitmap> {
  const target = track.getSettings().width ?? 0;
  const capture = new ImageCapture(track);
  const started = Date.now();
  for (;;) {
    const frame = await capture.grabFrame();
    const elapsed = Date.now() - started;
    if ((frame.width >= target && elapsed >= SETTLE_MS) || elapsed >= MAX_WAIT_MS) return frame;
    frame.close();
  }
}

function pickerFailure(err: unknown): ScreenshotResult {
  const name = (err as { name?: string })?.name;
  const message = (err as { message?: string })?.message ?? String(err);
  // Cancel in the picker.
  if (name === 'NotAllowedError') return { ok: false, reason: 'cancelled' };
  // Chromium gives the picker ~10 s before abandoning the request.
  if (name === 'AbortError' && /timeout/i.test(message)) {
    return { ok: false, reason: 'picker-timeout', message: 'The macOS picker closed after 10 seconds. Try again.' };
  }
  return { ok: false, reason: 'error', message };
}

async function grab({ crop, displays }: { crop: Rect | null; displays: Rect[] }): Promise<ScreenshotResult> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (err) {
    return pickerFailure(err);
  }
  try {
    const frame = await grabFullFrame(stream.getVideoTracks()[0]);
    const matchesDisplay = displays.some((d) => frameMatchesDisplay(d, frame.width, frame.height));
    // `displaySurface` reads "window" even for a whole screen in this picker
    // (measured), so the frame's shape is what says what was picked.
    const region = (crop && cropInPickedFrame(crop, displays, frame.width, frame.height)) ?? {
      x: 0, y: 0, width: frame.width, height: frame.height,
    };
    const out = fitToPixelBudget(region.width, region.height);
    const canvas = document.createElement('canvas');
    canvas.width = out.width;
    canvas.height = out.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D canvas');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(frame, region.x, region.y, region.width, region.height, 0, 0, out.width, out.height);
    frame.close();
    const base64 = canvas.toDataURL('image/png').split(',')[1] ?? '';
    return { ok: true, base64, width: out.width, height: out.height, source: matchesDisplay ? 'screen' : 'window' };
  } catch (err) {
    return { ok: false, reason: 'error', message: err instanceof Error ? err.message : String(err) };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

export function installScreenshotGrab(): void {
  window.__acaboxScreenshotGrab = grab;
}
