// FullStory is not bundled in the slim build. These no-ops keep the call sites
// intact so we don't have to thread a feature flag through the renderer.

export function initFullStory(_isPackaged: boolean | undefined): void {
  // no-op
}

export function identifyUser(
  _userId: string | number | undefined,
  _email: string | undefined,
  _displayName: string | undefined,
  _deviceId: string | undefined,
  _appVersion: string | undefined,
): void {
  // no-op
}

export function trackEvent(_name: string, _properties?: Record<string, unknown>): void {
  // no-op
}
