/**
 * Screenshot-to-composer: the pure half. Electron-free so it runs under jest;
 * `main/screenshotHost.ts` and `renderer/screenshotGrab.ts` are the glue.
 *
 * THE GESTURE. The composer's screenshot button lays a clear sheet over every
 * display (crosshair cursor, like ⌘⇧4). What the user does on it decides the
 * route:
 *
 *   - Drag a box inside Acabox  -> that area, captured from our own page.
 *   - Click inside Acabox       -> the whole Acabox window.
 *   - Drag a box anywhere else  -> the macOS picker; the user clicks "Share
 *                                  Entire Screen" and we crop to the box.
 *   - Click anywhere else       -> the macOS picker; the user picks a window.
 *
 * WHY THE PICKER, not a direct capture: capturing another app's pixels
 * directly needs Screen Recording permission, and TCC keys that grant to a
 * code signature — ours is ad-hoc and changes with every release, so the grant
 * would lapse at every update. The system picker (ScreenCaptureKit's
 * SCContentSharingPicker, Electron's `useSystemPicker`) needs no permission:
 * the click in the picker IS the consent. Measured 2026-09-22 on macOS 26.7
 * with a fresh bundle id launched through LaunchServices:
 * `getMediaAccessStatus('screen') === 'denied'` before and after, and a full
 * 3456x2234 frame of real screen content came back. The sheet itself needs no
 * permission either: it draws over other apps but never reads them.
 *
 * All coordinates here are global screen DIPs (Electron's `screen` space)
 * unless named `...Px`.
 */

export const SCREENSHOT_IPC = {
  /** Renderer -> main (invoke): run the whole gesture, resolve with the image. */
  capture: 'screenshot:capture',
  /** Overlay -> main (send): the gesture finished. */
  overlayDone: 'screenshot:overlay-done',
  /** Main -> overlay (send): what this overlay covers. */
  overlayInit: 'screenshot:overlay-init',
  /** Overlay -> main (send): a pointer position in page coordinates, to calibrate against. */
  overlayAnchor: 'screenshot:overlay-anchor',
  /** Main -> overlay (send): the sheet's true top-left in screen DIPs. */
  overlayOrigin: 'screenshot:overlay-origin',
} as const;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * What the user did on the sheet. The overlay reports it in PAGE coordinates
 * and main translates it with `translateGesture`: the sheet cannot know where
 * its own window really is. Measured 2026-09-22 on macOS 26.7 — a window
 * requested at y=33 was placed at y=80 by the window server while both
 * Electron's getBounds() and the Accessibility frame still said 33, so a click
 * at y=300 arrived as clientY=220 with screenY=253. Main calibrates against
 * `screen.getCursorScreenPoint()`, which is the OS's own answer.
 */
export type OverlayGesture =
  | { kind: 'cancel' }
  | { kind: 'click'; x: number; y: number }
  | { kind: 'drag'; rect: Rect };

/** Sent to each overlay so it can draw the Acabox outline in its own space. */
export interface OverlayInit {
  /** Where this sheet was asked to go (global DIPs) — a first guess at its
   *  origin until `overlayOrigin` corrects it. */
  display: Rect;
  /** Acabox's content area (global DIPs), for the "instant" outline. */
  acabox: Rect | null;
}

export type CapturePlan =
  | { route: 'cancel' }
  /** `crop` is relative to the Acabox content area; absent = whole window. */
  | { route: 'acabox'; crop?: Rect }
  /** `crop` is the global box to cut out of the picked screen, if any. */
  | { route: 'picker'; crop?: Rect };

export type ScreenshotResult =
  | {
      ok: true;
      /** PNG, base64 without the data: prefix. */
      base64: string;
      width: number;
      height: number;
      source: 'acabox' | 'screen' | 'window';
    }
  | {
      ok: false;
      /** `cancelled` is silent; every other reason is shown to the user. */
      reason: 'cancelled' | 'busy' | 'picker-timeout' | 'unsupported' | 'error';
      message?: string;
    };

/** Below this in either dimension a drag is a click: hands wobble. */
export const MIN_DRAG_DIP = 6;

/**
 * Pixel budget for an attached screenshot. The API downscales anything larger
 * (to at most ~4784 visual tokens, ≈3.6 MP), so sending more costs transfer
 * and never buys detail — and a raw Retina capture of a big display is past
 * the image adapter's 7 MB inline ceiling, which would turn it into a file
 * path the agent has to Read. Capping here keeps every capture an inline
 * image at exactly the cost a hand-attached screenshot would have.
 */
