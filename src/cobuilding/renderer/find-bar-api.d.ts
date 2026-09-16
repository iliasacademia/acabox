import type { FindBarAPI } from '../shared/findInPage';

declare global {
  interface Window {
    findBarAPI: FindBarAPI;
  }
}

export {};
