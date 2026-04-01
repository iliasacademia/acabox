import Store from 'electron-store';
import { app } from 'electron';

export const store = new Store({
  name: app.isPackaged ? 'config' : 'config-dev',
});
