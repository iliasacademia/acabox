import type { HostApp } from './types';

export type { HostApp, ApplyEditParams, ApplyEditResult, PreToolUseHook, MessagePrefixContext } from './types';

export type IntegrationId = 'word' | 'obsidian' | 'apple-notes' | 'google-docs';

export function setHostAppRegistrationOverrides(_overrides: Partial<Record<IntegrationId, boolean>>): void {
  // No host apps are registered in the slim build.
}

export function getRegisteredHostApps(): HostApp[] {
  return [];
}

export function findHostAppForDocument(_documentPath: string | null | undefined): HostApp | null {
  return null;
}

export function findHostAppByBundleId(_bundleId: string | null | undefined): HostApp | null {
  return null;
}
