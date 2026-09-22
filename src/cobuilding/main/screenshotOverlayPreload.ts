import { contextBridge, ipcRenderer } from 'electron';
import { SCREENSHOT_IPC, type OverlayGesture, type OverlayInit } from '../shared/screenshot';

// The screenshot sheet's whole surface: learn what it covers, calibrate its
// true origin, report one gesture (in page coordinates — main translates).
contextBridge.exposeInMainWorld('screenshotOverlayAPI', {
  onInit: (callback: (init: OverlayInit) => void) => {
    ipcRenderer.once(SCREENSHOT_IPC.overlayInit, (_event, init: OverlayInit) => callback(init));
  },
  anchor: (x: number, y: number) => {
    ipcRenderer.send(SCREENSHOT_IPC.overlayAnchor, { x, y });
  },
  onOrigin: (callback: (origin: { x: number; y: number }) => void) => {
    ipcRenderer.on(SCREENSHOT_IPC.overlayOrigin, (_event, origin: { x: number; y: number }) => callback(origin));
  },
  done: (gesture: OverlayGesture) => {
    ipcRenderer.send(SCREENSHOT_IPC.overlayDone, gesture);
  },
});
