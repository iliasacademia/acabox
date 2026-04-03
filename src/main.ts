import { app, dialog } from 'electron';

const useCobuilding = process.env.ENTRY_POINT === 'cobuilding' || app.getVersion().includes('-cobuild');

// Added error handling to the import statements, was previously silently failing and hard to debug
if (useCobuilding) {
  import('./cobuilding/main').catch((error) => {
    console.error('[main.ts] Error importing cobuilding/main:', error);
    dialog.showErrorBox(
      'Academia Coscientist - Startup Error',
      `The application failed to start.\n\n${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  });
} else {
  import('./writingAgentMain').catch((error) => {
    console.error('[main.ts] Error importing writingAgentMain:', error);
    dialog.showErrorBox(
      'Writing Agent - Startup Error',
      `The application failed to start.\n\n${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  });
}
