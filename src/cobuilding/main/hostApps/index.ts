import * as path from 'path';
import { FEATURES } from '../../../shared/types';
import type { HostApp } from './types';
import { wordHostApp } from './wordHostApp';
import { obsidianHostApp } from './obsidianHostApp';

export type { HostApp, ApplyEditParams, ApplyEditResult, PreToolUseHook, MessagePrefixContext } from './types';

export type IntegrationId = 'word' | 'obsidian';

/**
 * Runtime overrides for which host apps are registered. Set at startup by the
 * main process from the user's Settings (electron-store). When unset for a host,
 * we fall back to the build-time FEATURES flag.
 *
 * This is what makes the Settings "Word Integration" / "Obsidian Integration"
 * toggles take effect without requiring a code rebuild — flip the value in the
 * store, restart, and the override drives `getRegisteredHostApps()`.
 */
let registrationOverrides: Partial<Record<IntegrationId, boolean>> = {};

export function setHostAppRegistrationOverrides(overrides: Partial<Record<IntegrationId, boolean>>): void {
  registrationOverrides = { ...overrides };
}

/**
 * Returns the host apps that are currently registered (active).
 *
 * Resolution order: runtime overrides (from Settings) > build-time FEATURES flags.
 */
export function getRegisteredHostApps(): HostApp[] {
  const apps: HostApp[] = [];
  const wordEnabled = registrationOverrides.word ?? FEATURES.MS_WORD_INTEGRATION_ENABLED;
  const obsidianEnabled = registrationOverrides.obsidian ?? FEATURES.OBSIDIAN_INTEGRATION_ENABLED;
  if (wordEnabled) apps.push(wordHostApp);
  if (obsidianEnabled) apps.push(obsidianHostApp);
  return apps;
}

/** Look up the host app that owns a given document path by file extension. */
export function findHostAppForDocument(documentPath: string | null | undefined): HostApp | null {
  if (!documentPath) return null;
  const ext = path.extname(documentPath).toLowerCase();
  if (!ext) return null;
  return getRegisteredHostApps().find((h) => h.fileExtensions.includes(ext)) ?? null;
}

/** Look up a host app by its bundle ID. */
export function findHostAppByBundleId(bundleId: string | null | undefined): HostApp | null {
  if (!bundleId) return null;
  return getRegisteredHostApps().find((h) => h.bundleId === bundleId) ?? null;
}