export const MAX_SCREENSHOT_PIXELS = 3_500_000;

export function normalizeRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

/** A pointer-down/up pair as a gesture: tiny drags read as clicks. */
export function gestureFromPointer(x1: number, y1: number, x2: number, y2: number): OverlayGesture {
  const rect = normalizeRect(x1, y1, x2, y2);
  if (rect.width < MIN_DRAG_DIP || rect.height < MIN_DRAG_DIP) {
    return { kind: 'click', x: x2, y: y2 };
  }
  return { kind: 'drag', rect };
}

/** Shift a page-coordinate gesture to screen DIPs. */
export function translateGesture(gesture: OverlayGesture, dx: number, dy: number): OverlayGesture {
  if (gesture.kind === 'click') return { kind: 'click', x: gesture.x + dx, y: gesture.y + dy };
  if (gesture.kind === 'drag') {
    return { kind: 'drag', rect: { ...gesture.rect, x: gesture.rect.x + dx, y: gesture.rect.y + dy } };
  }
  return gesture;
}

export function containsPoint(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
}

export function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * Route a gesture. A box that reaches even partly outside Acabox needs pixels
 * we cannot read ourselves, so it goes to the picker whole — cropping it to
 * the Acabox part would silently drop what the user drew.
 */
export function planCapture(gesture: OverlayGesture, acabox: Rect | null): CapturePlan {
  if (gesture.kind === 'cancel') return { route: 'cancel' };
  if (gesture.kind === 'click') {
    return acabox && containsPoint(acabox, gesture.x, gesture.y)
      ? { route: 'acabox' }
      : { route: 'picker' };
  }
  if (acabox && containsRect(acabox, gesture.rect)) {
    return {
      route: 'acabox',
      crop: {
        x: gesture.rect.x - acabox.x,
        y: gesture.rect.y - acabox.y,
        width: gesture.rect.width,
        height: gesture.rect.height,
      },
    };
  }
  return { route: 'picker', crop: gesture.rect };
}

/** Largest integer size with the same aspect that fits the pixel budget. */
export function fitToPixelBudget(
  width: number,
  height: number,
  maxPixels: number = MAX_SCREENSHOT_PIXELS,
): { width: number; height: number } {
  if (width * height <= maxPixels) return { width, height };
  const scale = Math.sqrt(maxPixels / (width * height));
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

/**
 * Whether a picked frame is a whole display. A screen frame has the display's
 * shape exactly (3456x2234 for 1728x1117 pt), so the tolerance only absorbs
 * rounding; at 1% a 1400x900 window read as the laptop screen.
 */
export function frameMatchesDisplay(display: Rect, frameWidth: number, frameHeight: number): boolean {
  if (frameWidth <= 0 || frameHeight <= 0 || display.width <= 0 || display.height <= 0) return false;
  const displayAspect = display.width / display.height;
  return Math.abs(frameWidth / frameHeight - displayAspect) / displayAspect <= 0.002;
}

/**
 * Where the user's box sits inside a frame the picker returned, in frame
 * pixels — or null when the box cannot be located in it, in which case the
 * caller attaches the whole frame rather than a guessed crop.
 *
 * Null when: the frame's aspect does not match any display holding the box
 * (the user picked a window, or on a multi-display setup "Share Entire Screen"
 * chose a different display from the one they drew on), or the box is not
 * wholly on one display.
 */
export function cropInPickedFrame(
  box: Rect,
  displays: readonly Rect[],
  frameWidth: number,
  frameHeight: number,
): Rect | null {
  const display = displays.find((d) => containsRect(d, box));
  if (!display || !frameMatchesDisplay(display, frameWidth, frameHeight)) return null;
  const scale = frameWidth / display.width;
  const x = Math.round((box.x - display.x) * scale);
  const y = Math.round((box.y - display.y) * scale);
  return {
    x,
    y,
    width: Math.min(frameWidth - x, Math.round(box.width * scale)),
    height: Math.min(frameHeight - y, Math.round(box.height * scale)),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * macOS's own naming ("Screenshot 2026-09-22 at 15.04.11.png"), plus a counter
 * when two land in one second — the image adapter uses the file name as the
 * attachment id, so a repeat would collide with the first.
 */
export function screenshotFileName(date: Date, sameSecondIndex = 0): string {
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` at ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
  return sameSecondIndex > 0 ? `Screenshot ${stamp} (${sameSecondIndex + 1}).png` : `Screenshot ${stamp}.png`;
}
