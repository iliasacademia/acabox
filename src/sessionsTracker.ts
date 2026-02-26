import { sessionDb } from './sessionDb';
import { createSessionsTracker } from './sessionsTrackerFactory';

export type { SessionsTracker } from './sessionsTrackerFactory';
export { createSessionsTracker } from './sessionsTrackerFactory';

export const sessionsTracker = createSessionsTracker(sessionDb);
