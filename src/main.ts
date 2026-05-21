import { dialog } from 'electron';

import('./cobuilding/main').catch((error) => {
  console.error('[main.ts] Error importing cobuilding/main:', error);
  dialog.showErrorBox(
    'Academia Coscientist - Startup Error',
    `The application failed to start.\n\n${error instanceof Error ? error.message : String(error)}`,
  );
  throw error;
});
