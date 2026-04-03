import { app } from 'electron';

const useCobuilding = process.env.ENTRY_POINT === 'cobuilding' || app.getVersion().includes('-cobuild');

if (useCobuilding) {
  import('./cobuilding/main');
} else {
  import('./writingAgentMain');
}
