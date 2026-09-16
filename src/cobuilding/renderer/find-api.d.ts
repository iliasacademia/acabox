import type { FindAPI } from '../shared/findInPage';

declare global {
  interface Window {
    findAPI: FindAPI;
  }
}

export {};
