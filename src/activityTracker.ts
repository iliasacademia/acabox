import { sessionDb } from './sessionDb';
import { createActivityTracker } from './activityTrackerFactory';

export type { ActivityTracker } from './activityTrackerFactory';
export { createActivityTracker } from './activityTrackerFactory';

export const activityTracker = createActivityTracker(sessionDb);
