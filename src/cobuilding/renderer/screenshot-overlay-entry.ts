/**
 * The screenshot sheet: one transparent, always-on-top window per display.
 * It never reads the screen — it only reports where the user clicked or
 * dragged, in PAGE coordinates, and main translates and decides how to capture
 * (see `shared/screenshot.ts` for why the page cannot translate itself).
 */
import './screenshot-overlay.css';
import { gestureFromPointer, type OverlayGesture, type OverlayInit } from '../shared/screenshot';

declare global {
  interface Window {
    screenshotOverlayAPI: {
      onInit: (cb: (init: OverlayInit) => void) => void;
      anchor: (x: number, y: number) => void;
      onOrigin: (cb: (origin: { x: number; y: number }) => void) => void;
      done: (gesture: OverlayGesture) => void;
    };
  }
}

const box = document.getElementById('box') as HTMLDivElement;
const size = document.getElementById('size') as HTMLSpanElement;
const acaboxEl = document.getElementById('acabox') as HTMLDivElement;
const hint = document.getElementById('hint') as HTMLDivElement;

let start: { x: number; y: number } | null = null;
let sent = false;
let acabox: OverlayInit['acabox'] = null;
let calibrated = false;

const send = (gesture: OverlayGesture) => {
  if (sent) return;
  sent = true;
  window.screenshotOverlayAPI.done(gesture);
};

/** Outline where a capture is instant, so the two routes are visible before
 *  the user commits to one. Redrawn once main reports the true origin. */
const placeAcabox = (origin: { x: number; y: number }) => {
  if (!acabox) return;
  const left = acabox.x - origin.x;
  const top = acabox.y - origin.y;
  const visible = left < innerWidth && top < innerHeight && left + acabox.width > 0 && top + acabox.height > 0;
  Object.assign(acaboxEl.style, {
    left: `${left}px`, top: `${top}px`, width: `${acabox.width}px`, height: `${acabox.height}px`,
  });
  acaboxEl.hidden = !visible;
};

window.screenshotOverlayAPI.onInit((init) => {
  acabox = init.acabox;
  placeAcabox({ x: init.display.x, y: init.display.y });
});
window.screenshotOverlayAPI.onOrigin(placeAcabox);

const draw = (x: number, y: number) => {
  if (!start) return;
  const left = Math.min(start.x, x);
  const top = Math.min(start.y, y);
  const w = Math.abs(x - start.x);
  const h = Math.abs(y - start.y);
  Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
  size.textContent = `${Math.round(w)} × ${Math.round(h)}`;
  box.hidden = false;
};

window.addEventListener('pointerdown', (e) => {
  if (e.button === 2) { send({ kind: 'cancel' }); return; }
  if (e.button !== 0) return;
  // Re-anchor at the press: the cursor is still here, so this is the most
  // accurate moment to measure the sheet's true origin.
  window.screenshotOverlayAPI.anchor(e.clientX, e.clientY);
  calibrated = true;
  start = { x: e.clientX, y: e.clientY };
  hint.hidden = true;
  (e.target as Element).setPointerCapture?.(e.pointerId);
});

window.addEventListener('pointermove', (e) => {
  if (!calibrated) {
    calibrated = true;
    window.screenshotOverlayAPI.anchor(e.clientX, e.clientY);
  }
  draw(e.clientX, e.clientY);
});

window.addEventListener('pointerup', (e) => {
  if (!start || e.button !== 0) return;
  send(gestureFromPointer(start.x, start.y, e.clientX, e.clientY));
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') send({ kind: 'cancel' });
});
window.addEventListener('contextmenu', (e) => e.preventDefault());
