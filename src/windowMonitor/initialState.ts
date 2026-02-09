import { SystemState } from './types';

export function createInitialState(): SystemState {
  return {
    apps: [],
    focusedAppIdentifier: null,
    focusedAppPid: null,
    lastEventTimestamp: null,
  };
}
