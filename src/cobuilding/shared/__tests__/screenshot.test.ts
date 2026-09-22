import {
  MAX_SCREENSHOT_PIXELS,
  cropInPickedFrame,
  fitToPixelBudget,
  gestureFromPointer,
  planCapture,
  screenshotFileName,
  translateGesture,
  type Rect,
} from '../screenshot';

// Geometry of the machine this was measured on: a 1728x1117-pt Retina laptop
// (3456x2234 px) with a 2560x1080 ultrawide to its right.
const LAPTOP: Rect = { x: 0, y: 0, width: 1728, height: 1117 };
const WIDE: Rect = { x: 1728, y: 0, width: 2560, height: 1080 };
const ACABOX: Rect = { x: 100, y: 80, width: 1200, height: 800 };

describe('gestureFromPointer', () => {
  it('reads a drag as a box, whichever corner it started from', () => {
    expect(gestureFromPointer(300, 400, 200, 250)).toEqual({
      kind: 'drag',
      rect: { x: 200, y: 250, width: 100, height: 150 },
    });
  });

  it('reads a wobble under the threshold as a click at the release point', () => {
    expect(gestureFromPointer(200, 200, 204, 260)).toEqual({ kind: 'click', x: 204, y: 260 });
  });
});

describe('translateGesture', () => {
  // The measured case: the sheet was asked for y=33 and the window server put
  // it at y=80, so page coordinates are 80 short of the screen.
  it('moves a click and a drag from page coordinates to screen DIPs', () => {
    expect(translateGesture({ kind: 'click', x: 864, y: 220 }, 0, 80)).toEqual({ kind: 'click', x: 864, y: 300 });
    expect(translateGesture({ kind: 'drag', rect: { x: 10, y: 20, width: 30, height: 40 } }, -395, -1080)).toEqual({
      kind: 'drag',
      rect: { x: -385, y: -1060, width: 30, height: 40 },
    });
  });

  it('leaves a cancel alone', () => {
    expect(translateGesture({ kind: 'cancel' }, 5, 5)).toEqual({ kind: 'cancel' });
  });
});

describe('planCapture', () => {
  it('captures the whole Acabox window on a click inside it', () => {
    expect(planCapture({ kind: 'click', x: 500, y: 500 }, ACABOX)).toEqual({ route: 'acabox' });
  });

  it('crops our own page, relative to its content area, for a box inside Acabox', () => {
    expect(planCapture({ kind: 'drag', rect: { x: 150, y: 100, width: 300, height: 200 } }, ACABOX)).toEqual({
      route: 'acabox',
      crop: { x: 50, y: 20, width: 300, height: 200 },
    });
  });

  it('sends a click outside Acabox to the picker, uncropped', () => {
    expect(planCapture({ kind: 'click', x: 1500, y: 50 }, ACABOX)).toEqual({ route: 'picker' });
  });

  it('sends a box that reaches outside Acabox to the picker whole, not clipped to our part', () => {
    const rect = { x: 1000, y: 100, width: 600, height: 200 };
    expect(planCapture({ kind: 'drag', rect }, ACABOX)).toEqual({ route: 'picker', crop: rect });
  });

  it('routes everything to the picker when Acabox is hidden or minimized', () => {
    expect(planCapture({ kind: 'click', x: 500, y: 500 }, null)).toEqual({ route: 'picker' });
  });

  it('passes a cancel straight through', () => {
    expect(planCapture({ kind: 'cancel' }, ACABOX)).toEqual({ route: 'cancel' });
  });
});

describe('fitToPixelBudget', () => {
  it('leaves an image inside the budget untouched', () => {
    expect(fitToPixelBudget(1600, 1000)).toEqual({ width: 1600, height: 1000 });
  });

  it('shrinks a full Retina capture under the budget, keeping its shape', () => {
    const out = fitToPixelBudget(3456, 2234);
    expect(out.width * out.height).toBeLessThanOrEqual(MAX_SCREENSHOT_PIXELS);
    expect(out.width / out.height).toBeCloseTo(3456 / 2234, 2);
  });
});

describe('cropInPickedFrame', () => {
  const displays = [LAPTOP, WIDE];

  it('maps a box on the laptop into a full-resolution frame of the laptop', () => {
    expect(cropInPickedFrame({ x: 100, y: 50, width: 400, height: 300 }, displays, 3456, 2234)).toEqual({
      x: 200, y: 100, width: 800, height: 600,
    });
  });

  it('maps a box on the second display using that display\'s origin', () => {
    expect(cropInPickedFrame({ x: 1828, y: 100, width: 200, height: 100 }, displays, 2560, 1080)).toEqual({
      x: 100, y: 100, width: 200, height: 100,
    });
  });

  it('refuses to crop when the picked frame is a different display from the one drawn on', () => {
    // Drawn on the ultrawide, but "Share Entire Screen" returned the laptop.
    expect(cropInPickedFrame({ x: 1828, y: 100, width: 200, height: 100 }, displays, 3456, 2234)).toBeNull();
  });

  it('refuses to crop when a window was picked instead of a screen', () => {
    expect(cropInPickedFrame({ x: 100, y: 50, width: 400, height: 300 }, displays, 1400, 900)).toBeNull();
  });

  it('refuses a box that straddles two displays', () => {
    expect(cropInPickedFrame({ x: 1600, y: 50, width: 400, height: 300 }, displays, 3456, 2234)).toBeNull();
  });

  it('never returns a crop running past the frame edge', () => {
    const c = cropInPickedFrame({ x: 1700, y: 1100, width: 28, height: 17 }, displays, 3456, 2234)!;
    expect(c.x + c.width).toBeLessThanOrEqual(3456);
    expect(c.y + c.height).toBeLessThanOrEqual(2234);
  });
});

describe('screenshotFileName', () => {
  const at = new Date(2026, 8, 22, 15, 4, 11);

  it('follows macOS naming', () => {
    expect(screenshotFileName(at)).toBe('Screenshot 2026-09-22 at 15.04.11.png');
  });

  it('numbers a second capture in the same second, so attachment ids never collide', () => {
    expect(screenshotFileName(at, 1)).toBe('Screenshot 2026-09-22 at 15.04.11 (2).png');
  });
});
