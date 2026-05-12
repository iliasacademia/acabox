/**
 * Checks macOS Accessibility permission and starts the window monitor
 * on demand. If permission is missing, opens System Settings (which
 * shows the native permission dialog) and returns false.
 */
export async function ensureAccessibilityPermission(): Promise<boolean> {
  try {
    const result: any = await window.electronAPI.invoke('overlay:ensureReady');
    return !!result?.hasPermission;
  } catch {
    return true;
  }
}
