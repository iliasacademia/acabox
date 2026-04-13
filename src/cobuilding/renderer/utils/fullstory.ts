import { FullStory, init } from '@fullstory/browser';

let isInitialized = false;

export function initFullStory(): void {
  if (isInitialized) return;

  try {
    init({
      orgId: '17I9',
      devMode: process.env.NODE_ENV !== 'production',
    });

    isInitialized = true;
  } catch (error) {
    console.error('[FullStory] Failed to initialize:', error);
  }
}

export function trackEvent(eventName: string, properties?: Record<string, unknown>): void {
  if (!isInitialized) return;

  try {
    FullStory('trackEvent', {
      name: eventName,
      properties: properties || {},
    });
  } catch (error) {
    console.error('[FullStory] Failed to track event:', error);
  }
}
