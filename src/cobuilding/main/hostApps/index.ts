import * as path from 'path';
import { FEATURES } from '../../../shared/types';
import type { HostApp } from './types';
import { wordHostApp } from './wordHostApp';
import { obsidianHostApp } from './obsidianHostApp';

export type { HostApp, ApplyEditParams, ApplyEditResult, PreToolUseHook, MessagePrefixContext } from './types';

/**
 * Returns the host apps that are currently registered (active).
 *
 * Today this is gated on the build-time FEATURES flags. When the per-integration
 * Settings toggles land (M2), this function consults the runtime settings store
 * instead so the user can enable/disable each integration without restarting.
 */
export function getRegisteredHostApps(): HostApp[] {
  const apps: HostApp[] = [];
  if (FEATURES.MS_WORD_INTEGRATION_ENABLED) apps.push(wordHostApp);
  if (FEATURES.OBSIDIAN_INTEGRATION_ENABLED) apps.push(obsidianHostApp);
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
